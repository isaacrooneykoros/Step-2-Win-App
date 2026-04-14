from django.contrib.auth.models import AbstractUser
from django.db import models
from django.conf import settings
from decimal import Decimal
import uuid
from django.utils import timezone
from auditlog.registry import auditlog


class User(AbstractUser):
    """
    Custom user model for Step2Win platform
    """
    email = models.EmailField(unique=True)
    phone_number = models.CharField(
        max_length=20,
        blank=False,
        null=False,
        unique=True,
        help_text='M-Pesa phone number (e.g., 254712345678)'
    )
    wallet_balance = models.DecimalField(
        max_digits=10, 
        decimal_places=2, 
        default=Decimal('0.00')
    )
    locked_balance = models.DecimalField(
        max_digits=10, 
        decimal_places=2, 
        default=Decimal('0.00'),
        help_text='Balance locked in active challenges'
    )
    device_id = models.CharField(
        max_length=255, 
        null=True, 
        blank=True, 
        unique=True,
        help_text='Unique device identifier for step tracking'
    )
    device_platform = models.CharField(
        max_length=20, 
        choices=[('android', 'Android'), ('ios', 'iOS')], 
        null=True,
        blank=True
    )
    total_steps = models.BigIntegerField(
        default=0,
        help_text='Lifetime total steps'
    )
    challenges_won = models.IntegerField(
        default=0,
        help_text='Number of challenges won'
    )
    challenges_joined = models.IntegerField(
        default=0,
        help_text='Total number of challenges the user has entered (paid entry fee). '
                  'Incremented when user joins a challenge. Used for win rate.'
    )
    total_earned = models.DecimalField(
        max_digits=10, 
        decimal_places=2, 
        default=Decimal('0.00'),
        help_text='Total lifetime earnings'
    )
    current_streak = models.IntegerField(
        default=0,
        help_text='Current daily active streak'
    )
    best_streak = models.IntegerField(
        default=0,
        help_text='Longest streak the user has ever achieved. '
                  'Updated nightly. Separate from current_streak.'
    )
    best_day_steps = models.IntegerField(
        default=0,
        help_text='Highest single-day step count ever recorded for this user. '
                  'Updated on each step sync.'
    )
    daily_goal = models.IntegerField(
        default=10000,
        help_text='User personal daily step goal. '
                  'Separate from challenge milestone. '
                  'Used for home screen progress bar.'
    )
    stride_length_cm = models.FloatField(
        default=78.0,
        help_text='User-calibrated stride length in centimeters for distance precision.'
    )
    weight_kg = models.FloatField(
        default=70.0,
        help_text='User body weight in kilograms for calorie estimation precision.'
    )
    calibration_quality = models.CharField(
        max_length=16,
        choices=[('excellent', 'Excellent'), ('good', 'Good'), ('noisy', 'Noisy')],
        null=True,
        blank=True,
        help_text='Last stride calibration quality from two-pass variance check.'
    )
    calibration_variance_pct = models.FloatField(
        null=True,
        blank=True,
        help_text='Pass-to-pass stride variance percentage from last calibration.'
    )
    last_calibrated_at = models.DateTimeField(
        null=True,
        blank=True,
        help_text='Timestamp of the most recent stride calibration.'
    )
    profile_picture = models.ImageField(
        upload_to='profile_pictures/',
        null=True,
        blank=True,
        help_text='User profile picture'
    )
    last_profile_picture_update = models.DateTimeField(
        null=True,
        blank=True,
        help_text='Timestamp when profile picture was last updated'
    )
    privacy_policy_accepted = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        indexes = [
            models.Index(fields=['email']),
            models.Index(fields=['device_id']),
            models.Index(fields=['username']),
        ]
        
    def __str__(self):
        return self.username
    
    @property
    def available_balance(self):
        """Calculate available balance (wallet - locked)"""
        return self.wallet_balance - self.locked_balance


auditlog.register(User, include_fields=[
    'username', 'email', 'is_active', 'is_staff',
    'wallet_balance', 'locked_balance',
])


class UserXP(models.Model):
    """
    User gamification data with XP and level tracking
    """
    user = models.OneToOneField(User, on_delete=models.CASCADE, related_name='xp_profile')
    level = models.IntegerField(default=1)
    total_xp = models.IntegerField(default=0)
    xp_this_week = models.IntegerField(default=0)
    weekly_reset = models.DateTimeField(auto_now_add=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        indexes = [
            models.Index(fields=['user']),
            models.Index(fields=['level']),
            models.Index(fields=['total_xp']),
        ]
        verbose_name = 'User XP'
        verbose_name_plural = 'User XP'

    def __str__(self):
        return f"{self.user.username} - Level {self.level} ({self.total_xp} XP)"

    @staticmethod
    def get_level_from_xp(total_xp):
        """
        Calculate level from total XP using exponential scaling.
        Formula: level_xp = 100 * n^2 (where n is the level)
        Level 1: 0 XP
        Level 2: 100 XP
        Level 3: 400 XP
        Level 4: 900 XP
        Level 5: 1600 XP
        """
        level = 1
        xp_threshold = 0
        while True:
            next_threshold = 100 * ((level + 1) ** 2)
            if total_xp < next_threshold:
                return level
            level += 1
            if level > 100:  # Max level cap
                return 100

    def get_xp_for_next_level(self):
        """Get the XP required for next level"""
        next_level = self.level + 1
        if next_level > 100:
            return 0
        return 100 * (next_level ** 2)

    def get_xp_to_next_level(self):
        """Get remaining XP needed to reach next level"""
        next_level_xp = self.get_xp_for_next_level()
        return next_level_xp - self.total_xp

    def get_level_progress(self):
        """Get progression percentage (0-100) for current level"""
        current_level_xp = 100 * (self.level ** 2)
        next_level_xp = 100 * ((self.level + 1) ** 2)
        if self.level >= 100:
            return 100
        progress = ((self.total_xp - current_level_xp) / 
                    (next_level_xp - current_level_xp)) * 100
        return min(100, max(0, progress))

    def add_xp(self, amount, source=''):
        """
        Add XP to user and check for level up.
        Returns dict with level_up info.
        """
        old_level = self.level
        self.total_xp += amount
        self.xp_this_week += amount
        self.level = self.get_level_from_xp(self.total_xp)
        self.save()

        return {
            'xp_added': amount,
            'total_xp': self.total_xp,
            'level': self.level,
            'level_up': self.level > old_level,
            'previous_level': old_level,
            'source': source,
        }


class DeviceSession(models.Model):
    """
    Tracks every logged-in device for a user.
    One row per active login session.

    When a user logs in:
      → A DeviceSession is created
      → The refresh token's JTI is stored here
      → Device info (name, OS, IP) is recorded

    When a user logs out OR changes password:
      → The session is marked is_active=False
      → The refresh token is blacklisted
      → That device loses access immediately on next request

    Users can see all their active sessions and revoke any of them.
    """

    DEVICE_TYPES = [
        ('android',  'Android'),
        ('ios',      'iOS'),
        ('web',      'Web Browser'),
        ('unknown',  'Unknown'),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name='device_sessions'
    )

    # Token tracking — jti is the unique ID inside the JWT
    refresh_jti = models.CharField(max_length=255, unique=True, db_index=True)

    # Device info — shown to user in "Active Sessions" screen
    device_type = models.CharField(max_length=10, choices=DEVICE_TYPES, default='unknown')
    device_name = models.CharField(max_length=200, blank=True)
    # e.g. "Samsung Galaxy S21", "iPhone 14", "Chrome on Windows"
    os_version = models.CharField(max_length=100, blank=True)
    app_version = models.CharField(max_length=20, blank=True)

    # Network info
    ip_address = models.GenericIPAddressField(null=True, blank=True)
    country = models.CharField(max_length=2, blank=True)  # e.g. "KE"

    # State
    is_active = models.BooleanField(default=True, db_index=True)
    last_active_at = models.DateTimeField(default=timezone.now)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-last_active_at']
        indexes = [
            models.Index(fields=['user', 'is_active']),
            models.Index(fields=['refresh_jti']),
        ]

    def __str__(self):
        return f"{self.user.username} | {self.device_name or self.device_type} | {'Active' if self.is_active else 'Revoked'}"

    @property
    def display_name(self):
        if self.device_name:
            return self.device_name
        return dict(self.DEVICE_TYPES).get(self.device_type, 'Unknown Device')
