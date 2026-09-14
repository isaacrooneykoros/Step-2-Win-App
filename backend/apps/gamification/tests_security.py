from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase
from rest_framework import status
from apps.users.models import UserXP
from apps.gamification.models import XPEvent

User = get_user_model()


class GamificationAwardXPSecurityTests(APITestCase):
    def setUp(self):
        self.admin = User.objects.create_user(
            username='admin_user',
            email='admin@example.com',
            password='TestPass123!',
            phone_number='254700000001',
            is_staff=True,
        )
        self.regular_user = User.objects.create_user(
            username='regular_user',
            email='user@example.com',
            password='TestPass123!',
            phone_number='254700000002',
        )
        self.user_xp, _ = UserXP.objects.get_or_create(user=self.regular_user)
        self.url = '/api/gamification/xp/award_xp/'

    def test_unauthenticated_award_xp_rejected(self):
        response = self.client.post(self.url, {'user_id': self.regular_user.id, 'amount': 100})
        self.assertEqual(response.status_code, status.HTTP_401_UNAUTHORIZED)

    def test_non_admin_award_xp_forbidden(self):
        self.client.force_authenticate(user=self.regular_user)
        response = self.client.post(self.url, {'user_id': self.regular_user.id, 'amount': 100})
        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)

    def test_admin_award_xp_sanitizes_xss_in_reason(self):
        self.client.force_authenticate(user=self.admin)
        payload = {
            'user_id': self.regular_user.id,
            'amount': 200,
            'reason': '<script>alert("XSS")</script>Community Event <b style="color:red">Bonus</b>',
        }
        response = self.client.post(self.url, payload, format='json')
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        event = XPEvent.objects.filter(user=self.regular_user).first()
        self.assertIsNotNone(event)
        self.assertNotIn('<script>', event.description)
        self.assertNotIn('<b>', event.description)
        self.assertEqual(event.description, 'alert("XSS")Community Event Bonus')

    def test_admin_award_xp_invalid_amount_rejected(self):
        self.client.force_authenticate(user=self.admin)

        # Negative amount
        res1 = self.client.post(self.url, {'user_id': self.regular_user.id, 'amount': -50})
        self.assertEqual(res1.status_code, status.HTTP_400_BAD_REQUEST)

        # Zero amount
        res2 = self.client.post(self.url, {'user_id': self.regular_user.id, 'amount': 0})
        self.assertEqual(res2.status_code, status.HTTP_400_BAD_REQUEST)

        # Excessively large amount
        res3 = self.client.post(self.url, {'user_id': self.regular_user.id, 'amount': 9999999})
        self.assertEqual(res3.status_code, status.HTTP_400_BAD_REQUEST)

        # Non-numeric amount
        res4 = self.client.post(self.url, {'user_id': self.regular_user.id, 'amount': 'invalid'})
        self.assertEqual(res4.status_code, status.HTTP_400_BAD_REQUEST)
