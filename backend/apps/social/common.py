"""Shared helpers: settings, the Nairobi calendar week, blocks, profiles, errors."""

from __future__ import annotations

from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from django.core.cache import cache
from django.db import IntegrityError, transaction
from django.db.models import Q
from django.utils import timezone

from .models import (SOCIAL_SETTINGS_CACHE_KEY, Block, SocialProfile,
                     SocialSettings, new_code)

# Weeks run Monday 00:00 to Sunday 24:00 in Kenya time, whatever the server zone.
SOCIAL_TZ = ZoneInfo("Africa/Nairobi")


class SocialError(Exception):
    """A refused social action. ``message`` is safe to show the user."""

    def __init__(self, code: str, message: str, status: int = 400):
        self.code = code
        self.message = message
        self.status = status
        super().__init__(message)


# ── settings ─────────────────────────────────────────────────────────────────


def social_settings() -> SocialSettings:
    cached = cache.get(SOCIAL_SETTINGS_CACHE_KEY)
    if cached is not None:
        return cached
    obj = SocialSettings.load()
    cache.set(SOCIAL_SETTINGS_CACHE_KEY, obj, 60)
    return obj


def require_social_enabled(feature: str | None = None) -> SocialSettings:
    s = social_settings()
    if not s.social_enabled:
        raise SocialError("social_disabled", "Friends and teams are switched off for now.", 503)
    if feature == "teams" and not s.teams_enabled:
        raise SocialError("teams_disabled", "Teams are switched off for now.", 503)
    if feature == "feed" and not s.feed_enabled:
        raise SocialError("feed_disabled", "The activity feed is switched off for now.", 503)
    return s


# ── calendar ─────────────────────────────────────────────────────────────────


def local_now(now: datetime | None = None) -> datetime:
    return (now or timezone.now()).astimezone(SOCIAL_TZ)


def local_today(now: datetime | None = None) -> date:
    return local_now(now).date()


def week_start_for(day: date) -> date:
    """Monday of the week containing ``day``."""
    return day - timedelta(days=day.weekday())


def current_week_start(now: datetime | None = None) -> date:
    return week_start_for(local_today(now))


def week_days(week_start: date) -> tuple[date, date]:
    return week_start, week_start + timedelta(days=6)


# ── profiles ─────────────────────────────────────────────────────────────────


def get_profile(user) -> SocialProfile:
    """The user's social profile, created on first use with a fresh friend code."""
    try:
        return user.social_profile
    except SocialProfile.DoesNotExist:
        pass
    for _ in range(6):
        try:
            with transaction.atomic():
                profile, _ = SocialProfile.objects.get_or_create(
                    user=user, defaults={"friend_code": new_code()}
                )
                return profile
        except IntegrityError:  # friend_code collision: try another
            existing = SocialProfile.objects.filter(user=user).first()
            if existing:
                return existing
    raise SocialError("profile_unavailable", "Please try again.", 503)


def profiles_for(user_ids) -> dict[int, SocialProfile]:
    return {p.user_id: p for p in SocialProfile.objects.filter(user_id__in=list(user_ids))}


# ── blocks ───────────────────────────────────────────────────────────────────


def is_blocked_between(a_id: int, b_id: int) -> bool:
    return Block.objects.filter(
        Q(blocker_id=a_id, blocked_id=b_id) | Q(blocker_id=b_id, blocked_id=a_id)
    ).exists()


def hidden_user_ids(user_id: int) -> set[int]:
    """Everyone this user blocked or was blocked by: hidden from each other everywhere."""
    ids = set()
    for blocker_id, blocked_id in Block.objects.filter(
        Q(blocker_id=user_id) | Q(blocked_id=user_id)
    ).values_list("blocker_id", "blocked_id"):
        ids.add(blocked_id if blocker_id == user_id else blocker_id)
    return ids


def is_visible_account(user) -> bool:
    return bool(user and user.is_active and getattr(user, "deleted_at", None) is None)


def public_user(user, request=None) -> dict:
    """The only user fields social ever exposes: id, username, photo."""
    from apps.core.url_utils import build_absolute_media_url

    photo = None
    if getattr(user, "profile_picture", None):
        try:
            photo = build_absolute_media_url(user.profile_picture.url, request)
        except Exception:
            photo = None
    return {"id": user.id, "username": user.username, "profile_picture_url": photo}
