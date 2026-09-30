from datetime import date, timedelta
from decimal import Decimal

from django.contrib.auth import get_user_model
from django.test import TestCase
from django.utils import timezone
from rest_framework.test import APIClient

from apps.admin_api.models import AuditLog
from apps.challenges.models import Challenge, Participant
from apps.content.models import Announcement, HelpArticle, HelpCategory

User = get_user_model()


def mk(username, **extra):
    return User.objects.create_user(username=username, email=f"{username}@example.com",
                                    phone_number=f"2547{abs(hash(username)) % 10**8:08d}",
                                    password="TestPass123!", **extra)


class AnnouncementTests(TestCase):
    def setUp(self):
        self.admin = mk("content_admin", is_staff=True)
        self.user = mk("content_user")
        self.staff = APIClient()
        self.staff.force_authenticate(self.admin)
        self.cust = APIClient()
        self.cust.force_authenticate(self.user)

    def create(self, **body):
        data = {"title": "Heads up", "body": "M-Pesa is slow **today**.", "severity": "warning", **body}
        r = self.staff.post("/api/admin/content/announcements/", data, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        return r.json()

    def mine(self, platform="web"):
        return self.cust.get(f"/api/content/announcements/?platform={platform}").json()["results"]

    def test_draft_not_shown_until_published_then_archive_hides(self):
        a = self.create()
        self.assertEqual(self.mine(), [])
        self.assertEqual(self.staff.post(f"/api/admin/content/announcements/{a['id']}/publish/").status_code, 200)
        self.assertEqual([x["id"] for x in self.mine()], [a["id"]])
        self.staff.post(f"/api/admin/content/announcements/{a['id']}/archive/")
        self.assertEqual(self.mine(), [])
        actions = set(AuditLog.objects.filter(resource_type="announcement", resource_id=a["id"]).values_list("action", flat=True))
        self.assertTrue({"create", "publish", "archive"} <= actions)

    def test_schedule_window(self):
        now = timezone.now()
        later = self.create(starts_at=(now + timedelta(hours=2)).isoformat())
        ended = self.create(starts_at=(now - timedelta(days=2)).isoformat(), ends_at=(now - timedelta(days=1)).isoformat())
        for a in (later,):
            self.staff.post(f"/api/admin/content/announcements/{a['id']}/publish/")
        # Publishing something already ended is refused.
        self.assertEqual(self.staff.post(f"/api/admin/content/announcements/{ended['id']}/publish/").status_code, 400)
        self.assertEqual(self.mine(), [])
        Announcement.objects.filter(pk=later["id"]).update(starts_at=now - timedelta(minutes=1))
        self.assertEqual(len(self.mine()), 1)
        bad = self.staff.post("/api/admin/content/announcements/",
                              {"title": "x", "starts_at": now.isoformat(), "ends_at": (now - timedelta(hours=1)).isoformat()}, format="json")
        self.assertEqual(bad.status_code, 400)

    def test_platform_and_segment_audience(self):
        android = self.create(title="Android only", audience="android")
        seg = self.create(title="Challengers", audience="segment", segment="active_challenge")
        for a in (android, seg):
            self.staff.post(f"/api/admin/content/announcements/{a['id']}/publish/")
        self.assertEqual([x["title"] for x in self.mine("android")], ["Android only"])
        self.assertEqual(self.mine("web"), [])
        ch = Challenge.objects.create(name="Seg", creator=self.admin, milestone=50000, entry_fee=Decimal("0"),
                                      total_pool=Decimal("0"), max_participants=10, status="active",
                                      start_date=date.today(), end_date=date.today() + timedelta(days=7))
        Participant.objects.create(challenge=ch, user=self.user)
        self.assertEqual({x["title"] for x in self.mine("web")}, {"Challengers"})
        missing = self.staff.post("/api/admin/content/announcements/", {"title": "s", "audience": "segment"}, format="json")
        self.assertEqual(missing.status_code, 400)

    def test_dismiss_is_per_user_and_respects_dismissible(self):
        a = self.create()
        sticky = self.create(title="Sticky", dismissible=False)
        for x in (a, sticky):
            self.staff.post(f"/api/admin/content/announcements/{x['id']}/publish/")
        self.assertEqual(self.cust.post(f"/api/content/announcements/{a['id']}/dismiss/").status_code, 200)
        self.assertEqual(self.cust.post(f"/api/content/announcements/{sticky['id']}/dismiss/").status_code, 400)
        self.assertEqual([x["title"] for x in self.mine()], ["Sticky"])
        other = APIClient()
        other.force_authenticate(mk("content_other"))
        self.assertEqual(len(other.get("/api/content/announcements/?platform=web").json()["results"]), 2)

    def test_delete_only_never_published_drafts(self):
        a = self.create()
        self.staff.post(f"/api/admin/content/announcements/{a['id']}/publish/")
        self.staff.post(f"/api/admin/content/announcements/{a['id']}/archive/")
        self.assertEqual(self.staff.delete(f"/api/admin/content/announcements/{a['id']}/").status_code, 409)
        d = self.create(title="Draft")
        self.assertEqual(self.staff.delete(f"/api/admin/content/announcements/{d['id']}/").status_code, 204)
        self.assertTrue(AuditLog.objects.filter(resource_type="announcement", action="delete", resource_id=d["id"]).exists())

    def test_links_are_validated(self):
        r = self.staff.post("/api/admin/content/announcements/", {"title": "x", "link_url": "javascript:alert(1)"}, format="json")
        self.assertEqual(r.status_code, 400)
        self.create(link_url="/wallet", link_label="Open wallet")

    def test_customers_cannot_use_admin_endpoints(self):
        self.assertEqual(self.cust.get("/api/admin/content/announcements/").status_code, 403)


class HelpCentreTests(TestCase):
    def setUp(self):
        self.admin = mk("help_admin", is_staff=True)
        self.staff = APIClient()
        self.staff.force_authenticate(self.admin)
        self.cust = APIClient()
        self.cust.force_authenticate(mk("help_user"))

    def test_publish_search_reorder_and_audit(self):
        cat = self.staff.post("/api/admin/content/help/categories/", {"title": "Wallet"}, format="json").json()
        cat2 = self.staff.post("/api/admin/content/help/categories/", {"title": "Steps"}, format="json").json()
        a1 = self.staff.post("/api/admin/content/help/articles/", {"category": cat["id"], "title": "How do I withdraw?",
                                                                    "body": "Open Wallet and tap Withdraw."}, format="json").json()
        a2 = self.staff.post("/api/admin/content/help/articles/", {"category": cat["id"], "title": "Deposits",
                                                                    "body": "Use M-Pesa.", "is_published": True}, format="json").json()
        data = self.cust.get("/api/content/help/").json()
        self.assertEqual(data["total"], 1)  # a1 is a draft
        self.staff.patch(f"/api/admin/content/help/articles/{a1['id']}/", {"is_published": True}, format="json")
        self.assertEqual(self.cust.get("/api/content/help/").json()["total"], 2)
        found = self.cust.get("/api/content/help/?q=withdraw").json()
        self.assertEqual([a["title"] for c in found["categories"] for a in c["articles"]], ["How do I withdraw?"])
        r = self.staff.post("/api/admin/content/help/articles/reorder/", {"category": cat["id"], "ids": [a2["id"], a1["id"]]}, format="json")
        self.assertEqual(r.status_code, 200)
        self.assertEqual([x["id"] for x in r.json()["results"]], [a2["id"], a1["id"]])
        r = self.staff.post("/api/admin/content/help/categories/reorder/", {"ids": [cat2["id"], cat["id"]]}, format="json")
        self.assertEqual(r.status_code, 200)
        # Unpublished category hides its articles.
        self.staff.patch(f"/api/admin/content/help/categories/{cat['id']}/", {"is_published": False}, format="json")
        self.assertEqual(self.cust.get("/api/content/help/").json()["total"], 0)
        # A category with articles can't be deleted.
        self.assertEqual(self.staff.delete(f"/api/admin/content/help/categories/{cat['id']}/").status_code, 409)
        self.assertEqual(self.staff.delete(f"/api/admin/content/help/categories/{cat2['id']}/").status_code, 204)
        kinds = set(AuditLog.objects.filter(resource_type__in=["faq_article", "faq_category"]).values_list("action", flat=True))
        self.assertTrue({"create", "publish", "unpublish", "reorder", "delete"} <= kinds)
        self.assertTrue(HelpArticle.objects.filter(pk=a1["id"]).exists())
        self.assertFalse(HelpCategory.objects.filter(pk=cat2["id"]).exists())
