from django.urls import include, path
from rest_framework.routers import DefaultRouter

from apps.gamification.views import (BadgeViewSet, DailyLoginStreakViewSet,
                                     GamificationSummaryViewSet,
                                     LevelMilestoneViewSet, UserXPViewSet,
                                     XPEventViewSet)

router = DefaultRouter()
router.register(r"badges", BadgeViewSet, basename="badge")
router.register(r"xp", UserXPViewSet, basename="xp")
router.register(r"events", XPEventViewSet, basename="xp-event")
router.register(r"milestones", LevelMilestoneViewSet, basename="level-milestone")
router.register(r"streaks", DailyLoginStreakViewSet, basename="daily-login-streak")
router.register(
    r"gamification", GamificationSummaryViewSet, basename="gamification-summary"
)

app_name = "gamification"

urlpatterns = [
    path("", include(router.urls)),
]
