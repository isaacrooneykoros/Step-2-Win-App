from rest_framework import serializers
from datetime import date, timedelta
from .models import Challenge, Participant, ChallengeMessage


class ParticipantSerializer(serializers.ModelSerializer):
    """
    Serializer for challenge participants
    """
    username = serializers.CharField(source='user.username', read_only=True)
    progress_percentage = serializers.IntegerField(read_only=True)
    
    class Meta:
        model = Participant
        fields = [
            'id', 'user', 'username', 'steps', 'qualified',
            'payout', 'rank', 'joined_at', 'progress_percentage'
        ]
        read_only_fields = [
            'id', 'steps', 'qualified', 'payout', 'rank', 'joined_at'
        ]


class ChallengeSerializer(serializers.ModelSerializer):
    """
    Serializer for challenge list view
    """
    creator_username = serializers.CharField(source='creator.username', read_only=True)
    milestone_display = serializers.CharField(source='get_milestone_display', read_only=True)
    status_display = serializers.CharField(source='get_status_display', read_only=True)
    win_condition_display = serializers.CharField(source='get_win_condition_display', read_only=True)
    current_participants = serializers.IntegerField(read_only=True)
    days_remaining = serializers.IntegerField(read_only=True)
    is_full = serializers.BooleanField(read_only=True)
    
    class Meta:
        model = Challenge
        fields = [
            'id', 'name', 'description', 'creator', 'creator_username',
            'milestone', 'milestone_display', 'entry_fee', 'total_pool',
            'max_participants', 'current_participants', 'status', 'status_display',
            'start_date', 'end_date', 'invite_code', 'is_private',
                'win_condition', 'win_condition_display', 'theme', 'theme_emoji',
            'days_remaining', 'is_full', 'created_at'
        ]
        read_only_fields = [
            'id', 'creator', 'total_pool', 'current_participants',
            'status', 'invite_code', 'created_at'
        ]
    
    def validate_entry_fee(self, value):
        if value < 1:
            raise serializers.ValidationError('Minimum entry fee is $1.00')
        if value > 10000:
            raise serializers.ValidationError('Maximum entry fee is $10,000.00')
        return value
    
    def validate_max_participants(self, value):
        if value < 2:
            raise serializers.ValidationError('Minimum 2 participants required')
        if value > 1000:
            raise serializers.ValidationError('Maximum 1000 participants allowed')
        return value
    
    def validate(self, data):
        # Validate dates
        if 'start_date' in data and 'end_date' in data:
            if data['end_date'] <= data['start_date']:
                raise serializers.ValidationError({
                    'end_date': 'End date must be after start date'
                })
            
            # Duration must be between 7 and 30 days
            duration = (data['end_date'] - data['start_date']).days
            if duration < 7 or duration > 30:
                raise serializers.ValidationError({
                    'end_date': 'Challenge must be between 7 and 30 days long'
                })
        
        return data


class ChallengeDetailSerializer(ChallengeSerializer):
    """
    Detailed serializer with participant information
    """
    participants = ParticipantSerializer(many=True, read_only=True)
    my_participation = serializers.SerializerMethodField()
    platform_fee = serializers.DecimalField(max_digits=12, decimal_places=2, read_only=True)
    net_pool = serializers.DecimalField(max_digits=12, decimal_places=2, read_only=True)
    
    class Meta(ChallengeSerializer.Meta):
        fields = ChallengeSerializer.Meta.fields + [
            'participants', 'my_participation', 'platform_fee', 'net_pool'
        ]
    
    def get_my_participation(self, obj):
        request = self.context.get('request')
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
    duration_days = serializers.IntegerField(write_only=True, default=7, help_text='Challenge duration in days (7, 14, 21, or 30)')
    is_public = serializers.BooleanField(write_only=True, default=True, help_text='Whether challenge is public or private')
    
    class Meta:
        model = Challenge
        fields = [
            'name', 'description', 'milestone', 'entry_fee',
            'max_participants', 'is_private', 'duration_days', 'is_public',
            'win_condition', 'theme_emoji'
        ]
        extra_kwargs = {
            'description': {'required': False, 'allow_blank': True},
            'is_private': {'required': False},
            'max_participants': {'required': False, 'default': 20},
        }
    
    def validate_milestone(self, value):
        """Validate milestone is one of the valid choices"""
        valid_milestones = [50000, 70000, 90000]
        if value not in valid_milestones:
            raise serializers.ValidationError(
                f'Milestone must be one of: {valid_milestones}'
            )
        return value
    
    def validate_entry_fee(self, value):
        if value < 1:
            raise serializers.ValidationError('Minimum entry fee is $1.00')
        return value

    def validate_theme_emoji(self, value):
        allowed = [choice[0] for choice in Challenge.THEME_EMOJI_CHOICES]
        if value not in allowed:
            raise serializers.ValidationError(f'Theme emoji must be one of: {allowed}')
        return value
    
    def validate_max_participants(self, value):
        if value < 2:
            raise serializers.ValidationError('Minimum 2 participants required')
        if value > 1000:
            raise serializers.ValidationError('Maximum 1000 participants allowed')
        return value
    
    def validate_duration_days(self, value):
        """Validate duration is one of the allowed options"""
        allowed_durations = [7, 14, 21, 30]
        if value not in allowed_durations:
            raise serializers.ValidationError(
                f'Duration must be one of: {allowed_durations} days'
            )
        return value

    def validate(self, data):
        is_public = data.get('is_public', True)
        entry_fee = data.get('entry_fee')
        win_condition = data.get('win_condition', 'proportional')

        if is_public:
            if entry_fee and entry_fee not in [100, 250, 500, 1000]:
                raise serializers.ValidationError({
                    'entry_fee': 'Public challenges must use fixed tiers: 100, 250, 500, 1000'
                })
            if win_condition != 'proportional':
                raise serializers.ValidationError({
                    'win_condition': 'Public challenges only support proportional payout'
                })
        else:
            if entry_fee and (entry_fee < 50 or entry_fee > 10000):
                raise serializers.ValidationError({
                    'entry_fee': 'Private challenges must be between 50 and 10,000'
                })

        return data
    
    def create(self, validated_data):
        # Extract duration and visibility
        duration_days = validated_data.pop('duration_days', 7)
        is_public = validated_data.pop('is_public', True)
        
        # Set is_private based on is_public
        validated_data['is_public'] = is_public
        validated_data['is_private'] = not is_public

        # Public challenges always use proportional payout mode
        if is_public:
            validated_data['win_condition'] = 'proportional'
        
        # Set dates: start today, end based on duration
        validated_data['start_date'] = date.today()
        validated_data['end_date'] = date.today() + timedelta(days=duration_days)
        validated_data['status'] = 'active'
        
        return super().create(validated_data)


class JoinChallengeSerializer(serializers.Serializer):
    """
    Serializer for joining a challenge
    """
    invite_code = serializers.CharField(max_length=10)
    
    def validate_invite_code(self, value):
        try:
            challenge = Challenge.objects.get(invite_code=value.upper())
            if challenge.status != 'active':
                raise serializers.ValidationError('Challenge is not active')
            if challenge.is_full:
                raise serializers.ValidationError('Challenge is full')
        except Challenge.DoesNotExist:
            raise serializers.ValidationError('Invalid invite code')
        
        return value.upper()


class ChallengeMessageSerializer(serializers.ModelSerializer):
    """
    Serializer for challenge chat messages
    """
    username = serializers.CharField(source='user.username', read_only=True, allow_null=True)
    
    class Meta:
        model = ChallengeMessage
        fields = ['id', 'user', 'username', 'message', 'is_system', 'event_type', 'created_at']
        read_only_fields = ['id', 'is_system', 'event_type', 'created_at']


class LobbyParticipantSerializer(serializers.ModelSerializer):
    """Minimal user info for leaderboard — no sensitive data."""
    username = serializers.CharField(source='user.username')
    avatar_url = serializers.SerializerMethodField()

    class Meta:
        model = Participant
        fields = ['username', 'avatar_url', 'steps', 'qualified']

    def get_avatar_url(self, obj):
        return getattr(obj.user, 'avatar_url', None)


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
            'id', 'name', 'status', 'milestone', 'milestone_label',
            'entry_fee', 'total_pool', 'effective_pool_kes',
            'max_participants', 'participant_count', 'spots_remaining',
            'fill_percentage', 'is_almost_full',
            'start_date', 'end_date', 'days_remaining', 'hours_remaining',
            'is_starting_soon', 'is_featured', 'is_platform_challenge',
            'platform_bonus_kes', 'theme', 'user_is_joined', 'invite_code',
        ]

    def get_participant_count(self, obj):
        return obj.participants.count()

    def get_spots_remaining(self, obj):
        return max(0, obj.max_participants - obj.participants.count())

    def get_fill_percentage(self, obj):
        count = obj.participants.count()
        if obj.max_participants == 0:
            return 0
        return min(100, round((count / obj.max_participants) * 100))

    def get_is_almost_full(self, obj):
        return self.get_fill_percentage(obj) >= 80

    def get_days_remaining(self, obj):
        from django.utils import timezone
        delta = obj.end_date - timezone.now().date()
        return max(0, delta.days)

    def get_hours_remaining(self, obj):
        from django.utils import timezone
        import datetime
        end_dt = datetime.datetime.combine(obj.end_date, datetime.time(23, 59, 59))
        end_dt = timezone.make_aware(end_dt)
        delta = end_dt - timezone.now()
        return max(0, int(delta.total_seconds() / 3600))

    def get_is_starting_soon(self, obj):
        from django.utils import timezone
        import datetime
        if obj.status != 'pending':
            return False
        start_dt = datetime.datetime.combine(obj.start_date, datetime.time(0, 0))
        start_dt = timezone.make_aware(start_dt)
        return (start_dt - timezone.now()).total_seconds() < 7200

    def get_effective_pool_kes(self, obj):
        return str(obj.total_pool + obj.platform_bonus_kes)

    def get_user_is_joined(self, obj):
        request = self.context.get('request')
        if not request or not request.user.is_authenticated:
            return False
        return obj.participants.filter(user=request.user).exists()

    def get_milestone_label(self, obj):
        labels = {50000: 'Beginner', 70000: 'Intermediate', 90000: 'Advanced'}
        return labels.get(obj.milestone, f'{obj.milestone:,} steps')


class SpectatorLeaderboardSerializer(serializers.ModelSerializer):
    """
    Full leaderboard for a public challenge — viewable by non-participants.
    No private data exposed.
    """
    username = serializers.CharField(source='user.username')
    avatar_initials = serializers.SerializerMethodField()
    rank = serializers.SerializerMethodField()
    steps_display = serializers.SerializerMethodField()
    progress_pct = serializers.SerializerMethodField()
    estimated_payout = serializers.SerializerMethodField()

    class Meta:
        model = Participant
        fields = ['rank', 'username', 'avatar_initials', 'steps',
                  'steps_display', 'qualified', 'progress_pct', 'estimated_payout']

    def get_avatar_initials(self, obj):
        name = obj.user.username or obj.user.email or '?'
        return name[:2].upper()

    def get_rank(self, obj):
        return getattr(obj, '_rank', 0)

    def get_steps_display(self, obj):
        return f'{obj.steps:,}'

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
