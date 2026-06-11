import json
from rest_framework.test import APITestCase
from django.urls import reverse
from django.contrib.auth import get_user_model
from apps.challenges.models import Challenge, Participant, ChallengeMessage
from datetime import date, timedelta

User = get_user_model()

class ChallengeXSSSTest(APITestCase):
    def setUp(self):
        self.user = User.objects.create_user(username='testuser', password='password123', email='test@example.com', phone_number='254712345678')
        self.client.force_authenticate(user=self.user)

        self.challenge = Challenge.objects.create(
            name='Test Challenge',
            creator=self.user,
            milestone=50000,
            entry_fee=10.0,
            start_date=date.today(),
            end_date=date.today() + timedelta(days=7),
            is_private=True
        )
        Participant.objects.create(challenge=self.challenge, user=self.user)

    def test_challenge_chat_xss_rest_api(self):
        url = reverse('challenges:chat', kwargs={'pk': self.challenge.id})
        payload = {'content': '<script>alert("XSS")</script>Hello'}

        response = self.client.post(url, data=json.dumps(payload), content_type='application/json')
        self.assertEqual(response.status_code, 201)

        # Check if stored message is sanitized
        message = ChallengeMessage.objects.get(id=response.data['id'])
        # If not sanitized, it will contain the script tag
        self.assertNotIn('<script>', message.message)
        # bleach strips the tags but leaves the content of the tag if it's not a known tag
        # wait, <script> content is usually stripped by bleach if it's in the tags list but disallowed.
        # let's check what bleach.clean('<script>alert("XSS")</script>Hello', tags=[], strip=True) returns.
        # it should return 'alert("XSS")Hello' if it just strips tags.
        self.assertEqual(message.message, 'alert("XSS")Hello')

    def test_challenge_chat_get_is_sanitized(self):
        # Manually create unsanitized message (simulating old data or bypass)
        ChallengeMessage.objects.create(
            challenge=self.challenge,
            user=self.user,
            message='<img src=x onerror=alert(1)>Sanitized'
        )

        url = reverse('challenges:chat', kwargs={'pk': self.challenge.id})
        response = self.client.get(url)
        self.assertEqual(response.status_code, 200)

        for msg in response.data['messages']:
            self.assertNotIn('<img', msg['content'])
            self.assertNotIn('onerror', msg['content'])
