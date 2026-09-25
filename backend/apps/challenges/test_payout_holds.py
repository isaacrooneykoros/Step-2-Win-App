"""
Payout holds (apps/challenges/payout_holds.py): cheaters can't get paid, honest
winners are paid instantly.

Covers: the instant path is unchanged; every hold rule; release exactly once;
forfeit redistribution to the cent (no money created or lost); banned users are
never credited; double clicks / concurrent decisions; paid-entry blocks; the
customer API fields; the admin queue endpoints.
"""

from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
from decimal import Decimal

from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.db import connection
from django.db.models import Sum
from django.test import TestCase, TransactionTestCase
from rest_framework.test import APITestCase

from apps.admin_api.models import AuditLog, SupportTicket, SystemSettings
from apps.challenges.models import Challenge, ChallengeResult, HeldPayout, Participant
from apps.challenges.payout_holds import (PayoutReviewError, _claim,
                                          forfeit_hold, release_hold,
                                          split_forfeit)
from apps.challenges.services import finalize_challenge
from apps.payments.models import PlatformRevenue
from apps.steps.models import FraudFlag, HealthRecord, TrustScore
from apps.wallet.models import WalletTransaction

User = get_user_model()
START_BALANCE = Decimal("5000.00")


class HoldFixture:
    """Builds a finished, still-active challenge with locked entries."""

    def make_user(self, name, **extra):
        return User.objects.create_user(
            username=name,
            email=f"{name}@example.com",
            password="x-Pass-123!",
            wallet_balance=START_BALANCE,
            **extra,
        )

    def make_challenge(self, entry=Decimal("100.00"), structure="proportional"):
        today = date.today()
        return Challenge.objects.create(
            creator=self.make_user(f"creator{Challenge.objects.count()}"),
            name="Nairobi Week",
            entry_fee=entry,
            milestone=10000,
            start_date=today - timedelta(days=7),
            end_date=today - timedelta(days=1),
            status="active",
            total_pool=Decimal("0.00"),
            payout_structure=structure,
        )

    def join(self, challenge, user, steps):
        user.wallet_balance -= challenge.entry_fee
        user.locked_balance += challenge.entry_fee
        user.save()
        challenge.total_pool += challenge.entry_fee
        challenge.save(update_fields=["total_pool"])
        return Participant.objects.create(challenge=challenge, user=user, steps=steps)

    def result_for(self, challenge, user):
        return ChallengeResult.objects.get(challenge=challenge, user=user)

    def payouts_credited(self, challenge):
        return WalletTransaction.objects.filter(
            type="payout", metadata__challenge_id=challenge.id
        ).aggregate(t=Sum("amount"))["t"] or Decimal("0.00")


class _Base(HoldFixture, TestCase):
    def setUp(self):
        cache.clear()
        self.challenge = self.make_challenge()
        self.alice = self.make_user("alice")
        self.bob = self.make_user("bob")
        self.carol = self.make_user("carol")
        self.join(self.challenge, self.alice, 15000)
        self.join(self.challenge, self.bob, 12000)
        self.join(self.challenge, self.carol, 5000)  # does not qualify

    def finalize(self):
        self.assertTrue(finalize_challenge(self.challenge))
        self.challenge.refresh_from_db()
        for u in (self.alice, self.bob, self.carol):
            u.refresh_from_db()

    def in_window(self, days_before_end=2):
        return self.challenge.end_date - timedelta(days=days_before_end)


class InstantPayoutUnchangedTests(_Base):
    def test_honest_winners_paid_instantly(self):
        self.finalize()
        self.assertFalse(HeldPayout.objects.exists())
        for u in (self.alice, self.bob):
            payout = self.result_for(self.challenge, u).payout_kes
            self.assertGreater(payout, 0)
            self.assertEqual(u.wallet_balance, START_BALANCE - Decimal("100.00") + payout)
            self.assertEqual(u.locked_balance, Decimal("0.00"))
            self.assertEqual(u.total_earned, payout)
            self.assertEqual(u.challenges_won, 1)
        self.assertEqual(self.carol.wallet_balance, START_BALANCE - Decimal("100.00"))
        self.assertEqual(self.payouts_credited(self.challenge), self.challenge.net_pool)

    def test_good_trust_and_reviewed_or_low_flags_are_clear(self):
        TrustScore.objects.create(user=self.alice, score=75)  # WARN is still clear
        FraudFlag.objects.create(user=self.alice, flag_type="x", severity="high", date=self.in_window(), reviewed=True)
        FraudFlag.objects.create(user=self.alice, flag_type="y", severity="low", date=self.in_window())
        FraudFlag.objects.create(  # outside the window
            user=self.alice, flag_type="z", severity="critical", date=self.challenge.start_date - timedelta(days=3)
        )
        self.finalize()
        self.assertFalse(HeldPayout.objects.exists())


class HoldReasonTests(_Base):
    def assertHeld(self, user, code):
        self.finalize()
        user.refresh_from_db()
        hold = HeldPayout.objects.get(user=user)
        result = self.result_for(self.challenge, user)
        self.assertEqual(hold.amount, result.payout_kes)
        self.assertEqual(hold.status, "held")
        self.assertIn(code, [r["code"] for r in hold.reasons])
        # Not credited, entry released, nothing earned yet.
        self.assertEqual(user.wallet_balance, START_BALANCE - Decimal("100.00"))
        self.assertEqual(user.locked_balance, Decimal("0.00"))
        self.assertEqual(user.total_earned, Decimal("0.00"))
        self.assertFalse(WalletTransaction.objects.filter(user=user, type="payout").exists())
        # The other winner is still paid instantly.
        self.assertGreater(self.bob.wallet_balance, START_BALANCE - Decimal("100.00"))
        return hold

    def test_trust_review(self):
        TrustScore.objects.create(user=self.alice, score=50)
        self.assertFalse(self.assertHeld(self.alice, "trust_status").forfeit_only)

    def test_trust_restrict(self):
        TrustScore.objects.create(user=self.alice, score=35)
        self.assertHeld(self.alice, "trust_status")

    def test_trust_suspend(self):
        TrustScore.objects.create(user=self.alice, score=10)
        self.assertHeld(self.alice, "trust_status")

    def test_trust_ban_is_forfeit_only(self):
        TrustScore.objects.create(user=self.alice, score=0)
        self.assertTrue(self.assertHeld(self.alice, "trust_banned").forfeit_only)

    def test_open_high_flag_in_window(self):
        FraudFlag.objects.create(user=self.alice, flag_type="burst", severity="high", date=self.in_window())
        self.assertHeld(self.alice, "open_high_flags")

    def test_open_critical_flag_in_window(self):
        FraudFlag.objects.create(user=self.alice, flag_type="shake", severity="critical", date=self.challenge.start_date)
        self.assertHeld(self.alice, "open_high_flags")

    def test_suspicious_day_in_window(self):
        HealthRecord.objects.create(user=self.alice, date=self.in_window(), steps=9000, is_suspicious=True)
        self.assertHeld(self.alice, "suspicious_days")

    def test_large_win_with_medium_flag(self):
        s = SystemSettings.load()
        s.payout_hold_large_win_kes = Decimal("50.00")
        s.save()
        FraudFlag.objects.create(user=self.alice, flag_type="pattern", severity="medium", date=self.in_window())
        self.assertHeld(self.alice, "large_win_with_flags")

    def test_small_win_with_medium_flag_is_clear(self):
        FraudFlag.objects.create(user=self.alice, flag_type="pattern", severity="medium", date=self.in_window())
        self.finalize()  # default threshold KSh 5,000 >> this payout
        self.assertFalse(HeldPayout.objects.exists())

    def test_inactive_account(self):
        self.alice.is_active = False
        self.alice.save()
        self.assertTrue(self.assertHeld(self.alice, "account_closed").forfeit_only)

    def test_switch_off_pays_review_score_but_still_holds_ban(self):
        s = SystemSettings.load()
        s.payout_holds_enabled = False
        s.save()
        TrustScore.objects.create(user=self.alice, score=50)
        TrustScore.objects.create(user=self.bob, score=0)
        self.finalize()
        self.assertFalse(HeldPayout.objects.filter(user=self.alice).exists())
        self.assertTrue(HeldPayout.objects.get(user=self.bob).forfeit_only)

    def test_user_is_notified_neutrally(self):
        TrustScore.objects.create(user=self.alice, score=50)
        self.finalize()
        ticket = SupportTicket.objects.get(user=self.alice)
        text = (ticket.subject + " " + ticket.messages.first().message).lower()
        self.assertIn("being reviewed", text)
        self.assertIn("48 hours", text)
        for word in ("cheat", "fraud", "suspicious"):
            self.assertNotIn(word, text)


class ReleaseTests(_Base):
    def setUp(self):
        super().setUp()
        self.admin = self.make_user("ops", is_staff=True)
        TrustScore.objects.create(user=self.alice, score=50)
        self.finalize()
        self.hold = HeldPayout.objects.get(user=self.alice)

    def test_release_credits_once(self):
        out = release_hold(self.hold.id, self.admin, "Walk data checked, looks genuine")
        self.assertEqual(out["status"], "released")
        again = release_hold(self.hold.id, self.admin, "Second click on release")
        self.assertTrue(again["already_decided"])
        forfeit = forfeit_hold(self.hold.id, self.admin, "Late forfeit click")
        self.assertTrue(forfeit["already_decided"])

        self.alice.refresh_from_db()
        amount = self.hold.amount
        self.assertEqual(self.alice.wallet_balance, START_BALANCE - Decimal("100.00") + amount)
        self.assertEqual(self.alice.total_earned, amount)
        self.assertEqual(self.alice.challenges_won, 1)
        txns = WalletTransaction.objects.filter(user=self.alice, type="payout")
        self.assertEqual(txns.count(), 1)
        txn = txns.get()
        self.assertEqual(txn.amount, amount)
        self.assertEqual(txn.balance_after, txn.balance_before + amount)
        self.assertEqual(txn.reference_id, f"PAYOUT-HOLD-{self.hold.id}-RELEASE")
        self.assertEqual(self.payouts_credited(self.challenge), self.challenge.net_pool)
        self.assertTrue(AuditLog.objects.filter(action="approve", resource_id=self.hold.id).exists())
        self.hold.refresh_from_db()
        self.assertEqual(self.hold.decided_by, self.admin)
        self.assertEqual(self.hold.resolution["wallet_transaction_id"], txn.id)

    def test_note_is_required(self):
        with self.assertRaises(PayoutReviewError):
            release_hold(self.hold.id, self.admin, "  ")
        self.hold.refresh_from_db()
        self.assertEqual(self.hold.status, "held")

    def test_claim_is_exclusive(self):
        """Two deciders that both saw 'held': only one claim succeeds."""
        self.assertTrue(_claim(self.hold.id, "released", self.admin, "first"))
        self.assertFalse(_claim(self.hold.id, "released", self.admin, "second"))
        self.assertFalse(_claim(self.hold.id, "forfeited", self.admin, "third"))

    def test_user_banned_after_settlement_cannot_be_released(self):
        TrustScore.objects.filter(user=self.alice).update(score=0)
        with self.assertRaises(PayoutReviewError):
            release_hold(self.hold.id, self.admin, "Trying to release anyway")
        self.alice.refresh_from_db()
        self.assertEqual(self.alice.wallet_balance, START_BALANCE - Decimal("100.00"))


class BannedNeverCreditedTests(_Base):
    def test_banned_user_is_never_credited(self):
        admin = self.make_user("ops", is_staff=True)
        TrustScore.objects.create(user=self.alice, score=0)
        self.finalize()
        hold = HeldPayout.objects.get(user=self.alice)
        with self.assertRaises(PayoutReviewError):
            release_hold(hold.id, admin, "Release attempt for banned user")
        forfeit_hold(hold.id, admin, "Shaker pattern confirmed on 4 days")
        self.alice.refresh_from_db()
        self.assertEqual(self.alice.wallet_balance, START_BALANCE - Decimal("100.00"))
        self.assertEqual(self.alice.total_earned, Decimal("0.00"))
        self.assertFalse(WalletTransaction.objects.filter(user=self.alice, type="payout").exists())
        # Bob (the only clear qualifier) received the whole forfeited amount.
        self.bob.refresh_from_db()
        self.assertEqual(self.bob.total_earned, self.challenge.net_pool)
        self.assertEqual(self.payouts_credited(self.challenge), self.challenge.net_pool)


class ForfeitMathTests(HoldFixture, TestCase):
    def setUp(self):
        cache.clear()
        self.admin = self.make_user("ops", is_staff=True)

    def test_split_forfeit_rounding(self):
        self.assertEqual(
            split_forfeit(Decimal("100.00"), [Decimal("1")] * 3),
            [Decimal("33.34"), Decimal("33.33"), Decimal("33.33")],
        )
        shares = split_forfeit(Decimal("0.05"), [Decimal("1")] * 7)
        self.assertEqual(sum(shares), Decimal("0.05"))
        shares = split_forfeit(Decimal("1265.41"), [Decimal("412.37"), Decimal("356.02"), Decimal("319.99")])
        self.assertEqual(sum(shares), Decimal("1265.41"))
        self.assertEqual(split_forfeit(Decimal("10"), []), [])

    def test_redistribution_balances_the_pool_to_the_cent(self):
        c = self.make_challenge(entry=Decimal("333.00"))
        cheat, u1, u2, u3 = (self.make_user(n) for n in ("cheat", "u1", "u2", "u3"))
        for user, steps in ((cheat, 17003), (u1, 13001), (u2, 11007), (u3, 10009)):
            self.join(c, user, steps)
        TrustScore.objects.create(user=cheat, score=30)
        finalize_challenge(c)
        c.refresh_from_db()
        hold = HeldPayout.objects.get(user=cheat)
        originals = {u.id: self.result_for(c, u).payout_kes for u in (u1, u2, u3)}

        out = forfeit_hold(hold.id, self.admin, "Vehicle vibration pattern on 3 days")
        self.assertEqual(out["status"], "forfeited")
        shares = {d["user_id"]: Decimal(d["share"]) for d in out["redistributed"]}
        self.assertEqual(sum(shares.values()), hold.amount)

        # Shares follow the original payouts (largest share to the largest payout).
        order = sorted(originals, key=originals.get)
        self.assertLessEqual(shares[order[0]], shares[order[1]])
        self.assertLessEqual(shares[order[1]], shares[order[2]])
        for u in (u1, u2, u3):
            u.refresh_from_db()
            credited = WalletTransaction.objects.filter(user=u, type="payout").aggregate(t=Sum("amount"))["t"]
            self.assertEqual(credited, originals[u.id] + shares[u.id])
            self.assertEqual(u.total_earned, credited)
            self.assertEqual(u.wallet_balance, START_BALANCE - Decimal("333.00") + credited)
        cheat.refresh_from_db()
        self.assertEqual(cheat.wallet_balance, START_BALANCE - Decimal("333.00"))
        # No money created or lost: payouts == net pool, fee recorded once.
        self.assertEqual(self.payouts_credited(c), c.net_pool)
        self.assertEqual(PlatformRevenue.objects.filter(challenge=c).count(), 1)
        self.assertEqual(
            self.payouts_credited(c) + PlatformRevenue.objects.get(challenge=c).amount_kes,
            c.total_pool,
        )
        self.assertTrue(AuditLog.objects.filter(action="reject", resource_id=hold.id).exists())

    def test_no_clear_qualifier_goes_to_platform(self):
        c = self.make_challenge()
        solo, loser = self.make_user("solo"), self.make_user("loser")
        self.join(c, solo, 20000)
        self.join(c, loser, 100)
        TrustScore.objects.create(user=solo, score=0)
        finalize_challenge(c)
        hold = HeldPayout.objects.get(user=solo)
        out = forfeit_hold(hold.id, self.admin, "Banned account, forfeit to platform")
        self.assertEqual(out["redistributed"], [])
        rev = PlatformRevenue.objects.get(pk=out["platform_revenue_id"])
        self.assertEqual(rev.amount_kes, hold.amount)
        self.assertEqual(rev.metadata["held_payout_id"], hold.id)
        self.assertFalse(WalletTransaction.objects.filter(type="payout", metadata__challenge_id=c.id).exists())
        c.refresh_from_db()
        total_rev = PlatformRevenue.objects.filter(challenge=c).aggregate(t=Sum("amount_kes"))["t"]
        self.assertEqual(total_rev, c.total_pool)

    def test_other_held_qualifier_gets_no_share(self):
        c = self.make_challenge()
        a, b, d = self.make_user("a1"), self.make_user("b1"), self.make_user("d1")
        for user, steps in ((a, 20000), (b, 15000), (d, 12000)):
            self.join(c, user, steps)
        TrustScore.objects.create(user=a, score=50)
        TrustScore.objects.create(user=b, score=50)
        finalize_challenge(c)
        hold_a = HeldPayout.objects.get(user=a)
        out = forfeit_hold(hold_a.id, self.admin, "Forfeit while b still under review")
        self.assertEqual([r["user_id"] for r in out["redistributed"]], [d.id])
        self.assertEqual(Decimal(out["redistributed"][0]["share"]), hold_a.amount)

    def test_released_qualifier_counts_as_clear(self):
        c = self.make_challenge()
        a, b = self.make_user("a2"), self.make_user("b2")
        self.join(c, a, 20000)
        self.join(c, b, 15000)
        TrustScore.objects.create(user=a, score=50)
        TrustScore.objects.create(user=b, score=50)
        finalize_challenge(c)
        release_hold(HeldPayout.objects.get(user=b).id, self.admin, "b checked and fine")
        out = forfeit_hold(HeldPayout.objects.get(user=a).id, self.admin, "a forfeited")
        self.assertEqual([r["user_id"] for r in out["redistributed"]], [b.id])
        c.refresh_from_db()
        self.assertEqual(self.payouts_credited(c), c.net_pool)


class PaidEntryBlockTests(HoldFixture, APITestCase):
    def setUp(self):
        cache.clear()
        self.user = self.make_user("joiner")
        self.target = self.make_challenge()
        self.target.start_date = date.today()
        self.target.end_date = date.today() + timedelta(days=7)
        self.target.save()
        self.client.force_authenticate(self.user)

    def _join(self):
        return self.client.post("/api/challenges/join/", {"invite_code": self.target.invite_code}, format="json")

    def test_held_payout_blocks_paid_join_until_decided(self):
        old = self.make_challenge()
        p = Participant.objects.create(challenge=old, user=self.user, steps=20000)
        hold = HeldPayout.objects.create(challenge=old, participant=p, user=self.user, amount=Decimal("90"))
        r = self._join()
        self.assertEqual(r.status_code, 403)
        self.assertEqual(r.json()["code"], "paid_entry_paused")
        self.assertIn("review", r.json()["error"])
        release_hold(hold.id, self.make_user("ops", is_staff=True), "Checked, releasing now")
        self.assertEqual(self._join().status_code, 200)

    def test_suspended_and_banned_cannot_join_paid(self):
        trust = TrustScore.objects.create(user=self.user, score=10)
        self.assertEqual(self._join().status_code, 403)
        trust.score = 0
        trust.save()
        self.assertEqual(self._join().status_code, 403)
        trust.score = 45  # REVIEW: joining is still allowed
        trust.save()
        self.assertEqual(self._join().status_code, 200)


class CustomerApiTests(HoldFixture, APITestCase):
    def setUp(self):
        cache.clear()
        self.c = self.make_challenge()
        self.held_user, self.clear_user = self.make_user("held_u"), self.make_user("clear_u")
        self.join(self.c, self.held_user, 20000)
        self.join(self.c, self.clear_user, 15000)
        TrustScore.objects.create(user=self.held_user, score=50)
        finalize_challenge(self.c)
        self.hold = HeldPayout.objects.get(user=self.held_user)

    def test_results_show_held_payout_to_owner_only(self):
        self.client.force_authenticate(self.held_user)
        body = self.client.get(f"/api/challenges/{self.c.id}/results/").json()
        mine = body["my_result"]
        self.assertEqual(mine["payout_status"], "held")
        self.assertEqual(mine["payout_review"]["amount"], str(self.hold.amount))
        self.assertIn("being reviewed", mine["payout_review"]["message"])
        self.assertIn("48 hours", mine["payout_review"]["message"])
        for row in body["leaderboard"]:
            self.assertNotIn("payout_status", row)
            self.assertNotIn("payout_review", row)

        recent = self.client.get("/api/challenges/my-results/").json()
        self.assertEqual(recent["my_result"]["payout_status"], "held")

    def test_clear_winner_sees_paid(self):
        self.client.force_authenticate(self.clear_user)
        mine = self.client.get(f"/api/challenges/{self.c.id}/results/").json()["my_result"]
        self.assertEqual(mine["payout_status"], "paid")
        self.assertIsNone(mine["payout_review"])

    def test_wallet_summary_lists_payouts_under_review(self):
        self.client.force_authenticate(self.held_user)
        body = self.client.get("/api/wallet/summary/").json()
        self.assertEqual(len(body["payouts_under_review"]), 1)
        self.assertEqual(Decimal(body["under_review_total"]), self.hold.amount)
        self.assertEqual(body["payouts_under_review"][0]["challenge_name"], self.c.name)
        # Held money is not in the balance.
        self.assertEqual(Decimal(body["balance"]), START_BALANCE - self.c.entry_fee)

        release_hold(self.hold.id, self.make_user("ops", is_staff=True), "Released after check")
        self.held_user.refresh_from_db()
        self.client.force_authenticate(self.held_user)
        body =self.client.get("/api/wallet/summary/").json()
        self.assertEqual(body["payouts_under_review"], [])
        self.assertEqual(Decimal(body["balance"]), START_BALANCE - self.c.entry_fee + self.hold.amount)


class AdminQueueApiTests(HoldFixture, APITestCase):
    def setUp(self):
        cache.clear()
        self.admin = self.make_user("queue_admin", is_staff=True, is_superuser=True)
        c = self.make_challenge()
        self.u = self.make_user("queued")
        self.other = self.make_user("other_winner")
        self.join(c, self.u, 20000)
        self.join(c, self.other, 15000)
        FraudFlag.objects.create(user=self.u, flag_type="burst", severity="high", date=c.end_date)
        HealthRecord.objects.create(user=self.u, date=c.start_date - timedelta(days=3), steps=4000)
        finalize_challenge(c)
        self.hold = HeldPayout.objects.get(user=self.u)

    def test_non_staff_forbidden(self):
        self.client.force_authenticate(self.u)
        self.assertEqual(self.client.get("/api/admin/payout-reviews/").status_code, 403)
        r = self.client.post(f"/api/admin/payout-reviews/{self.hold.id}/release/", {"note": "self-release"}, format="json")
        self.assertEqual(r.status_code, 403)

    def test_list_detail_and_decide(self):
        self.client.force_authenticate(self.admin)
        body = self.client.get("/api/admin/payout-reviews/").json()
        self.assertEqual(body["counts"]["held"], 1)
        self.assertEqual(body["results"][0]["id"], self.hold.id)
        self.assertEqual(Decimal(body["held_total"]), self.hold.amount)

        d = self.client.get(f"/api/admin/payout-reviews/{self.hold.id}/").json()
        self.assertTrue(d["can_release"])
        self.assertEqual(len(d["evidence"]["flags_in_window"]), 1)
        self.assertEqual(d["evidence"]["daily_steps"]["baseline_avg"], 4000)
        self.assertEqual(d["forfeit_preview"]["recipients"][0]["user_id"], self.other.id)

        r = self.client.post(f"/api/admin/payout-reviews/{self.hold.id}/forfeit/", {"note": ""}, format="json")
        self.assertEqual(r.status_code, 400)

        url = f"/api/admin/payout-reviews/{self.hold.id}/release/"
        first = self.client.post(url, {"note": "Checked GPS route, genuine"}, format="json")
        second = self.client.post(url, {"note": "Checked GPS route, genuine"}, format="json")
        self.assertEqual(first.status_code, 200, first.content)
        self.assertEqual(second.status_code, 200)
        self.assertTrue(second.json()["already_decided"])
        self.assertEqual(WalletTransaction.objects.filter(user=self.u, type="payout").count(), 1)
        self.assertEqual(self.client.get("/api/admin/payout-reviews/").json()["counts"]["held"], 0)


class ConcurrentReleaseTests(HoldFixture, TransactionTestCase):
    """Two admins releasing at the same moment: one credit (real DB locks only)."""

    def test_two_concurrent_releases_credit_once(self):
        if connection.vendor == "sqlite":
            self.skipTest("SQLite has no row locks; covered by the claim / double-click tests")
        cache.clear()
        admin = self.make_user("ops", is_staff=True)
        c = self.make_challenge()
        u, v = self.make_user("race_u"), self.make_user("race_v")
        self.join(c, u, 20000)
        self.join(c, v, 15000)
        TrustScore.objects.create(user=u, score=50)
        finalize_challenge(c)
        hold = HeldPayout.objects.get(user=u)

        def go(i):
            try:
                return release_hold(hold.id, admin, f"Concurrent release {i}")
            finally:
                connection.close()

        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(go, range(4)))
        self.assertEqual(sum(1 for r in results if not r.get("already_decided")), 1)
        self.assertEqual(WalletTransaction.objects.filter(user=u, type="payout").count(), 1)
