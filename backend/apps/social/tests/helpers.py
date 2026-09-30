from itertools import count

from django.contrib.auth import get_user_model
from django.core.cache import cache
from rest_framework.test import APITestCase

User = get_user_model()
_seq = count(1)


def make_user(username=None, **extra):
    n = next(_seq)
    username = username or f"walker{n:04d}"
    return User.objects.create_user(
        username=username,
        email=f"{username}@example.com",
        phone_number=f"2547{n:08d}",
        password=None,  # unusable password: no slow hashing in tests
        **extra,
    )


def befriend(a, b):
    from apps.social.models import Friendship

    Friendship.objects.get_or_create(user=a, friend=b)
    Friendship.objects.get_or_create(user=b, friend=a)


class SocialAPITestCase(APITestCase):
    def setUp(self):
        cache.clear()  # throttles + cached settings

    def as_user(self, user):
        self.client.force_authenticate(user=user)
        return self.client
