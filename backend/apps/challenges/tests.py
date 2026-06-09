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
            challenges_joined=1,
            phone_number='254712345678',
        )
        self.joiner = User.objects.create_user(
            username='challenge_joiner',
            email='joiner@example.com',
            password='TestPass123!',
            wallet_balance=Decimal('1000.00'),
            challenges_joined=1,
            phone_number='254712345679',
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

    def test_create_challenge_creates_participant_and_locks_balance(self):
        creator = User.objects.create_user(
            username='challenge_creator_new',
            email='challenge_creator_new@example.com',
            password='TestPass123!',
            wallet_balance=Decimal('500.00'),
            challenges_joined=1,
            phone_number='254712345670',
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


class ChallengeSecurityTests(APITestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            username='security_user',
            email='security@example.com',
            password='TestPass123!',
            wallet_balance=Decimal('1000.00'),
            challenges_joined=1,
            phone_number='254712345671',
        )
        self.challenge = Challenge.objects.create(
            name='Security Challenge',
            creator=self.user,
            milestone=50000,
            entry_fee=Decimal('100.00'),
            total_pool=Decimal('100.00'),
            max_participants=10,
            status='active',
            start_date=date.today(),
            end_date=date.today() + timedelta(days=7),
            is_private=True,
        )
        Participant.objects.create(challenge=self.challenge, user=self.user)

    def test_join_challenge_unbound_local_error(self):
        # This user is NOT the owner
        other_user = User.objects.create_user(
            username='other_user',
            email='other@example.com',
            password='TestPass123!',
            wallet_balance=Decimal('1000.00'),
            challenges_joined=1,
            phone_number='254712345672',
        )
        self.client.force_authenticate(user=other_user)

        response = self.client.post(
            '/api/challenges/join/',
            {'invite_code': self.challenge.invite_code},
            format='json'
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)

    def test_challenge_chat_xss_protection(self):
        self.client.force_authenticate(user=self.user)

        xss_payload = "<script>alert('xss')</script>Hello"
        response = self.client.post(
            f'/api/challenges/{self.challenge.id}/chat/',
            {'content': xss_payload},
            format='json'
        )

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertNotIn('<script>', response.data['content'])
        self.assertNotIn('</script>', response.data['content'])
        self.assertEqual(response.data['content'], "alert('xss')Hello")
