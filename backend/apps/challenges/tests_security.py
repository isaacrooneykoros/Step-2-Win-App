from django.contrib.auth import get_user_model
from django.test import TestCase
from rest_framework import status
from rest_framework.test import APIClient

User = get_user_model()


class MalformedChallengeIDSecurityTests(TestCase):
    """
    Security tests to verify that passing malformed / invalid challenge IDs
    returns a proper HTTP 404 Not Found response instead of an unhandled HTTP 500 error.
    """

    def setUp(self):
        self.client = APIClient()
        self.user = User.objects.create_user(
            username="testsecurityuser",
            email="security@example.com",
            phone_number="254712345678",
            password="Password123!",
        )
        self.client.force_authenticate(user=self.user)

    def test_leaderboard_malformed_id_returns_404(self):
        response = self.client.get("/api/challenges/invalid_id/leaderboard/")
        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)

    def test_challenge_stats_malformed_id_returns_404(self):
        response = self.client.get("/api/challenges/invalid_id/stats/")
        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)

    def test_leave_challenge_malformed_id_returns_404(self):
        response = self.client.post("/api/challenges/invalid_id/leave/")
        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)

    def test_rematch_challenge_malformed_id_returns_404(self):
        response = self.client.post("/api/challenges/invalid_id/rematch/")
        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)

    def test_challenge_chat_malformed_id_returns_404(self):
        response = self.client.get("/api/challenges/invalid_id/chat/")
        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)

    def test_challenge_social_stats_malformed_id_returns_404(self):
        response = self.client.get("/api/challenges/invalid_id/social-stats/")
        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)

    def test_challenge_lobby_card_malformed_id_returns_404(self):
        response = self.client.get("/api/challenges/lobby/invalid_id/")
        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)

    def test_spectator_leaderboard_malformed_id_returns_404(self):
        response = self.client.get("/api/challenges/invalid_id/spectate/")
        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)

    def test_challenge_results_malformed_id_returns_404(self):
        response = self.client.get("/api/challenges/invalid_id/results/")
        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)
