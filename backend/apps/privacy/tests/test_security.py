from django.test import TestCase
from rest_framework import status
from rest_framework.test import APIClient

from apps.privacy.models import DataExportRequest
from apps.privacy.tests.helpers import make_user


class PrivacySecurityTests(TestCase):
    def setUp(self):
        self.user = make_user("privacy_sec_user", "254711000999")
        self.admin = make_user("privacy_admin", "254711000998", is_staff=True, is_superuser=True)
        self.client = APIClient()

    def test_export_download_invalid_uuid_returns_404(self):
        """Requesting export download with malformed UUID string returns HTTP 404 instead of 500."""
        self.client.force_authenticate(user=self.user)
        # Directly call endpoint or pass malformed id to view
        response = self.client.get("/api/privacy/exports/invalid-uuid-string/download/")
        # Django URL pattern uses <uuid:export_id>, or if reached view directly, both return 404
        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)

    def test_consents_non_dict_payload_handles_gracefully(self):
        """Posting non-dict data to consents endpoint returns 400 without unhandled exception."""
        self.client.force_authenticate(user=self.user)
        response = self.client.post("/api/privacy/consents/", data="not-a-dict", content_type="application/json")
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)

    def test_admin_settings_non_dict_payload_handles_gracefully(self):
        """Patching admin settings with non-dict data handles request safely."""
        self.client.force_authenticate(user=self.admin)
        response = self.client.patch("/api/privacy/admin/settings/", data="not-a-dict", content_type="application/json")
        self.assertIn(response.status_code, [status.HTTP_200_OK, status.HTTP_400_BAD_REQUEST])
