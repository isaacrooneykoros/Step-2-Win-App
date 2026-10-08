from django.contrib.auth import get_user_model
from django.test import TestCase
from rest_framework.test import APIClient

from apps.content.models import Announcement, HelpArticle, HelpCategory

User = get_user_model()


def mk(username, **extra):
    return User.objects.create_user(
        username=username,
        email=f"{username}@example.com",
        phone_number=f"2547{abs(hash(username)) % 10**8:08d}",
        password="TestPass123!",
        **extra,
    )


class ContentSecurityTests(TestCase):
    def setUp(self):
        self.admin = mk("content_sec_admin", is_staff=True)
        self.staff = APIClient()
        self.staff.force_authenticate(self.admin)

    def test_announcement_input_sanitizes_html_xss(self):
        payload = {
            "title": "<script>alert('xss-title')</script>Announcement Title",
            "body": "<p>Hello <iframe src='http://evil.com'></iframe>World</p>",
            "severity": "info",
        }
        res = self.staff.post("/api/admin/content/announcements/", payload, format="json")
        self.assertEqual(res.status_code, 201)
        data = res.json()
        self.assertEqual(data["title"], "alert('xss-title')Announcement Title")
        self.assertEqual(data["body"], "Hello World")

        # Test PATCH update sanitization
        patch_res = self.staff.patch(
            f"/api/admin/content/announcements/{data['id']}/",
            {"body": "<img src=x onerror=alert(1)>Updated Body"},
            format="json",
        )
        self.assertEqual(patch_res.status_code, 200)
        self.assertEqual(patch_res.json()["body"], "Updated Body")

    def test_help_category_input_sanitizes_html_xss(self):
        cat_payload = {
            "title": "<b>Wallet</b> Help",
            "description": "<script>console.log('xss')</script>Description here",
        }
        res = self.staff.post("/api/admin/content/help/categories/", cat_payload, format="json")
        self.assertEqual(res.status_code, 201)
        data = res.json()
        self.assertEqual(data["title"], "Wallet Help")
        self.assertEqual(data["description"], "console.log('xss')Description here")

    def test_help_article_input_sanitizes_html_xss(self):
        cat = HelpCategory.objects.create(title="General", order=1)
        article_payload = {
            "category": cat.id,
            "title": "<h1>How to Pay?</h1>",
            "body": "<script>alert('body')</script>Follow the steps.",
        }
        res = self.staff.post("/api/admin/content/help/articles/", article_payload, format="json")
        self.assertEqual(res.status_code, 201)
        data = res.json()
        self.assertEqual(data["title"], "How to Pay?")
        self.assertEqual(data["body"], "alert('body')Follow the steps.")
