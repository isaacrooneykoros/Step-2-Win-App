import random

from django.contrib.auth import get_user_model
from rest_framework import status
from rest_framework.test import APITestCase


User = get_user_model()


class AuthAndHealthTests(APITestCase):
    def test_health_endpoint_returns_ok(self):
        response = self.client.get('/api/health/')

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data.get('status'), 'ok')

    def test_register_login_and_profile_flow(self):
        username = f"testuser_{random.randint(100000, 999999)}"
        password = 'TestPass123!'

        register_response = self.client.post(
            '/api/auth/register/',
            {
                'username': username,
                'email': f'{username}@example.com',
                'password': password,
                'confirm_password': password,
            },
            format='json',
        )
        self.assertEqual(register_response.status_code, status.HTTP_201_CREATED)
        self.assertIn('access', register_response.data)

        login_response = self.client.post(
            '/api/auth/login/',
            {
                'username': username,
                'password': password,
            },
            format='json',
        )
        self.assertEqual(login_response.status_code, status.HTTP_200_OK)
        access = login_response.data.get('access')
        self.assertTrue(access)

        self.client.credentials(HTTP_AUTHORIZATION=f'Bearer {access}')
        profile_response = self.client.get('/api/auth/profile/')
        self.assertEqual(profile_response.status_code, status.HTTP_200_OK)
        self.assertEqual(profile_response.data.get('username'), username)
