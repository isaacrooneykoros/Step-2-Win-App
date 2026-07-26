from django.contrib.auth import get_user_model
from django.test import TestCase
from rest_framework import status
from rest_framework.test import APITestCase

from apps.legal.models import LegalDocument

User = get_user_model()


class LegalSecurityTestCase(APITestCase):
    """
    Security tests for LegalDocument creation and updates to prevent Stored XSS.
    """
    def setUp(self):
        # Create an admin user
        self.admin_user = User.objects.create_superuser(
            username='legal_admin',
            email='admin@example.com',
            password='TestPass123!',
            phone_number='254712345678'
        )
        self.client.force_authenticate(user=self.admin_user)

    def test_create_document_sanitizes_html_xss(self):
        """
        Verify that creating a legal document with malicious HTML (Stored XSS)
        strips the dangerous elements like script tags but retains safe elements.
        """
        malicious_html = "<p>Welcome to Step2Win.</p><script>alert('XSS')</script><div>Safe content</div>"

        response = self.client.post(
            '/api/legal/admin/documents/create/',
            {
                'title': 'Test Security Policy',
                'slug': 'test-security-policy',
                'document_type': 'privacy_policy',
                'content_html': malicious_html,
                'status': 'draft',
            },
            format='json'
        )

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        doc = LegalDocument.objects.get(slug='test-security-policy')

        # Verify the script tags are stripped and safe tags are kept
        self.assertNotIn('<script>', doc.content_html)
        self.assertIn('<p>Welcome to Step2Win.</p>', doc.content_html)
        self.assertIn('<div>Safe content</div>', doc.content_html)

    def test_update_document_sanitizes_html_xss(self):
        """
        Verify that updating a legal document with malicious HTML (Stored XSS)
        strips dangerous tags like onerror attributes.
        """
        doc = LegalDocument.objects.create(
            title='Update Policy',
            slug='update-policy',
            document_type='terms_conditions',
            content_html='<p>Initial content</p>',
            status='draft',
        )

        malicious_html = "<img src='x' onerror='alert(1)'> <p>Updated paragraph</p>"

        response = self.client.patch(
            f'/api/legal/admin/documents/{doc.id}/',
            {
                'content_html': malicious_html,
            },
            format='json'
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        doc.refresh_from_db()

        # Verify img tag is stripped of dangerous attribute or stripped entirely (depending on bleach setup)
        self.assertNotIn('onerror', doc.content_html)
        self.assertIn('<p>Updated paragraph</p>', doc.content_html)
