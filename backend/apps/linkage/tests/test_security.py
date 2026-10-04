from django.contrib.auth import get_user_model
from django.test import TestCase
from rest_framework.test import APIClient

from apps.linkage.models import HouseholdMark

User = get_user_model()


class LinkageSecurityTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.admin = User.objects.create_superuser(
            username="admin_security",
            phone_number="254700000001",
            email="admin_sec@example.com",
            password="password123",
            is_staff=True,
        )
        self.user_a = User.objects.create_user(
            username="user_a",
            phone_number="254700000002",
            email="usera@example.com",
            password="password123",
        )
        self.user_b = User.objects.create_user(
            username="user_b",
            phone_number="254700000003",
            email="userb@example.com",
            password="password123",
        )
        self.client.force_authenticate(user=self.admin)

    def test_household_mark_and_revoke_note_sanitization(self):
        # Test XSS payload in mark household note
        xss_payload = "<script>alert('xss')</script> This is a test note for household."
        res = self.client.post(
            "/api/admin/linkage/households/",
            {"user_ids": [self.user_a.pk, self.user_b.pk], "note": xss_payload},
            format="json",
        )
        self.assertEqual(res.status_code, 201)
        mark = HouseholdMark.objects.filter(
            user_a_id=min(self.user_a.pk, self.user_b.pk),
            user_b_id=max(self.user_a.pk, self.user_b.pk),
        ).first()
        self.assertIsNotNone(mark)
        self.assertNotIn("<script>", mark.note)
        self.assertNotIn("</script>", mark.note)
        self.assertIn("alert('xss')", mark.note)

        # Test XSS payload in revoke household note
        revoke_xss = "<img src=x onerror=alert('xss')> Revoke reason note."
        revoke_res = self.client.post(
            f"/api/admin/linkage/households/{mark.pk}/revoke/",
            {"note": revoke_xss},
            format="json",
        )
        self.assertEqual(revoke_res.status_code, 200)
        mark.refresh_from_db()
        self.assertNotIn("<img", mark.revoke_note)
        self.assertNotIn("onerror", mark.revoke_note)
