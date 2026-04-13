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
    goal = serializers.IntegerField()
    goal_achieved = serializers.BooleanField()
