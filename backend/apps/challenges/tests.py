from datetime import date, timedelta
from decimal import Decimal

from django.contrib.auth import get_user_model
from rest_framework import status
from rest_framework.test import APITestCase

from apps.challenges.models import Challenge, Participant


User = get_user_model()


class ChallengeIntegrationTests(APITestCase):
    def setUp(self):
        self.owner = User.objects.create_user(
            username='challenge_owner',
            email='owner@example.com',
            password='TestPass123!',
            wallet_balance=Decimal('1000.00'),
        )
        self.joiner = User.objects.create_user(
            username='challenge_joiner',
            email='joiner@example.com',
            password='TestPass123!',
            wallet_balance=Decimal('1000.00'),
        )
        self.challenge = Challenge.objects.create(
            name='Integration Challenge',
            creator=self.owner,
            milestone=50000,
            entry_fee=Decimal('100.00'),
            total_pool=Decimal('100.00'),
            max_participants=10,
            status='active',
            start_date=date.today(),
            end_date=date.today() + timedelta(days=7),
            is_private=False,
            is_public=True,
        )
        Participant.objects.create(challenge=self.challenge, user=self.owner)

    def test_join_challenge_deducts_balance_and_adds_participant(self):
        self.client.force_authenticate(user=self.joiner)

        response = self.client.post(
            '/api/challenges/join/',
            {'invite_code': self.challenge.invite_code},
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)

        self.joiner.refresh_from_db()
        self.challenge.refresh_from_db()

        self.assertTrue(
            Participant.objects.filter(challenge=self.challenge, user=self.joiner).exists()
        )
        self.assertEqual(self.joiner.wallet_balance, Decimal('900.00'))
        self.assertEqual(self.joiner.locked_balance, Decimal('100.00'))
        self.assertEqual(self.challenge.total_pool, Decimal('200.00'))

    def test_challenge_chat_xss_protection(self):
        """
        Verify that challenge chat messages are sanitized to prevent Stored XSS
        """
        # Create a private challenge for chat testing
        private_challenge = Challenge.objects.create(
            name='Private Chat Challenge',
            creator=self.owner,
            milestone=50000,
            entry_fee=Decimal('100.00'),
            is_private=True,
            is_public=False,
            status='active',
            start_date=date.today(),
            end_date=date.today() + timedelta(days=7),
        )
        Participant.objects.create(challenge=private_challenge, user=self.owner)

        self.client.force_authenticate(user=self.owner)

        # Stored XSS payload
        xss_payload = "Hello <script>alert('XSS')</script> <img src=x onerror=alert(1)>"

        url = f'/api/challenges/{private_challenge.id}/chat/'
        response = self.client.post(url, {'content': xss_payload}, format='json')

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)

        # Verify stored content is sanitized
        from apps.challenges.models import ChallengeMessage
        msg = ChallengeMessage.objects.get(id=response.data['id'])

        self.assertNotIn('<script>', msg.message)
        self.assertNotIn('onerror', msg.message)
        self.assertIn('Hello', msg.message)

    def test_create_challenge_creates_participant_and_locks_balance(self):
        creator = User.objects.create_user(
            username='challenge_creator_new',
            email='challenge_creator_new@example.com',
            password='TestPass123!',
            wallet_balance=Decimal('500.00'),
            challenges_joined=1,
        )
        self.client.force_authenticate(user=creator)

        response = self.client.post(
            '/api/challenges/create/',
            {
                'name': 'Creator Flow Challenge',
                'description': 'Created in integration test',
                'milestone': 50000,
                'entry_fee': '100',
                'max_participants': 10,
                'duration_days': 7,
                'is_public': True,
                'theme_emoji': '🔥',
            },
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)

        creator.refresh_from_db()
        created = Challenge.objects.get(id=response.data['id'])

        self.assertEqual(creator.wallet_balance, Decimal('400.00'))
        self.assertEqual(creator.locked_balance, Decimal('100.00'))
        self.assertEqual(created.total_pool, Decimal('100.00'))
        self.assertTrue(Participant.objects.filter(challenge=created, user=creator).exists())
