from django.db import models
from django.conf import settings
from django.core.validators import MinValueValidator, MaxValueValidator
from decimal import Decimal
import uuid


def generate_invite_code():
    """Generate a unique 8-character invite code"""
    return uuid.uuid4().hex[:8].upper()


class Challenge(models.Model):
    """
    Model for fitness challenges
    """
    MILESTONE_CHOICES = [
        (50000, 'Beginner - 50K steps'),
        (70000, 'Intermediate - 70K steps'),
        (90000, 'Advanced - 90K steps'),
    ]
    
    STATUS_CHOICES = [
        ('pending', 'Pending'),
        ('active', 'Active'),
        ('completed', 'Completed'),
        ('cancelled', 'Cancelled'),
    ]

    WIN_CONDITION_CHOICES = [
        ('proportional', 'Proportional Split'),
        ('winner_takes_all', 'Winner Takes All'),
        ('qualification_only', 'Qualification Only'),
    ]

    THEME_EMOJI_CHOICES = [
        ('🔥', 'Flame'),
        ('👑', 'Royal'),
        ('🌍', 'Safari'),
        ('⚡', 'Lightning'),
    ]

    THEME_CHOICES = [
        ('blue', 'Blue'),
        ('green', 'Green'),
        ('purple', 'Purple'),
        ('orange', 'Orange'),
        ('pink', 'Pink'),
    ]
    
    name = models.CharField(max_length=200)
    description = models.TextField(blank=True)
    creator = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name='created_challenges'
    )
    milestone = models.IntegerField(
        choices=MILESTONE_CHOICES,
        help_text='Total steps required to qualify for payout'
    )
    entry_fee = models.DecimalField(
        max_digits=10,
        decimal_places=2,
        validators=[MinValueValidator(Decimal('1.00')), MaxValueValidator(Decimal('10000.00'))]
    )
    total_pool = models.DecimalField(
        max_digits=12,
        decimal_places=2,
        default=Decimal('0.00'),
        help_text='Total prize pool (sum of all entry fees)'
    )
    max_participants = models.IntegerField(
        default=50,
        validators=[MinValueValidator(2), MaxValueValidator(1000)]
    )
    status = models.CharField(
        max_length=20,
        choices=STATUS_CHOICES,
        default='pending'
    )
    start_date = models.DateField()
    end_date = models.DateField()
    invite_code = models.CharField(
        max_length=10,
        unique=True,
        default=generate_invite_code,
        help_text='Unique code for joining the challenge'
    )
    is_private = models.BooleanField(
        default=False,
        help_text='Private challenges require invite code'
    )
    is_public = models.BooleanField(
        default=True,
        help_text='Public challenges appear in the lobby. Private are invite-only.'
    )
    is_featured = models.BooleanField(
        default=False,
        help_text='Featured challenges appear at top of lobby with a special badge.'
    )
    featured_until = models.DateTimeField(
        null=True,
        blank=True,
        help_text='Auto-unfeature after this datetime.'
    )
    view_count = models.PositiveIntegerField(
        default=0,
        help_text='How many times this challenge has been viewed in the lobby.'
    )
    is_platform_challenge = models.BooleanField(default=False)
    platform_bonus_kes = models.DecimalField(
        max_digits=10,
        decimal_places=2,
        default=Decimal('0.00'),
        help_text='KES added by platform on top of user entries to boost the pool.'
    )
    win_condition = models.CharField(
        max_length=30,
        choices=WIN_CONDITION_CHOICES,
        default='proportional',
        help_text='How winners are determined and payouts are distributed'
    )
    
    # NEW: Enhanced payout structure for tie resolution
    PAYOUT_CHOICES = [
        ('proportional',    'Proportional'),     # default — steps % share
        ('winner_takes_all','Winner Takes All'), # 1st place gets 95% net pool
        ('top_3',           'Top 3 Split'),      # 50% / 30% / 20%
    ]
    payout_structure = models.CharField(
        max_length=20,
        choices=PAYOUT_CHOICES,
        default='proportional',
        help_text='How winnings are distributed at challenge end.'
    )
    
    theme_emoji = models.CharField(
        max_length=4,
        choices=THEME_EMOJI_CHOICES,
        default='🔥',
        help_text='Visual identity emoji for private challenge cards'
    )
    theme = models.CharField(max_length=10, choices=THEME_CHOICES, default='blue')
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        indexes = [
            models.Index(fields=['status', '-created_at']),
            models.Index(fields=['invite_code']),
            models.Index(fields=['start_date', 'end_date']),
        ]
        ordering = ['-created_at']
    
    def __str__(self):
        return f"{self.name} - {self.get_milestone_display()}"
    
    @property
    def current_participants(self):
        return self.participants.count()
    
    @property
    def is_full(self):
        return self.current_participants >= self.max_participants
    
    @property
    def days_remaining(self):
        from datetime import date
        if self.status != 'active':
            return 0
        remaining = (self.end_date - date.today()).days
        return max(0, remaining)
    
    @property
    def platform_fee(self):
        return self.total_pool * Decimal('0.05')
    
    @property
    def net_pool(self):
        return self.total_pool - self.platform_fee


class Participant(models.Model):
    """
    Model for challenge participants
    """
    challenge = models.ForeignKey(
        Challenge,
        on_delete=models.CASCADE,
        related_name='participants'
    )
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name='challenge_participations'
    )
    steps = models.IntegerField(
        default=0,
        help_text='Total steps accumulated during challenge'
    )
    qualified = models.BooleanField(
        default=False,
        help_text='Whether user met the milestone requirement'
    )
    payout = models.DecimalField(
        max_digits=10,
        decimal_places=2,
        default=Decimal('0.00'),
        help_text='Final payout amount (calculated at challenge end)'
    )
    rank = models.IntegerField(
        null=True,
        blank=True,
        help_text='Final rank in the challenge'
    )
    
    # NEW: Tiebreaker data — collected during challenge, used at finalization
    gps_step_percentage = models.FloatField(
        default=0.0,
        help_text='Percentage of total steps verified by GPS tracking (0-100). '
                  'Higher = more trustworthy. Used as Level 1 tiebreaker.'
    )
    milestone_reached_at = models.DateTimeField(
        null=True, blank=True,
        help_text='Exact datetime when participant first hit challenge milestone. '
                  'Earlier = better tiebreaker. Set by sync_steps task.'
    )
    zero_step_days = models.IntegerField(
        default=0,
        help_text='Days within challenge window where participant recorded 0 steps. '
                  'Fewer = better (more consistent). Updated nightly.'
    )
    best_day_steps = models.IntegerField(
        default=0,
        help_text='Highest single-day step count during challenge window. '
                  'Higher = better. Updated on each sync.'
    )
    longest_streak = models.IntegerField(
        default=0,
        help_text='Longest consecutive days with steps > 0 during challenge. '
                  'Longer = better. Updated nightly.'
    )
    
    joined_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        unique_together = ['challenge', 'user']
        indexes = [
            models.Index(fields=['challenge', '-steps']),
            models.Index(fields=['user', '-joined_at']),
        ]
        ordering = ['-steps']
    
    def __str__(self):
        return f"{self.user.username} in {self.challenge.name}"
    
    @property
    def progress_percentage(self):
        if self.challenge.milestone == 0:
            return 0
        return min(100, int((self.steps / self.challenge.milestone) * 100))


class ChallengeResult(models.Model):
    """
    Immutable record of every participant's final position and payout.
    Created once when challenge finalizes. NEVER updated, NEVER deleted.
    This is the source of truth for dispute resolution.

    One row per participant per challenge.
    """
    challenge    = models.ForeignKey(
                     Challenge, on_delete=models.PROTECT,
                     related_name='results'
                   )
    participant  = models.ForeignKey(
                     'Participant', on_delete=models.PROTECT,
                     related_name='result'
                   )
    user         = models.ForeignKey(
                     settings.AUTH_USER_MODEL, on_delete=models.PROTECT
                   )

    # ── Snapshot of all tiebreaker data at finalization time ──────────────
    final_steps          = models.IntegerField()
    gps_verified_pct     = models.FloatField()
    milestone_reached_at = models.DateTimeField(null=True, blank=True)
    zero_step_days       = models.IntegerField()
    best_day_steps       = models.IntegerField()
    longest_streak       = models.IntegerField()
    joined_at            = models.DateTimeField()

    # ── Tie resolution info ───────────────────────────────────────────────
    tied_with_count  = models.IntegerField(
                         default=0,
                         help_text='Number of other participants this user tied with.'
                       )
    tiebreaker_level = models.IntegerField(
                         null=True, blank=True,
                         help_text='Which tiebreaker level broke the tie (1-7). '
                                   'Null if no tie occurred.'
                       )
    tiebreaker_label = models.CharField(
                         max_length=200, blank=True,
                         help_text='Human-readable explanation of tiebreaker used.'
                       )

    # ── Final outcome ─────────────────────────────────────────────────────
    qualified        = models.BooleanField()
    final_rank       = models.IntegerField(
                         null=True, blank=True,
                         help_text='Null for proportional challenges (no ranking).'
                       )
    payout_kes       = models.DecimalField(max_digits=10, decimal_places=2)
    payout_method    = models.CharField(
                         max_length=30,
                         choices=[
                             ('proportional', 'Proportional'),
                             ('dead_heat',    'Dead Heat Split'),
                             ('tiebreaker',   'Tiebreaker'),
                             ('refund',       'Refund (No Qualifiers)'),
                             ('no_payout',    'Did Not Qualify'),
                         ]
                       )

    finalized_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        unique_together = [('challenge', 'participant')]
        ordering        = ['challenge', 'final_rank', '-final_steps']

    def __str__(self):
        return (f"{self.challenge.name} | {self.user.username} | "
                f"Rank {self.final_rank} | KES {self.payout_kes}")

    # Prevent deletion — these are financial records
    def delete(self, *args, **kwargs):
        raise PermissionError("ChallengeResult records cannot be deleted.")


class ChallengeMessage(models.Model):
    """
    Chat messages for private challenges
    """
    challenge = models.ForeignKey(
        Challenge,
        on_delete=models.CASCADE,
        related_name='messages'
    )
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='challenge_messages',
        help_text='Null for system/automated messages'
    )
    message = models.TextField()
    is_system = models.BooleanField(
        default=False,
        help_text='True for automated event messages'
    )
    event_type = models.CharField(
        max_length=50,
        blank=True,
        help_text='Type of automated event (e.g. milestone_reached, elimination)'
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['created_at']
        indexes = [
            models.Index(fields=['challenge', 'created_at']),
        ]

    def __str__(self):
        sender = 'System' if self.is_system else (self.user.username if self.user else 'Unknown')
        return f"{sender} in {self.challenge.name}: {self.message[:50]}"
