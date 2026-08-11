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
                'phone_number': f"2547{random.randint(10000000, 99999999)}",
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

    def test_profile_update_validation_and_sanitization(self):
        u1_username = f"u1_{random.randint(100000, 999999)}"
        u1_phone = f"2547{random.randint(10000000, 99999999)}"
        u1 = User.objects.create_user(
            username=u1_username,
            email=f"{u1_username}@example.com",
            password='TestPass123!',
            phone_number=u1_phone,
        )

        u2_username = f"u2_{random.randint(100000, 999999)}"
        u2_phone = f"2547{random.randint(10000000, 99999999)}"
        u2 = User.objects.create_user(
            username=u2_username,
            email=f"{u2_username}@example.com",
            password='TestPass123!',
            phone_number=u2_phone,
        )

        self.client.force_authenticate(user=u2)

        valid_username = f"valid_new_{random.randint(100000, 999999)}"
        response = self.client.patch('/api/auth/profile/', {'username': valid_username}, format='json')
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        u2.refresh_from_db()
        self.assertEqual(u2.username, valid_username)

        bad_usernames = ['new username', 'attacker<script>', 'a', 'x'*40]
        for bad_uname in bad_usernames:
            response = self.client.patch('/api/auth/profile/', {'username': bad_uname}, format='json')
            self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)

        response = self.client.patch('/api/auth/profile/', {'email': u1.email}, format='json')
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)

        response = self.client.patch('/api/auth/profile/', {'phone_number': u1.phone_number}, format='json')
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)

        response = self.client.patch('/api/auth/profile/', {'phone_number': 'not_a_phone'}, format='json')
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
