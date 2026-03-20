from rest_framework import viewsets, status, permissions, serializers
from rest_framework.decorators import action
from rest_framework.response import Response
from drf_spectacular.utils import extend_schema, extend_schema_view, inline_serializer
from drf_spectacular.types import OpenApiTypes
from django.utils import timezone
from django.db.models import Q, Sum
from datetime import timedelta

from apps.gamification.models import Badge, UserBadge, XPEvent, LevelMilestone, DailyLoginStreak
from apps.gamification.serializers import (
    BadgeSerializer,
    UserBadgeSerializer,
    XPEventSerializer,
    LevelMilestoneSerializer,
    DailyLoginStreakSerializer,
    UserGamificationSummarySerializer,
    UserXPSerializer,
)
from apps.users.models import UserXP


class BadgeViewSet(viewsets.ReadOnlyModelViewSet):
    """
    Badge definitions and user badge tracking
    """
    queryset = Badge.objects.all()
    serializer_class = BadgeSerializer
    permission_classes = [permissions.IsAuthenticated]
    lookup_field = 'slug'

    @action(detail=False, methods=['get'])
    def my_badges(self, request):
        """Get current user's earned badges"""
        badges = UserBadge.objects.filter(user=request.user).select_related('badge')
        serializer = UserBadgeSerializer(badges, many=True)
        return Response(serializer.data)

    @action(detail=False, methods=['get'])
    def upcoming(self, request):
        """Get badges user hasn't earned yet with progress"""
        earned_badges = UserBadge.objects.filter(user=request.user).values_list('badge_id')
        all_badges = Badge.objects.exclude(id__in=earned_badges)
        serializer = BadgeSerializer(all_badges, many=True)
        return Response(serializer.data)

    @action(detail=True, methods=['post'], permission_classes=[permissions.IsAdminUser])
    def award_to_user(self, request, slug=None):
        """Admin endpoint to award badge to user"""
        badge = self.get_object()
        user_id = request.data.get('user_id')
        
        if not user_id:
            return Response(
                {'error': 'user_id is required'},
                status=status.HTTP_400_BAD_REQUEST
            )
        
        try:
            user_badge, created = UserBadge.objects.get_or_create(
                user_id=user_id,
                badge=badge
            )
            serializer = UserBadgeSerializer(user_badge)
            return Response(
                serializer.data,
                status=status.HTTP_201_CREATED if created else status.HTTP_200_OK
            )
        except Exception as e:
            return Response(
                {'error': str(e)},
                status=status.HTTP_400_BAD_REQUEST
            )


@extend_schema_view(
    my_xp=extend_schema(responses={200: UserXPSerializer}),
    leaderboard=extend_schema(responses={200: UserXPSerializer(many=True)}),
    award_xp=extend_schema(responses={200: OpenApiTypes.OBJECT}),
)
class UserXPViewSet(viewsets.ViewSet):
    """
    User XP and level endpoint
    """
    permission_classes = [permissions.IsAuthenticated]
    serializer_class = UserXPSerializer

    @extend_schema(responses={200: UserXPSerializer})
    @action(detail=False, methods=['get'])
    def my_xp(self, request):
        """Get current user's XP profile"""
        try:
            xp_profile = UserXP.objects.get(user=request.user)
        except UserXP.DoesNotExist:
            xp_profile = UserXP.objects.create(user=request.user)
        
        serializer = UserXPSerializer(xp_profile)
        return Response(serializer.data)

    @extend_schema(responses={200: UserXPSerializer(many=True)})
    @action(detail=False, methods=['get'])
    def leaderboard(self, request):
        """Get top users by XP"""
        limit = request.query_params.get('limit', 10)
        try:
            limit = int(limit)
        except ValueError:
            limit = 10

        top_users = UserXP.objects.order_by('-level', '-total_xp')[:limit]
        serializer = UserXPSerializer(top_users, many=True)
        return Response(serializer.data)

    @extend_schema(responses={200: OpenApiTypes.OBJECT})
    @action(detail=False, methods=['post'], permission_classes=[permissions.IsAdminUser])
    def award_xp(self, request):
        """Admin endpoint to award XP to a user"""
        user_id = request.data.get('user_id')
        amount = request.data.get('amount', 0)
        reason = request.data.get('reason', 'manual_award')

        if not user_id or not amount:
            return Response(
                {'error': 'user_id and amount are required'},
                status=status.HTTP_400_BAD_REQUEST
            )

        try:
            xp_profile = UserXP.objects.get(user_id=user_id)
            result = xp_profile.add_xp(int(amount), source=reason)
            
            # Create XP event
            XPEvent.objects.create(
                user_id=user_id,
                event_type='manual_award',
                amount=int(amount),
                description=reason,
            )

            serializer = UserXPSerializer(xp_profile)
            return Response({
                'xp_profile': serializer.data,
                'result': result,
            })
        except UserXP.DoesNotExist:
            return Response(
                {'error': 'User not found'},
                status=status.HTTP_404_NOT_FOUND
            )


class XPEventViewSet(viewsets.ReadOnlyModelViewSet):
    """
    XP event history
    """
    queryset = XPEvent.objects.all()
    serializer_class = XPEventSerializer
    permission_classes = [permissions.IsAuthenticated]

    def get_queryset(self):
        """Only show own events unless admin"""
        if self.request.user.is_staff:
            return XPEvent.objects.all()
        return XPEvent.objects.filter(user=self.request.user)

    @action(detail=False, methods=['get'])
    def recent(self, request):
        """Get recent XP events for current user"""
        days = request.query_params.get('days', 7)
        try:
            days = int(days)
        except ValueError:
            days = 7

        since = timezone.now() - timedelta(days=days)
        events = self.get_queryset().filter(created_at__gte=since).order_by('-created_at')[:20]
        serializer = self.get_serializer(events, many=True)
        return Response(serializer.data)

    @action(detail=False, methods=['get'])
    def summary(self, request):
        """Get XP summary for current user"""
        today = timezone.now().date()
        week_ago = timezone.now() - timedelta(days=7)

        events = XPEvent.objects.filter(user=request.user)
        today_xp = events.filter(created_at__date=today).aggregate(
            total=Sum('amount')
        )['total'] or 0
        week_xp = events.filter(created_at__gte=week_ago).aggregate(
            total=Sum('amount')
        )['total'] or 0

        return Response({
            'today_xp': today_xp,
            'week_xp': week_xp,
            'total_events': events.count(),
        })


class LevelMilestoneViewSet(viewsets.ReadOnlyModelViewSet):
    """
    Level milestones tracking
    """
    queryset = LevelMilestone.objects.all()
    serializer_class = LevelMilestoneSerializer
    permission_classes = [permissions.IsAuthenticated]

    def get_queryset(self):
        if self.request.user.is_staff:
            return LevelMilestone.objects.all()
        return LevelMilestone.objects.filter(user=self.request.user)


@extend_schema_view(
    my_streak=extend_schema(responses={200: DailyLoginStreakSerializer}),
    check_in=extend_schema(responses={200: DailyLoginStreakSerializer}),
)
class DailyLoginStreakViewSet(viewsets.ViewSet):
    """
    Daily login streak management
    """
    permission_classes = [permissions.IsAuthenticated]
    serializer_class = DailyLoginStreakSerializer

    @extend_schema(responses={200: DailyLoginStreakSerializer})
    @action(detail=False, methods=['get'])
    def my_streak(self, request):
        """Get current user's login streak"""
        try:
            streak = DailyLoginStreak.objects.get(user=request.user)
        except DailyLoginStreak.DoesNotExist:
            streak = DailyLoginStreak.objects.create(user=request.user)

        serializer = DailyLoginStreakSerializer(streak)
        return Response(serializer.data)

    @extend_schema(responses={200: DailyLoginStreakSerializer})
    @action(detail=False, methods=['post'])
    def check_in(self, request):
        """Record a login and update streak"""
        from datetime import date
        
        try:
            streak = DailyLoginStreak.objects.get(user=request.user)
        except DailyLoginStreak.DoesNotExist:
            streak = DailyLoginStreak.objects.create(user=request.user)

        today = date.today()
        streak.update_streak(today)

        serializer = DailyLoginStreakSerializer(streak)
        return Response(serializer.data)


class GamificationSummaryViewSet(viewsets.ViewSet):
    """
    Complete gamification data for user
    """
    permission_classes = [permissions.IsAuthenticated]

    @extend_schema(responses={200: OpenApiTypes.OBJECT})
    @action(detail=False, methods=['get'])
    def my_gamification(self, request):
        """Get complete gamification profile"""
        user = request.user
        
        try:
            xp_profile = UserXP.objects.get(user=user)
        except UserXP.DoesNotExist:
            xp_profile = UserXP.objects.create(user=user)

        try:
            streak = DailyLoginStreak.objects.get(user=user)
        except DailyLoginStreak.DoesNotExist:
            streak = DailyLoginStreak.objects.create(user=user)

        earned_badge_ids = UserBadge.objects.filter(user=user).values_list('badge_id')
        upcoming_badges = Badge.objects.exclude(id__in=earned_badge_ids)[:5]

        level_milestones = LevelMilestone.objects.filter(user=user).order_by('-level')[:5]
        recent_xp_events = XPEvent.objects.filter(user=user).order_by('-created_at')[:10]

        return Response({
            'xp_profile': UserXPSerializer(xp_profile).data,
            'badges': UserBadgeSerializer(
                UserBadge.objects.filter(user=user),
                many=True
            ).data,
            'upcoming_badges': BadgeSerializer(upcoming_badges, many=True).data,
            'level_milestones': LevelMilestoneSerializer(level_milestones, many=True).data,
            'login_streak': DailyLoginStreakSerializer(streak).data,
            'recent_xp_events': XPEventSerializer(recent_xp_events, many=True).data,
        })
