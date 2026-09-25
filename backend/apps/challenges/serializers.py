from datetime import date, timedelta

from django.core.exceptions import ValidationError as DjangoValidationError
from django.utils import timezone
from rest_framework import serializers

from apps.admin_api.models import SystemSettings
from apps.admin_api.platform import (ENTRY_FEE_DEFAULT_MAX, ENTRY_FEE_DEFAULT_MIN,
                                     challenge_needs_approval,
                                     entry_fee_range, max_challenge_participants)
from apps.core.sanitizers import sanitize_text

from .models import Challenge, ChallengeMessage, Participant, format_milestone_label, get_configured_milestones
from .payout_policy import PAUSED_MESSAGE, allowed_win_conditions, payout_structure_for

# Challenge entry contribution (KES). Users type any whole amount in the range the
# admin sets (SystemSettings min/max_challenge_entry_fee, read via
# apps.admin_api.platform.entry_fee_range); these names are the defaults used when
# the stored range is unusable. The app gets the live range from /api/challenges/config/.
ENTRY_FEE_MIN = ENTRY_FEE_DEFAULT_MIN
ENTRY_FEE_MAX = ENTRY_FEE_DEFAULT_MAX


class ParticipantSerializer(serializers.ModelSerializer):
    """
    Serializer for challenge participants
    """

    username = serializers.CharField(source="user.username", read_only=True)
    progress_percentage = serializers.IntegerField(read_only=True)

    class Meta:
        model = Participant
        fields = [
            "id",
            "user",
            "username",
            "steps",
            "qualified",
            "payout",
            "rank",
            "joined_at",
            "progress_percentage",
        ]
        read_only_fields = ["id", "steps", "qualified", "payout", "rank", "joined_at"]


class ChallengeSerializer(serializers.ModelSerializer):
    """
    Serializer for challenge list view
    """

    creator_username = serializers.CharField(source="creator.username", read_only=True)
    milestone_display = serializers.SerializerMethodField()
    status_display = serializers.CharField(source="get_status_display", read_only=True)
    win_condition_display = serializers.CharField(
        source="get_win_condition_display", read_only=True
    )
    current_participants = serializers.IntegerField(read_only=True)
    days_remaining = serializers.IntegerField(read_only=True)
    is_full = serializers.BooleanField(read_only=True)

    class Meta:
        model = Challenge
        fields = [
            "id",
            "name",
            "description",
            "creator",
            "creator_username",
            "milestone",
            "milestone_display",
            "entry_fee",
            "total_pool",
            "max_participants",
            "current_participants",
            "status",
            "status_display",
            "start_date",
            "end_date",
            "invite_code",
            "is_private",
            "win_condition",
            "win_condition_display",
            "payout_structure",
            "theme",
            "theme_emoji",
            "days_remaining",
            "is_full",
            "created_at",
        ]
        read_only_fields = [
            "id",
            "creator",
            "total_pool",
            "current_participants",
            "status",
            "invite_code",
            "payout_structure",
            "created_at",
        ]

    def validate_entry_fee(self, value):
        if value < 1:
            raise serializers.ValidationError("Minimum entry fee is KES 1")
        if value > 10000:
            raise serializers.ValidationError("Maximum entry fee is KES 10,000")
        return value

    def get_milestone_display(self, obj) -> str:
        return format_milestone_label(obj.milestone)

    def validate_max_participants(self, value):
        if value < 2:
            raise serializers.ValidationError("Minimum 2 participants required")
        if value > 1000:
            raise serializers.ValidationError("Maximum 1000 participants allowed")
        return value

    def validate_name(self, value):
        try:
            return sanitize_text(value, max_length=100)
        except DjangoValidationError as e:
            raise serializers.ValidationError(e.message)

    def validate_description(self, value):
        if value:
            try:
                return sanitize_text(value, max_length=500)
            except DjangoValidationError as e:
                raise serializers.ValidationError(e.message)
        return value

    def validate(self, data):
        # Validate dates
        if "start_date" in data and "end_date" in data:
            if data["end_date"] <= data["start_date"]:
                raise serializers.ValidationError(
                    {"end_date": "End date must be after start date"}
                )

            # Duration must be between 7 and 30 days
            duration = (data["end_date"] - data["start_date"]).days
            if duration < 7 or duration > 30:
                raise serializers.ValidationError(
                    {"end_date": "Challenge must be between 7 and 30 days long"}
                )

        return data


class ChallengeDetailSerializer(ChallengeSerializer):
    """
    Detailed serializer with participant information
    """

    participants = ParticipantSerializer(many=True, read_only=True)
    my_participation = serializers.SerializerMethodField()
    platform_fee = serializers.DecimalField(
        max_digits=12, decimal_places=2, read_only=True
    )
    net_pool = serializers.DecimalField(max_digits=12, decimal_places=2, read_only=True)

    class Meta(ChallengeSerializer.Meta):
        fields = ChallengeSerializer.Meta.fields + [
            "participants",
            "my_participation",
            "platform_fee",
            "net_pool",
        ]

    def get_my_participation(self, obj) -> dict | None:
        request = self.context.get("request")
        if request and request.user.is_authenticated:
            try:
                participant = obj.participants.get(user=request.user)
                return ParticipantSerializer(participant).data
            except Participant.DoesNotExist:
                return None
        return None


class CreateChallengeSerializer(serializers.ModelSerializer):
    """
    Serializer for creating a new challenge
    """

    duration_days = serializers.IntegerField(
        write_only=True,
        default=7,
        help_text="Challenge duration in days (7, 14, 21, or 30)",
    )
    is_public = serializers.BooleanField(
        write_only=True,
        default=True,
        help_text="Whether challenge is public or private",
    )

    class Meta:
        model = Challenge
        fields = [
            "name",
            "description",
            "milestone",
            "entry_fee",
            "max_participants",
            "is_private",
            "duration_days",
            "is_public",
            "win_condition",
            "theme_emoji",
        ]
        extra_kwargs = {
            "description": {"required": False, "allow_blank": True},
            "is_private": {"required": False},
            "max_participants": {"required": False, "default": 20},
        }

    def validate_milestone(self, value):
        """Validate milestone matches the configured challenge options."""
        configured_milestones = get_configured_milestones()
        settings = SystemSettings.load()
        min_milestone = int(settings.min_challenge_milestone or 1000)
        max_milestone = int(settings.max_challenge_milestone or 300000)

        if value not in configured_milestones:
            raise serializers.ValidationError(
                f"Milestone must be one of the configured challenge levels between {min_milestone:,} and {max_milestone:,} steps"
            )
        return value

    def validate_entry_fee(self, value):
        if value < 1:
            raise serializers.ValidationError("Minimum entry fee is KES 1")
        return value

    def validate_theme_emoji(self, value):
        allowed = [choice[0] for choice in Challenge.THEME_EMOJI_CHOICES]
        if value not in allowed:
            raise serializers.ValidationError(f"Theme emoji must be one of: {allowed}")
        return value

    def validate_max_participants(self, value):
        cap = max_challenge_participants()
        if value < 2:
            raise serializers.ValidationError("Minimum 2 participants required")
        if value > cap:
            if "max_participants" not in getattr(self, "initial_data", {}):
                return cap  # the implicit default (20) is above the admin's limit
            raise serializers.ValidationError(f"Maximum {cap:,} participants allowed")
        return value

    def validate_duration_days(self, value):
        """Validate duration is one of the allowed options"""
        allowed_durations = [7, 14, 21, 30]
        if value not in allowed_durations:
            raise serializers.ValidationError(
                f"Duration must be one of: {allowed_durations} days"
            )
        return value

    def validate(self, data):
        is_public = data.get("is_public", True)
        entry_fee = data.get("entry_fee")
        win_condition = data.get("win_condition", "proportional")

        # Entry is a typed amount (whole shillings) within one shared range for public and
        # private challenges, set by the admin; the app shows suggestions as quick picks.
        if entry_fee is not None:
            fee_min, fee_max = entry_fee_range()
            if entry_fee != entry_fee.to_integral_value():
                raise serializers.ValidationError(
                    {"entry_fee": "Entry must be a whole number of shillings"}
                )
            if entry_fee < fee_min or entry_fee > fee_max:
                raise serializers.ValidationError(
                    {
                        "entry_fee": f"Entry must be between KES {fee_min:,} and KES {fee_max:,}"
                    }
                )

        if is_public:
            if win_condition != "proportional":
                raise serializers.ValidationError(
                    {
                        "win_condition": "Public challenges only support proportional payout"
                    }
                )
        elif win_condition not in allowed_win_conditions():
            raise serializers.ValidationError({"win_condition": PAUSED_MESSAGE})

        return data

    def create(self, validated_data):
        # Extract duration and visibility
        duration_days = validated_data.pop("duration_days", 7)
        is_public = validated_data.pop("is_public", True)

        # Set is_private based on is_public
        validated_data["is_public"] = is_public
        validated_data["is_private"] = not is_public

        # Public challenges always use proportional payout mode
        if is_public:
            validated_data["win_condition"] = "proportional"
        # The resolver pays by payout_structure: keep it in step with the chosen rule, so the
        # app never promises one rule while the payout uses another.
        validated_data["payout_structure"] = payout_structure_for(
            validated_data.get("win_condition", "proportional")
        )

        # Set dates: start today, end based on duration
        validated_data["start_date"] = date.today()
        validated_data["end_date"] = date.today() + timedelta(days=duration_days)
        # With approval switched on, public challenges wait in the admin queue
        # ("pending"): hidden from the lobby and not joinable until approved.
        validated_data["status"] = "pending" if challenge_needs_approval(is_public) else "active"

        return super().create(validated_data)


class JoinChallengeSerializer(serializers.Serializer):
    """
    Serializer for joining a challenge
    """

    invite_code = serializers.CharField(max_length=10)

    def validate_invite_code(self, value):
        try:
            challenge = Challenge.objects.get(invite_code=value.upper())
            # "pending" = waiting for admin approval: not joinable until approved.
            if challenge.status == "pending":
                raise serializers.ValidationError(
                    "This challenge is waiting for approval and can't be joined yet"
                )
            if challenge.status != "active":
                raise serializers.ValidationError("Challenge is no longer open to join")
            if challenge.end_date and challenge.end_date < timezone.localdate():
                raise serializers.ValidationError("Challenge has already ended")
            if challenge.is_full:
                raise serializers.ValidationError("Challenge is full")
        except Challenge.DoesNotExist:
            raise serializers.ValidationError("Invalid invite code")

        return value.upper()


class ChallengeMessageSerializer(serializers.ModelSerializer):
    """
    Serializer for challenge chat messages
    """

    username = serializers.CharField(
        source="user.username", read_only=True, allow_null=True
    )

    class Meta:
        model = ChallengeMessage
        fields = [
            "id",
            "user",
            "username",
            "message",
            "is_system",
            "event_type",
            "created_at",
        ]
        read_only_fields = ["id", "is_system", "event_type", "created_at"]


class LobbyParticipantSerializer(serializers.ModelSerializer):
    """Minimal user info for leaderboard — no sensitive data."""

    username = serializers.CharField(source="user.username")
    avatar_url = serializers.SerializerMethodField()

    class Meta:
        model = Participant
        fields = ["username", "avatar_url", "steps", "qualified"]

    def get_avatar_url(self, obj):
        return getattr(obj.user, "avatar_url", None)


class LobbyCardSerializer(serializers.ModelSerializer):
    """
    Used for the public lobby list.
    Includes enough data to render a full challenge card without extra queries.
    """

    participant_count = serializers.SerializerMethodField()
    spots_remaining = serializers.SerializerMethodField()
    fill_percentage = serializers.SerializerMethodField()
    is_almost_full = serializers.SerializerMethodField()
    days_remaining = serializers.SerializerMethodField()
    hours_remaining = serializers.SerializerMethodField()
    is_starting_soon = serializers.SerializerMethodField()
    effective_pool_kes = serializers.SerializerMethodField()
    user_is_joined = serializers.SerializerMethodField()
    milestone_label = serializers.SerializerMethodField()

    class Meta:
        model = Challenge
        fields = [
            "id",
            "name",
            "status",
            "milestone",
            "milestone_label",
            "entry_fee",
            "total_pool",
            "effective_pool_kes",
            "max_participants",
            "participant_count",
            "spots_remaining",
            "fill_percentage",
            "is_almost_full",
            "start_date",
            "end_date",
            "days_remaining",
            "hours_remaining",
            "is_starting_soon",
            "is_featured",
            "is_platform_challenge",
            "platform_bonus_kes",
            "theme",
            "user_is_joined",
            "invite_code",
        ]

    def get_participant_count(self, obj) -> int:
        return obj.participants.count()

    def get_spots_remaining(self, obj) -> int:
        return max(0, obj.max_participants - obj.participants.count())

    def get_fill_percentage(self, obj) -> int:
        count = obj.participants.count()
        if obj.max_participants == 0:
            return 0
        return min(100, round((count / obj.max_participants) * 100))

    def get_is_almost_full(self, obj) -> bool:
        return self.get_fill_percentage(obj) >= 80

    def get_days_remaining(self, obj) -> int:
        from django.utils import timezone

        delta = obj.end_date - timezone.now().date()
        return max(0, delta.days)

    def get_hours_remaining(self, obj) -> int:
        import datetime

        from django.utils import timezone

        end_dt = datetime.datetime.combine(obj.end_date, datetime.time(23, 59, 59))
        end_dt = timezone.make_aware(end_dt)
        delta = end_dt - timezone.now()
        return max(0, int(delta.total_seconds() / 3600))

    def get_is_starting_soon(self, obj) -> bool:
        import datetime

        from django.utils import timezone

        if obj.status != "pending":
            return False
        start_dt = datetime.datetime.combine(obj.start_date, datetime.time(0, 0))
        start_dt = timezone.make_aware(start_dt)
        return (start_dt - timezone.now()).total_seconds() < 7200

    def get_effective_pool_kes(self, obj) -> str:
        return str(obj.total_pool + obj.platform_bonus_kes)

    def get_user_is_joined(self, obj) -> bool:
        request = self.context.get("request")
        if not request or not request.user.is_authenticated:
            return False
        return obj.participants.filter(user=request.user).exists()

    def get_milestone_label(self, obj) -> str:
        return format_milestone_label(obj.milestone)


class SpectatorLeaderboardSerializer(serializers.ModelSerializer):
    """
    Full leaderboard for a public challenge — viewable by non-participants.
    No private data exposed.
    """

    username = serializers.CharField(source="user.username")
    avatar_initials = serializers.SerializerMethodField()
    rank = serializers.SerializerMethodField()
    steps_display = serializers.SerializerMethodField()
    progress_pct = serializers.SerializerMethodField()
    estimated_payout = serializers.SerializerMethodField()

    class Meta:
        model = Participant
        fields = [
            "rank",
            "username",
            "avatar_initials",
            "steps",
            "steps_display",
            "qualified",
            "progress_pct",
            "estimated_payout",
        ]

    def get_avatar_initials(self, obj):
        name = obj.user.username or obj.user.email or "?"
        return name[:2].upper()

    def get_rank(self, obj):
        return getattr(obj, "_rank", 0)

    def get_steps_display(self, obj):
        return f"{obj.steps:,}"

    def get_progress_pct(self, obj):
        challenge = obj.challenge
        if challenge.milestone == 0:
            return 0
        return min(100, round((obj.steps / challenge.milestone) * 100))

    def get_estimated_payout(self, obj):
        """
        Estimated payout IF this user qualifies and current rankings hold.
        Formula: (user_steps / total_qualified_steps) * net_pool
        """
        challenge = obj.challenge
        net_pool = float(challenge.total_pool) * 0.95
        all_parts = list(challenge.participants.all())
        qualified = [p for p in all_parts if p.steps >= challenge.milestone]

        if not qualified or obj not in qualified:
            return None

        total_q_steps = sum(p.steps for p in qualified)
        if total_q_steps == 0:
            return None

        est = (obj.steps / total_q_steps) * net_pool
        return round(est, 2)
