"""
Account linkage (Phase 2a): edge detectors, clustering thresholds, the nightly
recompute, the payout policies and the staff endpoints.
"""

import json
from datetime import datetime, timedelta
from datetime import timezone as dt_timezone
from decimal import Decimal
from itertools import count

from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.test import TestCase
from django.utils import timezone
from rest_framework.test import APITestCase

from apps.admin_api.models import AuditLog
from apps.challenges.models import Challenge, HeldPayout, Participant
from apps.challenges.payout_holds import forfeit_plan
from apps.challenges.services import finalize_challenge
from apps.linkage import detectors
from apps.linkage.graph import clusters, pair_edges, summarize_pair
from apps.linkage.models import (HouseholdMark, LinkageRun, LinkageSettings, LinkCluster,
                                 LinkClusterMember, LinkEdge)
from apps.linkage.store import local_today, rebuild_clusters, recompute_linkage
from apps.payments.models import PaymentTransaction, WithdrawalRequest
from apps.steps.models import DeviceRegistration, HealthRecord, HourlyStepRecord, LocationWaypoint
from apps.users.models import DeviceSession
from apps.wallet.models import WalletTransaction

User = get_user_model()
START = Decimal("5000.00")
_seq = count(1)


class LinkFixture:
    def mk(self, name, phone=None, joined=None, **extra):
        n = next(_seq)
        u = User.objects.create_user(
            username=name, email=f"{name}@example.com", password="x-Pass-123!",
            # Spaced numbers: no accidental near-sequential links between fixtures.
            phone_number=phone or f"2547{n * 1000 % 10**8:08d}", wallet_balance=START, **extra)
        if joined:
            User.objects.filter(pk=u.pk).update(date_joined=joined)
            u.refresh_from_db()
        return u

    def device(self, user, dev="dev-shared-0123456789abcdef0123456789abcdef", platform="android"):
        return DeviceRegistration.objects.create(user=user, device_id=dev, platform=platform)

    def withdraw_to(self, user, phone):
        return WithdrawalRequest.objects.create(user=user, amount_kes=Decimal("100"), method="mpesa",
                                                phone_number=phone)

    def deposit_from(self, user, phone):
        n = next(_seq)
        return PaymentTransaction.objects.create(user=user, type="deposit", amount_kes=Decimal("50"),
                                                 order_id=f"o{n}", tracking_reference=f"t{n}",
                                                 phone_number=phone, narration="d")

    def login(self, user, ip):
        return DeviceSession.objects.create(user=user, refresh_jti=f"jti-{next(_seq)}", ip_address=ip)

    def curve(self, user, day, hours):
        HourlyStepRecord.objects.bulk_create(
            [HourlyStepRecord(user=user, date=day, hour=h, steps=s) for h, s in hours.items()])

    def walk(self, user, day, start_utc, minutes, lat, lon):
        LocationWaypoint.objects.bulk_create([
            LocationWaypoint(user=user, date=day, hour=(start_utc + timedelta(minutes=m)).hour,
                             recorded_at=start_utc + timedelta(minutes=m),
                             latitude=lat + m * 0.00005, longitude=lon, accuracy_m=10)
            for m in range(minutes)])

    def edge_types(self, a, b):
        lo, hi = sorted((a.pk, b.pk))
        return set(LinkEdge.objects.filter(user_a_id=lo, user_b_id=hi, active=True)
                   .values_list("edge_type", flat=True))

    def edge(self, a, b, etype):
        lo, hi = sorted((a.pk, b.pk))
        return LinkEdge.objects.get(user_a_id=lo, user_b_id=hi, edge_type=etype)


# ── detectors ────────────────────────────────────────────────────────────────


class EdgeDetectorTests(LinkFixture, TestCase):
    def setUp(self):
        self.today = local_today()
        self.a = self.mk("amani", "254711000100")
        self.b = self.mk("baraka", "254722000200")

    def run_all(self):
        return recompute_linkage(today=self.today)

    def test_shared_device_is_strong_and_masked(self):
        dev = "device-XYZ-0123456789abcdef0123456789abcdef"
        self.device(self.a, dev)
        self.device(self.b, dev)
        self.run_all()
        e = self.edge(self.a, self.b, LinkEdge.TYPE_SHARED_DEVICE)
        self.assertEqual((e.strength, e.weight), ("strong", 1.0))
        self.assertEqual(e.evidence["device"], "…cdef")
        self.assertNotIn(dev, json.dumps(e.evidence))

    def test_deleted_account_is_ignored(self):
        self.device(self.a)
        self.device(self.b)
        User.objects.filter(pk=self.b.pk).update(deleted_at=timezone.now())
        self.run_all()
        self.assertFalse(LinkEdge.objects.exists())

    def test_withdrawal_to_another_accounts_number_is_strong(self):
        self.withdraw_to(self.b, "0711000100")  # amani's number, another format
        self.run_all()
        e = self.edge(self.a, self.b, LinkEdge.TYPE_SHARED_PAYOUT_ACCOUNT)
        self.assertEqual(e.strength, "strong")
        self.assertEqual(e.evidence["account"], "ending 100")
        self.assertNotIn("711000100", json.dumps(e.evidence))

    def test_shared_deposit_number_only_is_medium(self):
        self.deposit_from(self.a, "254733999888")
        self.deposit_from(self.b, "0733999888")
        self.run_all()
        e = self.edge(self.a, self.b, LinkEdge.TYPE_SHARED_DEPOSIT_NUMBER)
        self.assertEqual((e.strength, e.weight), ("medium", 0.5))
        self.assertNotIn(LinkEdge.TYPE_SHARED_PAYOUT_ACCOUNT, self.edge_types(self.a, self.b))

    def test_near_sequential_numbers_registered_close_in_time_are_weak(self):
        now = timezone.now()
        c = self.mk("chebet", "254799000001", joined=now - timedelta(days=3))
        d = self.mk("dama", "254799000004", joined=now - timedelta(days=1))
        e_ = self.mk("esther", "254799000060", joined=now - timedelta(days=60))  # too far apart in time
        self.run_all()
        e = self.edge(c, d, LinkEdge.TYPE_PHONE_SEQUENCE)
        self.assertEqual((e.strength, e.weight), ("weak", 0.25))
        self.assertEqual(self.edge_types(c, e_), set())

    def test_same_home_network_is_weak_and_public_networks_are_ignored(self):
        self.login(self.a, "41.90.64.10")
        self.login(self.b, "41.90.64.200")
        self.run_all()
        e = self.edge(self.a, self.b, LinkEdge.TYPE_SHARED_NETWORK)
        self.assertEqual((e.strength, e.weight), ("weak", 0.15))
        self.assertNotIn("41.90", json.dumps(e.evidence))
        # Carrier NAT: 8 accounts behind one /24 -> a public network, no edges.
        crowd = [self.mk(f"nat{i}") for i in range(8)]
        for u in crowd:
            self.login(u, "105.160.3.7")
        # Private addresses (a proxy without TRUSTED_PROXY_IPS) link nobody.
        self.login(crowd[0], "10.0.0.5")
        self.login(crowd[1], "10.0.0.6")
        self.run_all()
        self.assertFalse(LinkEdge.objects.filter(user_a__in=crowd, edge_type="shared_network").exists())

    def test_co_location_walks(self):
        day1, day2 = self.today - timedelta(days=1), self.today - timedelta(days=2)
        for day in (day1, day2):
            start = datetime(day.year, day.month, day.day, 5, 0, tzinfo=dt_timezone.utc)
            self.walk(self.a, day, start, 20, -1.2921, 36.8219)
            self.walk(self.b, day, start + timedelta(seconds=20), 20, -1.29212, 36.82192)
        far = self.mk("far")
        start = datetime(day1.year, day1.month, day1.day, 5, 0, tzinfo=dt_timezone.utc)
        self.walk(far, day1, start, 20, -1.3500, 36.9000)  # same time, ~9 km away
        self.run_all()
        e = self.edge(self.a, self.b, LinkEdge.TYPE_CO_LOCATION)
        self.assertEqual((e.strength, e.weight), ("medium", 0.45))
        self.assertEqual(e.evidence["days_together"], 2)
        self.assertNotIn("36.82", json.dumps(e.evidence))
        self.assertEqual(self.edge_types(self.a, far), set())

    def test_group_walk_crowd_is_ignored(self):
        day = self.today - timedelta(days=1)
        start = datetime(day.year, day.month, day.day, 5, 0, tzinfo=dt_timezone.utc)
        walkers = [self.mk(f"club{i}") for i in range(10)]
        for u in walkers:
            self.walk(u, day, start, 30, -1.2921, 36.8219)
        self.run_all()
        self.assertFalse(LinkEdge.objects.filter(edge_type=LinkEdge.TYPE_CO_LOCATION).exists())

    def test_twin_curves(self):
        shape = {7: 1500, 8: 800, 12: 600, 17: 2100, 18: 900}
        for day in (self.today - timedelta(days=1), self.today - timedelta(days=3)):
            self.curve(self.a, day, shape)
            self.curve(self.b, day, {h: s + 5 for h, s in shape.items()})
        self.run_all()
        e = self.edge(self.a, self.b, LinkEdge.TYPE_TWIN_CURVES)
        self.assertEqual((e.strength, e.weight, e.evidence["twin_days"]), ("medium", 0.45, 2))

    def test_joint_challenges(self):
        creator = self.mk("creator")
        for i in range(3):
            ch = Challenge.objects.create(creator=creator, name=f"C{i}", entry_fee=Decimal("50"), milestone=5000,
                                          start_date=self.today - timedelta(days=10),
                                          end_date=self.today - timedelta(days=3), status="completed",
                                          total_pool=Decimal("100"))
            for u in (self.a, self.b):
                Participant.objects.create(challenge=ch, user=u, steps=9000, qualified=True)
        self.run_all()
        e = self.edge(self.a, self.b, LinkEdge.TYPE_JOINT_CHALLENGES)
        self.assertEqual(e.evidence["both_qualified"], 3)
        self.assertEqual(e.weight, 0.4)  # joined within 30 minutes each time

    def test_handover_only_for_pairs_with_other_evidence(self):
        a_hours = {6: 700, 7: 600, 12: 800, 13: 500}
        b_hours = {9: 900, 10: 700, 17: 800}
        stranger = self.mk("stranger")
        for day in (self.today - timedelta(days=1), self.today - timedelta(days=2)):
            self.curve(self.a, day, a_hours)
            self.curve(self.b, day, b_hours)
            self.curve(stranger, day, b_hours)
        self.login(self.a, "41.90.70.1")
        self.login(self.b, "41.90.70.2")  # weak link makes the pair a candidate
        self.run_all()
        e = self.edge(self.a, self.b, LinkEdge.TYPE_HANDOVER)
        self.assertEqual((e.strength, e.evidence["handover_days"]), ("medium", 2))
        self.assertEqual(self.edge_types(self.a, stranger), set())

    def test_handover_day_rules(self):
        a = [0] * 24
        b = [0] * 24
        a[6], a[12], b[9] = 800, 800, 800
        self.assertFalse(detectors.handover_day(a, b))  # b under 1,000 steps
        b[10] = 400
        self.assertTrue(detectors.handover_day(a, b))
        b[12] = 300  # both active in the same hour -> not a handover
        self.assertFalse(detectors.handover_day(a, b))


# ── pair classification and clustering ─────────────────────────────────────


class GraphTests(TestCase):
    def test_thresholds(self):
        self.assertTrue(summarize_pair([("shared_device", "strong", 1.0)])["linked"])
        weak = summarize_pair([("phone_sequence", "weak", 0.25), ("shared_network", "weak", 0.15)])
        self.assertFalse(weak["linked"])
        one_medium = summarize_pair([("twin_curves", "medium", 0.6), ("twin_curves", "medium", 0.6)])
        self.assertFalse(one_medium["linked"])  # a single kind of evidence never links
        two_medium = summarize_pair([("co_location", "medium", 0.6), ("twin_curves", "medium", 0.45)])
        self.assertTrue(two_medium["linked"])
        low = summarize_pair([("co_location", "medium", 0.3), ("twin_curves", "medium", 0.3),
                              ("phone_sequence", "weak", 0.25), ("shared_network", "weak", 0.15)])
        self.assertFalse(low["linked"])  # weak edges don't top medium evidence up
        self.assertTrue(summarize_pair([("co_location", "medium", 0.3), ("twin_curves", "medium", 0.3)],
                                       medium_threshold=0.6)["linked"])

    def test_components_transitive_and_households_excluded(self):
        rows = [(1, 2, "shared_device", "strong", 1.0), (2, 3, "shared_payout_account", "strong", 1.0),
                (4, 5, "phone_sequence", "weak", 0.25), (6, 7, "co_location", "medium", 0.6),
                (6, 7, "twin_curves", "medium", 0.6)]
        comps = clusters(pair_edges(rows))
        self.assertEqual([c["members"] for c in comps], [[1, 2, 3], [6, 7]])
        comps = clusters(pair_edges(rows), households={(1, 2)})
        self.assertEqual([c["members"] for c in comps], [[2, 3], [6, 7]])


# ── nightly recompute ────────────────────────────────────────────────────────


class RecomputeTests(LinkFixture, TestCase):
    def setUp(self):
        self.a, self.b, self.c = self.mk("a1"), self.mk("b1"), self.mk("c1")
        self.device(self.a)
        self.device(self.b)
        self.withdraw_to(self.c, self.b.phone_number)

    def test_idempotent(self):
        first = recompute_linkage()
        edges1 = list(LinkEdge.objects.order_by("pk").values_list("pk", "edge_type", "weight", "first_detected_at"))
        clusters1 = list(LinkClusterMember.objects.order_by("user_id").values_list("user_id", "cluster__key"))
        second = recompute_linkage()
        edges2 = list(LinkEdge.objects.order_by("pk").values_list("pk", "edge_type", "weight", "first_detected_at"))
        clusters2 = list(LinkClusterMember.objects.order_by("user_id").values_list("user_id", "cluster__key"))
        self.assertEqual(edges1, edges2)
        self.assertEqual(clusters1, clusters2)
        self.assertEqual(first["edges"]["created"], 2)
        self.assertEqual((second["edges"]["created"], second["edges"]["updated"],
                          second["edges"]["deactivated"]), (0, 0, 0))
        self.assertEqual(LinkCluster.objects.get().size, 3)
        self.assertEqual(LinkageRun.objects.filter(ok=True).count(), 2)

    def test_evidence_gone_deactivates_edge_and_splits_cluster(self):
        recompute_linkage()
        DeviceRegistration.objects.filter(user=self.a).delete()
        recompute_linkage()
        self.assertFalse(self.edge(self.a, self.b, LinkEdge.TYPE_SHARED_DEVICE).active)
        self.assertFalse(LinkClusterMember.objects.filter(user=self.a).exists())
        self.assertEqual(LinkCluster.objects.get().size, 2)

    def test_failed_detector_keeps_its_edges(self):
        recompute_linkage()
        from unittest import mock
        with mock.patch.object(detectors, "detect_shared_devices", side_effect=RuntimeError("boom")):
            stats = recompute_linkage()
        self.assertIn("error", stats["detectors"]["shared_device"])
        self.assertTrue(self.edge(self.a, self.b, LinkEdge.TYPE_SHARED_DEVICE).active)

    def test_account_deletion_purges_linkage(self):
        recompute_linkage()
        self.b.deleted_at = timezone.now()
        self.b.save()
        self.assertFalse(LinkEdge.objects.filter(user_a=self.b).exists())
        self.assertFalse(LinkEdge.objects.filter(user_b=self.b).exists())
        self.assertFalse(LinkClusterMember.objects.filter(user=self.b).exists())


# ── payout policies (settlement) ────────────────────────────────────────────


class PolicyTests(LinkFixture, TestCase):
    def setUp(self):
        cache.clear()
        today = local_today()
        self.creator = self.mk("creator")
        self.challenge = self.make_challenge()
        now = timezone.now()
        self.main = self.mk("main", joined=now - timedelta(days=90))
        self.alt1 = self.mk("alt1", joined=now - timedelta(days=30))
        self.alt2 = self.mk("alt2", joined=now - timedelta(days=10))
        self.honest = self.mk("honest", joined=now - timedelta(days=5))
        self.today = today

    def make_challenge(self, name="Nairobi Week", entry=Decimal("100.00")):
        today = local_today()
        return Challenge.objects.create(creator=self.creator, name=name, entry_fee=entry, milestone=10000,
                                        start_date=today - timedelta(days=7), end_date=today - timedelta(days=1),
                                        status="active", total_pool=Decimal("0.00"),
                                        payout_structure="proportional")

    def join(self, user, steps=15000, challenge=None):
        ch = challenge or self.challenge
        user.wallet_balance -= ch.entry_fee
        user.locked_balance += ch.entry_fee
        user.save()
        ch.total_pool += ch.entry_fee
        ch.save(update_fields=["total_pool"])
        return Participant.objects.create(challenge=ch, user=user, steps=steps)

    def farm(self):
        for u in (self.main, self.alt1, self.alt2):
            self.device(u)
            self.join(u)
        self.join(self.honest)

    def finalize(self, challenge=None):
        self.assertTrue(finalize_challenge(challenge or self.challenge))

    def held(self):
        return set(HeldPayout.objects.values_list("user__username", flat=True))

    def test_same_challenge_holds_all_but_first_registered(self):
        self.farm()
        recompute_linkage()
        self.finalize()
        self.assertEqual(self.held(), {"alt1", "alt2"})
        hold = HeldPayout.objects.get(user=self.alt2)
        reason = next(r for r in hold.reasons if r["code"] == "linked_accounts")
        self.assertIn("same_challenge", reason["detail"]["rules"])
        listed = {p["username"]: p["first_registered"] for p in reason["detail"]["linked_in_challenge"]}
        self.assertEqual(listed, {"main": True, "alt1": False, "alt2": False})
        # First-registered and the honest winner are paid instantly.
        for u in (self.main, self.honest):
            self.assertTrue(WalletTransaction.objects.filter(user=u, type="payout").exists())
        # The customer message stays neutral (the standard review wording).
        from apps.admin_api.models import SupportTicketMessage
        text = " ".join(SupportTicketMessage.objects.filter(ticket__user=self.alt2).values_list("message", flat=True))
        self.assertIn("being reviewed", text)
        self.assertNotIn("link", text.lower())

    def test_live_strong_links_catch_accounts_before_the_nightly_run(self):
        self.farm()  # no recompute_linkage(): edges are found at settlement
        self.finalize()
        self.assertEqual(self.held(), {"alt1", "alt2"})

    def test_known_household_is_not_held(self):
        self.device(self.main)
        self.device(self.alt1)
        self.join(self.main)
        self.join(self.alt1)
        self.join(self.honest)
        recompute_linkage()
        lo, hi = sorted((self.main.pk, self.alt1.pk))
        HouseholdMark.objects.create(user_a_id=lo, user_b_id=hi, note="Mother and son share the phone")
        rebuild_clusters()
        self.finalize()
        self.assertEqual(self.held(), set())

    def test_weak_links_alone_never_hold(self):
        self.login(self.main, "41.90.64.10")
        self.login(self.alt1, "41.90.64.11")
        User.objects.filter(pk=self.main.pk).update(phone_number="254755500010")
        User.objects.filter(pk=self.alt1.pk).update(phone_number="254755500012",
                                                    date_joined=self.main.date_joined + timedelta(days=1))
        self.join(self.main)
        self.join(self.alt1)
        recompute_linkage()
        self.assertTrue(LinkEdge.objects.filter(strength="weak").exists())
        self.assertFalse(LinkCluster.objects.exists())
        self.finalize()
        self.assertEqual(self.held(), set())

    def test_single_medium_evidence_does_not_hold(self):
        shape = {7: 1500, 8: 800, 17: 2100}
        for d in range(1, 4):
            self.curve(self.main, self.today - timedelta(days=d), shape)
            self.curve(self.alt1, self.today - timedelta(days=d), shape)
        self.join(self.main)
        self.join(self.alt1)
        recompute_linkage()
        self.assertTrue(LinkEdge.objects.filter(edge_type="twin_curves").exists())
        self.finalize()
        self.assertEqual(self.held(), set())

    def paid_before(self, user):
        WalletTransaction.objects.create(user=user, type="payout", amount=Decimal("300"),
                                         balance_before=0, balance_after=Decimal("300"), description="p",
                                         metadata={"challenge_id": 999999})

    def test_same_phone_as_an_account_already_paid_is_held(self):
        self.device(self.main)
        self.device(self.alt1)
        self.paid_before(self.main)
        self.join(self.alt1)
        self.join(self.honest)
        self.finalize()
        hold = HeldPayout.objects.get()
        self.assertEqual(hold.user, self.alt1)
        reason = next(r for r in hold.reasons if r["code"] == "linked_accounts")
        self.assertEqual(reason["detail"]["rules"], ["strong_link_paid"])
        self.assertEqual(reason["detail"]["strong_links_paid"][0]["edge_types"], ["shared_device"])

    def test_shared_payout_number_alone_does_not_trigger_the_paid_rule(self):
        # Owner decision: families share M-Pesa numbers. Different challenge -> paid.
        self.withdraw_to(self.alt1, self.main.phone_number)
        self.paid_before(self.main)
        self.join(self.alt1)
        self.join(self.honest)
        self.finalize()
        self.assertEqual(self.held(), set())

    def test_shared_payout_number_still_holds_in_the_same_paid_challenge(self):
        self.withdraw_to(self.alt1, self.main.phone_number)
        self.join(self.main)
        self.join(self.alt1)
        self.join(self.honest)
        self.finalize()
        self.assertEqual(self.held(), {"alt1"})

    def test_paid_rule_can_include_payout_numbers(self):
        cfg = LinkageSettings.load()
        cfg.strong_link_paid_includes_payout_number = True
        cfg.save()
        self.withdraw_to(self.alt1, self.main.phone_number)
        self.paid_before(self.main)
        self.join(self.alt1)
        self.join(self.honest)
        self.finalize()
        self.assertEqual(self.held(), {"alt1"})

    def test_shared_business_number_never_holds(self):
        till = "254700999000"
        crowd = [self.mk(f"shop{i}") for i in range(11)]  # 11 accounts > 10
        for u in crowd:
            self.withdraw_to(u, till)
        for u in crowd[:2]:
            self.join(u)
        self.join(self.honest)
        recompute_linkage()
        self.assertFalse(LinkEdge.objects.filter(strength="strong").exists())
        e = LinkEdge.objects.filter(edge_type="shared_business_number").first()
        self.assertEqual((e.strength, e.evidence["accounts_sharing"]), ("weak", 11))
        from apps.linkage.views import explain
        self.assertIn("Shared business number (11 accounts)", explain(e.edge_type, e.evidence))
        self.assertFalse(LinkCluster.objects.exists())
        self.finalize()
        self.assertEqual(self.held(), set())

    def test_business_threshold_is_adjustable(self):
        cfg = LinkageSettings.load()
        cfg.business_number_min_accounts = 3
        cfg.save()
        for u in (self.main, self.alt1, self.alt2, self.honest):
            self.withdraw_to(u, "254700888000")
        recompute_linkage()
        self.assertFalse(LinkEdge.objects.filter(strength="strong").exists())
        self.assertEqual(LinkEdge.objects.filter(edge_type="shared_business_number").count(), 6)

    def test_linkage_crash_pays_and_alerts(self):
        from unittest import mock
        self.farm()
        with mock.patch("apps.linkage.policy.linked_account_reasons", side_effect=RuntimeError("boom")), \
                mock.patch("apps.linkage.alerts.ops_alert") as alert, \
                self.assertLogs("apps.challenges.payout_holds", level="ERROR") as logs:
            self.finalize()
        self.assertEqual(self.held(), set())
        self.assertTrue(alert.called)
        self.assertEqual(alert.call_args[0][0]["event"], "linked_account_check_failed")
        self.assertIn("LINKED-ACCOUNT CHECK FAILED", "\n".join(logs.output))

    def test_policy_switches(self):
        self.farm()
        cfg = LinkageSettings.load()
        cfg.holds_enabled = False
        cfg.save()
        self.finalize()
        self.assertEqual(self.held(), set())

    def test_free_challenge_same_challenge_rule_not_applied(self):
        ch = self.make_challenge("Free walk", entry=Decimal("0.00"))
        for u in (self.main, self.alt1):
            self.device(u)
            Participant.objects.create(challenge=ch, user=u, steps=15000)
        from apps.linkage.policy import linked_account_reasons
        p = Participant.objects.get(challenge=ch, user=self.alt1)
        self.assertEqual(linked_account_reasons(ch, p, self.alt1, Decimal("10")), [])

    def test_forfeit_never_pays_linked_accounts(self):
        self.farm()
        self.finalize()
        hold = HeldPayout.objects.get(user=self.alt1)
        plan = forfeit_plan(hold)
        recipients = {uid for _, uid, _, _ in plan["recipients"]}
        self.assertEqual(plan["mode"], "qualifiers")
        self.assertEqual(recipients, {self.honest.pk})


# ── staff endpoints ─────────────────────────────────────────────────────────


class AdminEndpointTests(LinkFixture, APITestCase):
    def setUp(self):
        self.staff = self.mk("ops_admin", is_staff=True)
        self.member = self.mk("member")
        self.a, self.b = self.mk("amani"), self.mk("baraka")
        self.device(self.a)
        self.device(self.b)
        HealthRecord.objects.create(user=self.a, date=local_today() - timedelta(days=1), steps=8000,
                                    last_raw_steps=9000, unverified_steps=1000)
        HealthRecord.objects.create(user=self.a, date=local_today() - timedelta(days=2), steps=5000,
                                    last_raw_steps=5000, is_suspicious=True)
        recompute_linkage()

    def urls(self):
        return [("get", f"/api/admin/linkage/users/{self.a.pk}/linked/"),
                ("get", f"/api/admin/linkage/users/{self.a.pk}/timeline/"),
                ("get", "/api/admin/linkage/clusters/"),
                ("post", "/api/admin/linkage/households/"),
                ("post", "/api/admin/linkage/households/1/revoke/"),
                ("get", "/api/admin/linkage/settings/"),
                ("patch", "/api/admin/linkage/settings/")]

    def test_staff_only(self):
        for method, url in self.urls():
            self.client.force_authenticate(None)
            self.assertIn(getattr(self.client, method)(url, {}, format="json").status_code, (401, 403), url)
            self.client.force_authenticate(self.member)
            self.assertEqual(getattr(self.client, method)(url, {}, format="json").status_code, 403, url)

    def test_linked_accounts_panel(self):
        self.client.force_authenticate(self.staff)
        r = self.client.get(f"/api/admin/linkage/users/{self.a.pk}/linked/")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.data["cluster"]["size"], 2)
        self.assertEqual({x["username"] for x in r.data["accounts"]}, {"amani", "baraka"})
        edge = r.data["edges"][0]
        self.assertEqual(edge["edge_type"], "shared_device")
        self.assertIn("Both accounts registered phone", edge["explanation"])
        self.assertTrue(r.data["pairs"][0]["linked"])

    def test_mark_and_revoke_household_are_audited(self):
        self.client.force_authenticate(self.staff)
        url = "/api/admin/linkage/households/"
        self.assertEqual(self.client.post(url, {"user_ids": [self.a.pk, self.b.pk], "note": "x"},
                                          format="json").status_code, 400)
        r = self.client.post(url, {"user_ids": [self.a.pk, self.b.pk], "note": "Sisters share one phone"},
                             format="json")
        self.assertEqual(r.status_code, 201)
        self.assertFalse(LinkCluster.objects.exists())
        logs = AuditLog.objects.filter(changes__kind="linkage_household")
        self.assertEqual(set(logs.values_list("resource_id", flat=True)), {self.a.pk, self.b.pk})
        self.assertEqual(logs.first().admin, self.staff)
        mark = HouseholdMark.objects.get()
        r = self.client.post(f"/api/admin/linkage/households/{mark.pk}/revoke/", {"note": "Mistaken, re-review"},
                             format="json")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(LinkCluster.objects.get().size, 2)
        self.assertEqual(AuditLog.objects.filter(changes__kind="linkage_household",
                                                 changes__action="revoke").count(), 2)
        r = self.client.get(f"/api/admin/linkage/users/{self.a.pk}/timeline/?types=linkage")
        kinds = {e["kind"] for e in r.data["events"]}
        self.assertTrue({"household_marked", "household_revoked", "link_detected"} <= kinds)

    def test_settings_validation_and_audit(self):
        self.client.force_authenticate(self.staff)
        url = "/api/admin/linkage/settings/"
        self.assertTrue(self.client.get(url).data["holds_enabled"])
        self.assertEqual(self.client.patch(url, {"paid_lookback_days": 5000}, format="json").status_code, 400)
        self.assertEqual(self.client.patch(url, {"holds_enabled": "no"}, format="json").status_code, 400)
        r = self.client.patch(url, {"strong_link_paid_hold": False, "paid_lookback_days": 90}, format="json")
        self.assertEqual(r.status_code, 200)
        self.assertFalse(LinkageSettings.load().strong_link_paid_hold)
        self.assertTrue(AuditLog.objects.filter(resource_type="settings", changes__kind="linkage_settings").exists())

    def test_timeline(self):
        self.client.force_authenticate(self.staff)
        r = self.client.get(f"/api/admin/linkage/users/{self.a.pk}/timeline/?days=7")
        self.assertEqual(r.status_code, 200)
        days = {d["date"]: d for d in r.data["days"]}
        d1 = days[(local_today() - timedelta(days=1)).isoformat()]
        self.assertEqual((d1["counted"], d1["credited"], d1["money_eligible"]), (9000, 8000, 8000))
        d2 = days[(local_today() - timedelta(days=2)).isoformat()]
        self.assertEqual((d2["credited"], d2["money_eligible"], d2["under_review"]), (5000, 0, True))
        cats = {e["category"] for e in r.data["events"]}
        self.assertTrue({"steps", "linkage", "devices"} <= cats)
        r = self.client.get(f"/api/admin/linkage/users/{self.a.pk}/timeline/?days=7&types=steps")
        self.assertEqual({e["category"] for e in r.data["events"]}, {"steps"})
