from rest_framework import serializers
from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError as DjangoValidationError
from .models import User
from apps.admin_api.models import SupportTicket, SupportTicketMessage
from apps.core.image_utils import validate_and_normalize_profile_picture
from apps.core.sanitizers import sanitize_username, sanitize_text
from apps.core.url_utils import build_absolute_media_url


class RegisterSerializer(serializers.ModelSerializer):
    """
    Serializer for user registration
    """
    password = serializers.CharField(
        write_only=True, 
        validators=[validate_password],
        style={'input_type': 'password'}
    )
    confirm_password = serializers.CharField(
        write_only=True,
        style={'input_type': 'password'}
    )

    class Meta:
        model = User
        fields = ['username', 'email', 'phone_number', 'password', 'confirm_password']

    def validate(self, data):
        if data['password'] != data['confirm_password']:
            raise serializers.ValidationError({
                'confirm_password': 'Passwords do not match'
            })
        return data

    def validate_email(self, value):
        if not value:
            raise serializers.ValidationError('Email is required')
        normalized = str(value).lower().strip()
        if User.objects.filter(email=normalized).exists():
            raise serializers.ValidationError('Email already registered')
        return normalized

    def validate_username(self, value):
        if not value:
            raise serializers.ValidationError('Username is required')
        try:
            cleaned = sanitize_username(value)
        except DjangoValidationError as e:
            raise serializers.ValidationError(e.message)
        if User.objects.filter(username=cleaned).exists():
            raise serializers.ValidationError('Username already taken')
        return cleaned

    def validate_phone_number(self, value):
        if not value:
            raise serializers.ValidationError('Phone number is required')
        # Basic phone validation - should be digits and +/- only
        phone_clean = value.replace('+', '').replace('-', '').replace(' ', '')
        if not phone_clean.isdigit() or len(phone_clean) < 9:
            raise serializers.ValidationError('Phone number must be at least 9 digits')
        if User.objects.filter(phone_number=value).exists():
            raise serializers.ValidationError('Phone number already registered')
        return value

    def create(self, validated_data):
        validated_data.pop('confirm_password')
        user = User.objects.create_user(**validated_data)
        return user


class UserProfileSerializer(serializers.ModelSerializer):
    """
    Serializer for user profile data
    """
    device_bound = serializers.SerializerMethodField()
    available_balance = serializers.SerializerMethodField()
    trust_score = serializers.SerializerMethodField()
    trust_status = serializers.SerializerMethodField()
    win_rate = serializers.SerializerMethodField()
    avg_payout_kes = serializers.SerializerMethodField()
    player_rank = serializers.SerializerMethodField()
    member_since = serializers.SerializerMethodField()
    profile_picture_url = serializers.SerializerMethodField()

    class Meta:
        model = User
        fields = [
            'id', 'username', 'email', 'phone_number', 'wallet_balance', 'locked_balance',
            'available_balance', 'device_bound', 'total_steps',
            'challenges_won', 'challenges_joined', 'total_earned',
            'current_streak', 'best_streak', 'best_day_steps',
            'daily_goal', 'stride_length_cm', 'weight_kg',
            'calibration_quality', 'calibration_variance_pct', 'last_calibrated_at',
            'win_rate', 'avg_payout_kes', 'player_rank', 'member_since',
            'trust_score', 'trust_status', 'profile_picture', 'profile_picture_url', 'created_at'
        ]
        read_only_fields = [
            'wallet_balance', 'locked_balance', 'total_steps', 
            'challenges_won', 'total_earned', 'current_streak',
            'challenges_joined', 'best_streak', 'best_day_steps', 'profile_picture_url'
        ]

    def get_device_bound(self, obj) -> bool:
        return obj.device_id is not None

    def get_available_balance(self, obj) -> str:
        return str(obj.available_balance)

    def get_trust_score(self, obj) -> int:
        trust = getattr(obj, 'trust_score', None)
        return trust.score if trust else 100

    def get_trust_status(self, obj) -> str:
        trust = getattr(obj, 'trust_score', None)
        return trust.status if trust else 'GOOD'

    def get_win_rate(self, obj) -> float:
        played = getattr(obj, 'challenges_joined', 0) or 0
        won = obj.challenges_won or 0
        if played == 0:
            return 0.0
        return round((won / played) * 100, 1)

    def get_avg_payout_kes(self, obj) -> str:
        won = obj.challenges_won or 0
        total = float(obj.total_earned or 0)
        if won == 0:
            return '0.00'
        return str(round(total / won, 2))

    def get_player_rank(self, obj) -> str:
        played = getattr(obj, 'challenges_joined', 0) or 0
        if played >= 100:
            return 'Champion'
        if played >= 50:
            return 'Elite'
        if played >= 25:
            return 'Veteran'
        if played >= 10:
            return 'Competitor'
        if played >= 3:
            return 'Challenger'
        return 'Newcomer'

    def get_member_since(self, obj) -> str:
        return obj.date_joined.strftime('%B %Y')
    
    def get_profile_picture_url(self, obj) -> str:
        if obj.profile_picture:
            request = self.context.get('request') if hasattr(self, 'context') else None
            return build_absolute_media_url(obj.profile_picture.url, request=request)
        return None


class ChangePasswordSerializer(serializers.Serializer):
    """
    Serializer for changing password
    """
    old_password = serializers.CharField(
        required=True,
        style={'input_type': 'password'}
    )
    new_password = serializers.CharField(
        required=True,
        validators=[validate_password],
        style={'input_type': 'password'}
    )
    confirm_password = serializers.CharField(
        required=True,
        style={'input_type': 'password'}
    )

    def validate(self, data):
        if data['new_password'] != data['confirm_password']:
            raise serializers.ValidationError({
                'confirm_password': 'Passwords do not match'
            })
        return data


class ProfilePictureSerializer(serializers.Serializer):
    """
    Serializer for uploading profile pictures
    """
    profile_picture = serializers.ImageField(required=True)
    
    def validate_profile_picture(self, value):
        return validate_and_normalize_profile_picture(value, max_mb=10)


class LoginSerializer(serializers.Serializer):
    """
    Serializer for login - supports username, email, or phone number
    """
    username = serializers.CharField(
        required=True,
        help_text='Username, email, or phone number'
    )
    password = serializers.CharField(
        required=True,
        style={'input_type': 'password'}
    )


class GoogleAuthSerializer(serializers.Serializer):
    """
    Serializer for Google OAuth access token auth
    """
    token = serializers.CharField(required=True, trim_whitespace=True)


class SupportTicketCreateSerializer(serializers.Serializer):
    """Serializer for creating support tickets from user app"""
    subject = serializers.CharField(max_length=255)
    category = serializers.ChoiceField(choices=SupportTicket.CATEGORY_CHOICES, default='general')
    priority = serializers.ChoiceField(choices=SupportTicket.PRIORITY_CHOICES, default='medium')
    message = serializers.CharField()

    def validate_subject(self, value):
        try:
            return sanitize_text(value, max_length=255)
        except DjangoValidationError as e:
            raise serializers.ValidationError(e.message)

    def validate_message(self, value):
        try:
            return sanitize_text(value, max_length=5000)
        except DjangoValidationError as e:
            raise serializers.ValidationError(e.message)


class UserSupportTicketSerializer(serializers.ModelSerializer):
    """Serializer for user's support ticket list/detail"""
    message_count = serializers.SerializerMethodField()

    class Meta:
        model = SupportTicket
        fields = [
            'id',
            'subject',
            'category',
            'status',
            'priority',
            'message',
            'admin_notes',
            'resolved_at',
            'created_at',
            'updated_at',
            'message_count',
        ]

    def get_message_count(self, obj) -> int:
        return obj.messages.count()


class UserSupportTicketMessageSerializer(serializers.ModelSerializer):
    """Serializer for support ticket conversation messages shown to users"""

    class Meta:
        model = SupportTicketMessage
        fields = [
            'id',
            'sender_username',
            'is_admin',
            'message',
            'created_at',
        ]
