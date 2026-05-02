from rest_framework import serializers
from .models import HealthRecord, HourlyStepRecord, LocationWaypoint


class HealthRecordSerializer(serializers.ModelSerializer):
    class Meta:
        model = HealthRecord
        fields = [
            'id', 'date', 'source', 'synced_at',
            'steps', 'distance_km', 'calories_active', 'active_minutes',
            'is_suspicious',
        ]
        read_only_fields = ['id', 'synced_at', 'is_suspicious']


class HealthSyncSerializer(serializers.Serializer):
    """Validates incoming sync payload from the Capacitor app."""
    date = serializers.DateField()
    source = serializers.ChoiceField(
        choices=['device_sensor', 'google_fit', 'apple_health', 'manual'],
        default='device_sensor'
    )
    steps = serializers.IntegerField(min_value=0, max_value=100000, default=0)
    distance_km = serializers.FloatField(
        min_value=0,
        max_value=200,
        required=False,
        allow_null=True,
    )
    calories_active = serializers.IntegerField(
        min_value=0,
        max_value=10000,
        required=False,
        allow_null=True,
    )
    active_minutes = serializers.IntegerField(
        min_value=0,
        max_value=1440,
        required=False,
        allow_null=True,
    )
    cadence_spm = serializers.FloatField(
        min_value=0,
        max_value=400,
        required=False,
        allow_null=True,
    )
    burst_steps_5s = serializers.IntegerField(
        min_value=0,
        max_value=100,
        required=False,
        allow_null=True,
    )
    gait_state = serializers.ChoiceField(
        choices=['idle', 'possible_walking', 'confirmed_walking', 'suspicious_motion'],
        required=False,
        allow_null=True,
    )
    gait_confidence = serializers.FloatField(
        min_value=0,
        max_value=100,
        required=False,
        allow_null=True,
    )
    gait_dominant_freq_hz = serializers.FloatField(
        min_value=0,
        max_value=10,
        required=False,
        allow_null=True,
    )
    gait_autocorr = serializers.FloatField(
        min_value=0,
        max_value=1,
        required=False,
        allow_null=True,
    )
    gait_interval_std_ms = serializers.FloatField(
        min_value=0,
        max_value=5000,
        required=False,
        allow_null=True,
    )
    gait_valid_peaks_2s = serializers.IntegerField(
        min_value=0,
        max_value=30,
        required=False,
        allow_null=True,
    )
    gait_gyro_variance = serializers.FloatField(
        min_value=0,
        max_value=1000,
        required=False,
        allow_null=True,
    )
    gait_jerk_rms = serializers.FloatField(
        min_value=0,
        max_value=1000,
        required=False,
        allow_null=True,
    )
    carry_mode = serializers.ChoiceField(
        choices=['unknown', 'in_hand', 'pocket', 'bag'],
        required=False,
        allow_null=True,
    )
    ml_motion_label = serializers.ChoiceField(
        choices=['walk', 'shake', 'other'],
        required=False,
        allow_null=True,
    )
    ml_walk_probability = serializers.FloatField(
        min_value=0,
        max_value=1,
        required=False,
        allow_null=True,
    )
    ml_shake_probability = serializers.FloatField(
        min_value=0,
        max_value=1,
        required=False,
        allow_null=True,
    )
    ml_model_version = serializers.CharField(
        max_length=64,
        required=False,
        allow_null=True,
        allow_blank=True,
    )


class HourlyStepSerializer(serializers.ModelSerializer):
    class Meta:
        model = HourlyStepRecord
        fields = ['hour', 'steps', 'distance_km', 'calories']


class LocationWaypointSerializer(serializers.ModelSerializer):
    class Meta:
        model = LocationWaypoint
        fields = ['hour', 'recorded_at', 'latitude', 'longitude', 'accuracy_m']


class DayDetailSerializer(serializers.Serializer):
    """Combined response for a full day detail view."""
    date = serializers.DateField()
    total_steps = serializers.IntegerField()
    total_km = serializers.FloatField()
    total_calories = serializers.FloatField()
    active_minutes = serializers.IntegerField()
    peak_hour = serializers.IntegerField(allow_null=True)
    peak_steps = serializers.IntegerField()
    hourly = HourlyStepSerializer(many=True)
    waypoints = LocationWaypointSerializer(many=True)
    route_distance_km = serializers.FloatField()
    encoded_polyline = serializers.CharField()
    goal = serializers.IntegerField()
    goal_achieved = serializers.BooleanField()


# ============================================================
# NEW SERIALIZERS FOR PRODUCTION SECURITY HARDENING
# ============================================================


class StepSessionStartSerializer(serializers.Serializer):
    """Validates request to start a new step session."""
    device_id = serializers.CharField(max_length=255, required=True)
    platform = serializers.ChoiceField(
        choices=['android', 'ios', 'web'],
        required=True
    )
    app_version = serializers.CharField(
        max_length=64,
        required=False,
        allow_null=True,
        allow_blank=True,
    )
    ml_model_version = serializers.CharField(
        max_length=64,
        required=False,
        allow_null=True,
        allow_blank=True,
    )


class StepSessionStartResponseSerializer(serializers.Serializer):
    """Response when session is started."""
    session_id = serializers.UUIDField()
    session_token = serializers.CharField()
    server_nonce = serializers.CharField()
    expires_at = serializers.DateTimeField()
    sequence_start = serializers.IntegerField(default=1)
    policy_version = serializers.CharField()


class StepSessionEndSerializer(serializers.Serializer):
    """Validates request to end a session."""
    session_id = serializers.UUIDField(required=True)
    session_token = serializers.CharField(max_length=255, required=True)


class StepSessionEndResponseSerializer(serializers.Serializer):
    """Response when session is ended."""
    session_id = serializers.UUIDField()
    status = serializers.CharField()
    session_risk_score = serializers.FloatField()
    accepted_steps = serializers.IntegerField()
    rejected_steps = serializers.IntegerField()
    reward_multiplier = serializers.FloatField()
    trust_adjustment = serializers.FloatField()
    message = serializers.CharField()


class HealthSyncSerializerV2(serializers.Serializer):
    """Extended sync serializer with replay protection and session fields."""
    # Original fields (unchanged)
    date = serializers.DateField()
    source = serializers.ChoiceField(
        choices=['device_sensor', 'google_fit', 'apple_health', 'manual'],
        default='device_sensor'
    )
    steps = serializers.IntegerField(min_value=0, max_value=100000, default=0)
    distance_km = serializers.FloatField(
        min_value=0,
        max_value=200,
        required=False,
        allow_null=True,
    )
    calories_active = serializers.IntegerField(
        min_value=0,
        max_value=10000,
        required=False,
        allow_null=True,
    )
    active_minutes = serializers.IntegerField(
        min_value=0,
        max_value=1440,
        required=False,
        allow_null=True,
    )
    cadence_spm = serializers.FloatField(
        min_value=0,
        max_value=400,
        required=False,
        allow_null=True,
    )
    burst_steps_5s = serializers.IntegerField(
        min_value=0,
        max_value=100,
        required=False,
        allow_null=True,
    )
    gait_state = serializers.ChoiceField(
        choices=['idle', 'possible_walking', 'confirmed_walking', 'suspicious_motion'],
        required=False,
        allow_null=True,
    )
    gait_confidence = serializers.FloatField(
        min_value=0,
        max_value=100,
        required=False,
        allow_null=True,
    )
    gait_dominant_freq_hz = serializers.FloatField(
        min_value=0,
        max_value=10,
        required=False,
        allow_null=True,
    )
    gait_autocorr = serializers.FloatField(
        min_value=0,
        max_value=1,
        required=False,
        allow_null=True,
    )
    gait_interval_std_ms = serializers.FloatField(
        min_value=0,
        max_value=5000,
        required=False,
        allow_null=True,
    )
    gait_valid_peaks_2s = serializers.IntegerField(
        min_value=0,
        max_value=30,
        required=False,
        allow_null=True,
    )
    gait_gyro_variance = serializers.FloatField(
        min_value=0,
        max_value=1000,
        required=False,
        allow_null=True,
    )
    gait_jerk_rms = serializers.FloatField(
        min_value=0,
        max_value=1000,
        required=False,
        allow_null=True,
    )
    carry_mode = serializers.ChoiceField(
        choices=['unknown', 'in_hand', 'pocket', 'bag'],
        required=False,
        allow_null=True,
    )
    ml_motion_label = serializers.ChoiceField(
        choices=['walk', 'shake', 'other'],
        required=False,
        allow_null=True,
    )
    ml_walk_probability = serializers.FloatField(
        min_value=0,
        max_value=1,
        required=False,
        allow_null=True,
    )
    ml_shake_probability = serializers.FloatField(
        min_value=0,
        max_value=1,
        required=False,
        allow_null=True,
    )
    ml_model_version = serializers.CharField(
        max_length=64,
        required=False,
        allow_null=True,
        allow_blank=True,
    )
    # New smoothed ML fields
    smoothed_walk_probability = serializers.FloatField(
        min_value=0,
        max_value=1,
        required=False,
        allow_null=True,
    )
    smoothed_shake_probability = serializers.FloatField(
        min_value=0,
        max_value=1,
        required=False,
        allow_null=True,
    )
    ml_confidence_stability = serializers.FloatField(
        min_value=0,
        max_value=1,
        required=False,
        allow_null=True,
    )
    ml_window_count = serializers.IntegerField(
        min_value=0,
        required=False,
        allow_null=True,
    )
    motion_entropy = serializers.FloatField(
        min_value=0,
        required=False,
        allow_null=True,
    )
    # Session and replay protection fields
    session_id = serializers.UUIDField(required=False, allow_null=True)
    session_token = serializers.CharField(
        max_length=255,
        required=False,
        allow_null=True,
        allow_blank=True,
    )
    client_event_id = serializers.CharField(
        max_length=255,
        required=False,
        allow_null=True,
        allow_blank=True,
    )
    sequence_number = serializers.IntegerField(
        min_value=1,
        required=False,
        allow_null=True,
    )
    timestamp_client = serializers.DateTimeField(required=False, allow_null=True)
    payload_hash = serializers.CharField(
        max_length=255,
        required=False,
        allow_null=True,
        allow_blank=True,
    )
    steps_delta = serializers.IntegerField(
        min_value=0,
        max_value=10000,
        required=False,
        allow_null=True,
    )
    steps_total = serializers.IntegerField(
        min_value=0,
        required=False,
        allow_null=True,
    )


class UserTrustProfileSerializer(serializers.Serializer):
    """User trust profile data for client response."""
    trust_score = serializers.FloatField()
    trust_tier = serializers.CharField()
    verified_sessions_count = serializers.IntegerField()
    suspicious_sessions_count = serializers.IntegerField()
    total_accepted_steps = serializers.IntegerField()
    total_rejected_steps = serializers.IntegerField()


class AntiCheatPolicyPublicSerializer(serializers.Serializer):
    """Public anti-cheat policy configuration (non-sensitive operational values)."""
    version = serializers.CharField()
    session_max_hours = serializers.IntegerField()
    sync_interval_seconds = serializers.IntegerField()
    # Add other non-sensitive config values as needed


# Keep the original import contract used by sync_health/views.
HealthSyncSerializer = HealthSyncSerializerV2
