from rest_framework import serializers
from django.contrib.auth import get_user_model
from apps.challenges.models import Challenge
from apps.wallet.models import WalletTransaction, Withdrawal
from apps.gamification.models import Badge, UserBadge
from apps.users.models import UserXP
from apps.admin_api.models import SystemSettings, AuditLog, SupportTicket, SupportTicketMessage

User = get_user_model()


class AdminUserSerializer(serializers.ModelSerializer):
    """
    Admin serializer for user data with extended fields
    """
    xp_profile = serializers.SerializerMethodField()
    badges_count = serializers.SerializerMethodField()
    
    class Meta:
        model = User
        fields = [
            'id',
            'username',
            'email',
            'phone_number',
            'wallet_balance',
            'locked_balance',
            'total_steps',
            'challenges_won',
            'total_earned',
            'current_streak',
            'is_active',
            'is_staff',
            'device_platform',
            'xp_profile',
            'badges_count',
            'created_at',
            'updated_at',
        ]
        read_only_fields = [
            'id',
            'total_steps',
            'challenges_won',
            'total_earned',
            'current_streak',
            'created_at',
            'updated_at',
        ]

    def get_xp_profile(self, obj) -> dict | None:
        """Get user's XP profile"""
        try:
            xp = UserXP.objects.get(user=obj)
            return {
                'level': xp.level,
                'total_xp': xp.total_xp,
                'xp_this_week': xp.xp_this_week,
            }
        except UserXP.DoesNotExist:
            return None

    def get_badges_count(self, obj) -> int:
        """Get count of badges earned"""
        return UserBadge.objects.filter(user=obj).count()


class AdminChallengeSerializer(serializers.ModelSerializer):
    """
    Admin serializer for challenge data
    """
    created_by_username = serializers.CharField(source='creator.username', read_only=True)
    platform_fee = serializers.DecimalField(max_digits=12, decimal_places=2, read_only=True)
    current_entries = serializers.SerializerMethodField()
    
    class Meta:
        model = Challenge
        fields = [
            'id',
            'name',
            'description',
            'status',
            'creator',
            'created_by_username',
            'entry_fee',
            'total_pool',
            'platform_fee',
            'max_participants',
            'current_entries',
            'start_date',
            'end_date',
            'milestone',
            'invite_code',
            'is_private',
            'created_at',
            'updated_at',
        ]
        read_only_fields = [
            'id',
            'created_at',
            'updated_at',
            'platform_fee',
        ]

    def get_current_entries(self, obj) -> int:
        """Get current number of entries"""
        return obj.current_participants


class AdminTransactionSerializer(serializers.ModelSerializer):
    """
    Admin serializer for transaction data
    """
    user_username = serializers.CharField(source='user.username', read_only=True)
    
    class Meta:
        model = WalletTransaction
        fields = [
            'id',
            'user',
            'user_username',
            'type',
            'amount',
            'balance_before',
            'balance_after',
            'description',
            'reference_id',
            'metadata',
            'created_at',
        ]
        read_only_fields = [
            'id',
            'created_at',
        ]


class AdminWithdrawalSerializer(serializers.ModelSerializer):
    """
    Admin serializer for withdrawal data
    """
    user_username = serializers.CharField(source='user.username', read_only=True)
    approved_by_username = serializers.CharField(source='processed_by.username', read_only=True, allow_null=True)
    
    class Meta:
        model = Withdrawal
        fields = [
            'id',
            'user',
            'user_username',
            'amount',
            'account_details',
            'status',
            'processed_by',
            'approved_by_username',
            'admin_notes',
            'rejection_reason',
            'reference_number',
            'created_at',
            'processed_at',
        ]
        read_only_fields = [
            'id',
            'reference_number',
            'created_at',
            'processed_at',
        ]


class AdminBadgeSerializer(serializers.ModelSerializer):
    """
    Admin serializer for badge data
    """
    users_earned = serializers.SerializerMethodField()
    
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
            'users_earned',
            'created_at',
        ]
        read_only_fields = [
            'id',
            'created_at',
        ]

    def get_users_earned(self, obj) -> int:
        """Get count of users who earned this badge"""
        return UserBadge.objects.filter(badge=obj).count()


class DashboardStatsSerializer(serializers.Serializer):
    """
    Serializer for dashboard statistics
    """
    total_users = serializers.IntegerField()
    active_users = serializers.IntegerField()
    total_transactions = serializers.IntegerField()
    total_volume = serializers.DecimalField(max_digits=10, decimal_places=2)
    live_challenges = serializers.IntegerField()


class SystemSettingsSerializer(serializers.Serializer):
    """
    Serializer for system settings
    """
    # Platform Fees
    platform_fee_percentage = serializers.DecimalField(max_digits=5, decimal_places=2)
    
    # Withdrawal Settings
    minimum_withdrawal_amount = serializers.DecimalField(max_digits=10, decimal_places=2)
    withdrawal_processing_time = serializers.IntegerField()
    
    # Challenge Settings
    min_challenge_entry_fee = serializers.DecimalField(max_digits=10, decimal_places=2)
    max_challenge_entry_fee = serializers.DecimalField(max_digits=10, decimal_places=2)
    min_challenge_milestone = serializers.IntegerField()
    max_challenge_milestone = serializers.IntegerField()
    max_challenge_participants = serializers.IntegerField()
    challenge_approval_required = serializers.BooleanField()
    
    # Feature Toggles
    registrations_enabled = serializers.BooleanField()
    challenges_enabled = serializers.BooleanField()
    withdrawals_enabled = serializers.BooleanField()
    referral_program_enabled = serializers.BooleanField()
    
    # Gamification Settings
    xp_per_step = serializers.DecimalField(max_digits=5, decimal_places=2)
    daily_goal_bonus_xp = serializers.IntegerField()
    
    # Notifications
    admin_email = serializers.EmailField()
    support_email = serializers.EmailField()
    email_notifications_enabled = serializers.BooleanField()
    
    # Maintenance
    maintenance_mode = serializers.BooleanField()
    maintenance_message = serializers.CharField(allow_blank=True, required=False)
    
    # Metadata
    updated_at = serializers.DateTimeField(read_only=True)
    updated_by = serializers.SerializerMethodField()
    
    def get_updated_by(self, obj) -> str | None:
        """Get username of user who last updated settings"""
        if obj.updated_by:
            return obj.updated_by.username
        return None


class AuditLogSerializer(serializers.ModelSerializer):
    """Serializer for audit log entries"""
    
    class Meta:
        model = None  # Will be set dynamically
        fields = [
            'id',
            'admin_username',
            'action',
            'resource_type',
            'resource_id',
            'resource_name',
            'description',
            'changes',
            'ip_address',
            'created_at',
        ]
        read_only_fields = fields
    
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.Meta.model = AuditLog


class SupportTicketSerializer(serializers.ModelSerializer):
    """Serializer for support tickets in admin panel"""

    user_username = serializers.CharField(source='user.username', read_only=True)
    assigned_to_username = serializers.CharField(source='assigned_to.username', read_only=True, allow_null=True)
    message_count = serializers.SerializerMethodField()

    class Meta:
        model = SupportTicket
        fields = [
            'id',
            'user',
            'user_username',
            'subject',
            'category',
            'message',
            'status',
            'priority',
            'assigned_to',
            'assigned_to_username',
            'admin_notes',
            'resolved_at',
            'created_at',
            'updated_at',
            'message_count',
        ]
        read_only_fields = ['id', 'created_at', 'updated_at', 'resolved_at', 'message_count']

    def get_message_count(self, obj):
        return obj.messages.count()


class SupportTicketMessageSerializer(serializers.ModelSerializer):
    """Serializer for support ticket conversation messages"""

    class Meta:
        model = SupportTicketMessage
        fields = [
            'id',
            'ticket',
            'sender',
            'sender_username',
            'is_admin',
            'message',
            'created_at',
        ]
        read_only_fields = ['id', 'ticket', 'sender', 'sender_username', 'is_admin', 'created_at']
