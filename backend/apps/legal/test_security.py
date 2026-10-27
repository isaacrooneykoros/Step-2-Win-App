from io import BytesIO
from django.contrib.auth import get_user_model
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase
from rest_framework.test import APIClient

from apps.core.sanitizers import sanitize_html
from .models import LegalDocument

User = get_user_model()


class LegalSecurityTests(TestCase):
    def setUp(self):
        LegalDocument.objects.all().delete()
        self.client = APIClient()
        self.admin = User.objects.create_user(
            username="legal_sec_admin",
            email="sec_admin@example.com",
            phone_number="254700000099",
            password="pass12345!",
            is_staff=True,
        )
        self.client.force_authenticate(self.admin)

    def test_sanitize_html_strips_scripts_and_events(self):
        dirty = "<h1>Title</h1><script>alert('xss')</script><p onclick='evil()'>Hello</p><a href='javascript:alert(1)'>Click</a>"
        clean = sanitize_html(dirty)
        self.assertNotIn("<script>", clean)
        self.assertNotIn("onclick", clean)
        self.assertNotIn("javascript:", clean)
        self.assertIn("<h1>Title</h1>", clean)
        self.assertIn("<p>Hello</p>", clean)

    def test_admin_update_draft_sanitizes_xss(self):
        res = self.client.post(
            "/api/legal/admin/documents/create/",
            {"document_type": "refund_policy", "title": "Refund Policy"},
            format="json",
        )
        self.assertEqual(res.status_code, 201)
        doc_id = res.json()["id"]

        xss_payload = "<h2>Refunds</h2><script>alert(1)</script><p onerror=alert(2)>Policy text</p>"
        update_res = self.client.patch(
            f"/api/legal/admin/documents/{doc_id}/",
            {"content_html": xss_payload},
            format="json",
        )
        self.assertEqual(update_res.status_code, 200)
        draft = update_res.json()["draft_html"]
        self.assertNotIn("<script>", draft)
        self.assertNotIn("onerror", draft)
        self.assertIn("<h2>Refunds</h2>", draft)
        self.assertIn("<p>Policy text</p>", draft)

    test_admin_update_draft_sanitizes_xss.tags = ["security"]

    def test_uploaded_html_file_sanitizes_xss(self):
        res = self.client.post(
            "/api/legal/admin/documents/create/",
            {"document_type": "cookie_policy", "title": "Cookie Policy"},
            format="json",
        )
        self.assertEqual(res.status_code, 201)
        doc_id = res.json()["id"]

        raw_html = b"<h3>Cookies</h3><iframe src='http://evil.com'></iframe><p>We use cookies.</p>"
        file_obj = SimpleUploadedFile("cookies.html", raw_html, content_type="text/html")

        upload_res = self.client.patch(
            f"/api/legal/admin/documents/{doc_id}/",
            {"uploaded_file": file_obj},
            format="multipart",
        )
        self.assertEqual(upload_res.status_code, 200)
        draft = upload_res.json()["draft_html"]
        self.assertNotIn("<iframe>", draft)
        self.assertIn("<h3>Cookies</h3>", draft)
        self.assertIn("<p>We use cookies.</p>", draft)

    test_uploaded_html_file_sanitizes_xss.tags = ["security"]
