from rest_framework.test import APITestCase
from rest_framework import status
from django.contrib.auth import get_user_model
from apps.users.models import UserXP
from apps.gamification.models import XPEvent

User = get_user_model()


class AwardXPSecurityTests(APITestCase):
    def setUp(self):
        self.admin = User.objects.create_superuser(
            username='adminuser',
            email='admin@example.com',
            password='Password123!',
            phone_number='254711111111'
        )
        self.regular_user = User.objects.create_user(
            username='regularuser',
            email='regular@example.com',
            password='Password123!',
            phone_number='254722222222'
        )
        self.xp_profile, _ = UserXP.objects.get_or_create(user=self.regular_user)

    def test_award_xp_sanitizes_html_reason(self):
        self.client.force_authenticate(user=self.admin)
        xss_payload = '<script>alert("xss")</script>Bonus Rewards'
        payload = {
            'user_id': self.regular_user.id,
            'amount': 500,
            'reason': xss_payload,
        }
        response = self.client.post('/api/gamification/xp/award_xp/', payload, format='json')
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        event = XPEvent.objects.get(user=self.regular_user, amount=500)
        self.assertNotIn('<script>', event.description)
        self.assertEqual(event.description, 'alert("xss")Bonus Rewards')

    def test_award_xp_validates_amount_range_and_type(self):
        self.client.force_authenticate(user=self.admin)

        # Negative amount
        res1 = self.client.post('/api/gamification/xp/award_xp/', {
            'user_id': self.regular_user.id,
            'amount': -100
        }, format='json')
        self.assertEqual(res1.status_code, status.HTTP_400_BAD_REQUEST)

        # Exceeds max amount limit (100,000)
        res2 = self.client.post('/api/gamification/xp/award_xp/', {
            'user_id': self.regular_user.id,
            'amount': 500000
        }, format='json')
        self.assertEqual(res2.status_code, status.HTTP_400_BAD_REQUEST)

        # Non-integer amount
        res3 = self.client.post('/api/gamification/xp/award_xp/', {
            'user_id': self.regular_user.id,
            'amount': 'not_a_number'
        }, format='json')
        self.assertEqual(res3.status_code, status.HTTP_400_BAD_REQUEST)

    def test_award_xp_requires_admin_permission(self):
        self.client.force_authenticate(user=self.regular_user)
        response = self.client.post('/api/gamification/xp/award_xp/', {
            'user_id': self.regular_user.id,
            'amount': 100
        }, format='json')
        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)
