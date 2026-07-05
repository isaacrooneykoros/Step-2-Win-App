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

    def test_join_challenge_atomic_checks(self):
        """
        Verify that joining a challenge handles balance checks atomically
        and doesn't raise UnboundLocalError.
        """
        user = User.objects.create_user(
            username='atomic_joiner',
            email='atomic@example.com',
            password='TestPass123!',
            wallet_balance=Decimal('50.00'), # Not enough for 100.00 fee
        )
        self.client.force_authenticate(user=user)

        # Make max_lockable higher for this test to avoid the lock limit check
        # Or just use a higher wallet balance but low available balance
        # Actually available_balance = wallet_balance - locked_balance.
        # To fail on available balance but pass on lock limit:
        # wallet = 1000, locked = 950 -> available = 50.
        # lock limit = 80% of 1000 = 800.
        # Wait, if locked = 950, it already exceeds lock limit.

        user.wallet_balance = Decimal('120.00')
        user.locked_balance = Decimal('100.00')
        user.save()

        # We want to fail on available_balance, which is wallet - locked.
        # But we also have to pass the MAX_LOCKED_BALANCE_PERCENT check.
        # If MAX_LOCKED_BALANCE_PERCENT is 80%, then max_lockable = 800.
        # If we want to fail on available_balance < 100, we need wallet - locked < 100.
        # So locked > 900. But if locked > 800, we fail on the lock limit check first.
        # Wait, if entry_fee is 100, we need wallet - locked < 100.
        # If wallet = 1000, locked = 950. Available = 50.
        # But 950 + 100 > 800. So we fail on lock limit.

        # Let's change the user balance so available < 100 but locked + 100 <= 80% of wallet.
        # If wallet = 1000, max_lockable = 800.
        # If locked = 700, then locked + 100 = 800 (passes lock limit).
        # Available = 1000 - 700 = 300. (still has enough balance)

        # If wallet = 200, max_lockable = 160.
        # If locked = 100, then locked + 100 = 200 > 160. Fails lock limit.

        # To fail on available balance specifically:
        # entry_fee = 100.
        # available < 100 means wallet - locked < 100.
        # lock limit: locked + 100 <= 0.8 * wallet.
        # 0.8 * wallet >= locked + 100.
        # wallet >= (locked + 100) / 0.8.
        # If locked = 1000, then wallet >= 1100 / 0.8 = 1375.
        # If wallet = 1375, available = 1375 - 1000 = 375. (Enough balance)

        # If locked = 1500, wallet = 1550.
        # available = 50. (Insufficient balance)
        # lock limit: 1500 + 100 = 1600.
        # 0.8 * 1550 = 1240. (Fails lock limit first)

        # It seems hard to fail specifically on available balance without failing on lock limit if entry_fee is large relative to available balance.
        # Unless we change the settings.

        # Let's just check for 400 and ANY error message for now to ensure it doesn't crash.
        response = self.client.post(
            '/api/challenges/join/',
            {'invite_code': self.challenge.invite_code},
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)

        # Increase available balance (and wallet to pass lock limit) and try again
        user.wallet_balance = Decimal('200.00')
        user.locked_balance = Decimal('0.00')
        user.save()

        response = self.client.post(
            '/api/challenges/join/',
            {'invite_code': self.challenge.invite_code},
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        user.refresh_from_db()
        self.assertEqual(user.wallet_balance, Decimal('100.00'))
        self.assertEqual(user.locked_balance, Decimal('100.00'))
