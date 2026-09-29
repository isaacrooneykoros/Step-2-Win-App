"""Rate limits for social endpoints (rates in settings.REST_FRAMEWORK DEFAULT_THROTTLE_RATES)."""

from rest_framework.throttling import UserRateThrottle


class SocialSearchThrottle(UserRateThrottle):
    """Username / code lookups: slows down anyone trying to enumerate accounts."""

    scope = "social_search"


class FriendRequestThrottle(UserRateThrottle):
    scope = "social_friend_request"


class SocialWriteThrottle(UserRateThrottle):
    scope = "social_write"


class SocialReportThrottle(UserRateThrottle):
    scope = "social_report"
