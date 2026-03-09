from rest_framework import serializers
from apps.gamification.models import Badge, UserBadge, XPEvent, LevelMilestone, DailyLoginStreak
from apps.users.models import UserXP


class UserXPSerializer(serializers.ModelSerializer):
    level_progress = serializers.SerializerMethodField()
    xp_to_next_level = serializers.SerializerMethodField()
    xp_for_next_level = serializers.SerializerMethodField()

    class Meta:
        model = UserXP
        fields = [
            'id',
            'user',
            'level',
            'total_xp',
            'xp_this_week',
            'weekly_reset',
            'level_progress',
            'xp_to_next_level',
            'xp_for_next_level',
            'created_at',
            'updated_at',
        ]
        read_only_fields = ['id', 'user', 'created_at', 'updated_at']

    def get_level_progress(self, obj):
        """Get current level progress percentage"""
        return obj.get_level_progress()

    def get_xp_to_next_level(self, obj):
        """Get remaining XP needed for next level"""
        return obj.get_xp_to_next_level()

    def get_xp_for_next_level(self, obj):
        """Get total XP required for next level"""
        return obj.get_xp_for_next_level()


class BadgeSerializer(serializers.ModelSerializer):
    class Meta:
        model = Badge
        fields = [
            'id',
            'slug',
            'name',
            'description',
            'icon',
            'badge_type',
            'color',
            'criteria_type',
            'criteria_value',
        ]
        read_only_fields = ['id']


class UserBadgeSerializer(serializers.ModelSerializer):
    badge = BadgeSerializer(read_only=True)
    
    class Meta:
        model = UserBadge
        fields = [
            'id',
            'badge',
            'earned_at',
            'is_new',
        ]
        read_only_fields = ['id', 'earned_at', 'badge']


class XPEventSerializer(serializers.ModelSerializer):
    event_type_display = serializers.CharField(source='get_event_type_display', read_only=True)
    
    class Meta:
        model = XPEvent
        fields = [
            'id',
            'user',
            'event_type',
            'event_type_display',
            'amount',
            'challenge',
            'description',
            'metadata',
            'created_at',
            'processed',
        ]
        read_only_fields = ['id', 'user', 'created_at']


class LevelMilestoneSerializer(serializers.ModelSerializer):
    reward_badge = BadgeSerializer(read_only=True)
    
    class Meta:
        model = LevelMilestone
        fields = [
            'id',
            'user',
            'level',
            'reached_at',
            'total_xp',
            'reward_badge',
        ]
        read_only_fields = ['id', 'user', 'reached_at']


class DailyLoginStreakSerializer(serializers.ModelSerializer):
    class Meta:
        model = DailyLoginStreak
        fields = [
            'id',
            'user',
            'current_streak',
            'longest_streak',
            'last_login_date',
            'total_logins',
            'created_at',
            'updated_at',
        ]
        read_only_fields = ['id', 'user', 'created_at', 'updated_at']


class UserGamificationSummarySerializer(serializers.Serializer):
    """
    Complete gamification data for a user
    """
    xp_profile = UserXPSerializer()
    badges = UserBadgeSerializer(many=True)
    upcoming_badges = BadgeSerializer(many=True)
    level_milestones = LevelMilestoneSerializer(many=True, source='level_milestones')
    login_streak = DailyLoginStreakSerializer()
    recent_xp_events = XPEventSerializer(many=True, source='xp_events')
