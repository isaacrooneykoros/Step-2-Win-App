from django.contrib.auth import get_user_model
from rest_framework import status
from rest_framework.test import APITestCase
from apps.legal.models import LegalDocument

User = get_user_model()


class LegalSecurityTests(APITestCase):
    def setUp(self):
        # Create an admin user to access admin endpoints
        self.admin_user = User.objects.create_superuser(
            username='legal_admin',
            email='admin@example.com',
            password='TestPass123!',
            phone_number='0711111111'
        )
        self.client.force_authenticate(user=self.admin_user)

    def test_create_document_html_sanitization(self):
        """
        Verify that HTML payloads containing script tags and other XSS vectors
        are sanitized, while allowed tags are preserved.
        """
        payload = {
            'document_type': 'terms_and_conditions',
            'title': 'Terms and Conditions',
            'content_html': '<h1>ToS</h1><p>Welcome to our app. <script>alert("XSS")</script></p>'
        }
        response = self.client.post('/api/legal/admin/documents/create/', payload, format='json')
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)

        # Verify from database that script was stripped and safe tags are kept
        doc = LegalDocument.objects.get(id=response.data['id'])
        self.assertNotIn('<script>', doc.content_html)
        self.assertIn('<h1>ToS</h1>', doc.content_html)
        self.assertIn('<p>Welcome to our app.', doc.content_html)

    def test_update_document_html_sanitization(self):
        """
        Verify that update payloads are also sanitized against Stored XSS.
        """
        doc = LegalDocument.objects.create(
            document_type='privacy_policy',
            title='Privacy Policy',
            slug='privacy-policy',
            content_html='<p>Old content</p>',
            last_edited_by=self.admin_user
        )

        update_payload = {
            'content_html': '<div>Safe div</div><iframe src="unsafe.com"></iframe>'
        }
        response = self.client.patch(f'/api/legal/admin/documents/{doc.id}/', update_payload, format='json')
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        doc.refresh_from_db()
        self.assertNotIn('<iframe>', doc.content_html)
        self.assertIn('<div>Safe div</div>', doc.content_html)
