from django.contrib import admin
from .models import FraudFlag, HealthRecord, SuspiciousActivity, TrustScore


@admin.register(HealthRecord)
class HealthRecordAdmin(admin.ModelAdmin):
    list_display = [
        'user', 'date', 'steps', 'distance_km',
        'calories_active', 'active_minutes', 'source', 'is_suspicious'
    ]
    list_filter = ['source', 'is_suspicious']
    search_fields = ['user__username']
    ordering = ['-date']


@admin.register(SuspiciousActivity)
class SuspiciousActivityAdmin(admin.ModelAdmin):
    list_display = ['user', 'date', 'steps_submitted', 'reason', 'reviewed']
    list_filter = ['reviewed']
    search_fields = ['user__username']


@admin.register(FraudFlag)
class FraudFlagAdmin(admin.ModelAdmin):
    list_display = ['user', 'flag_type', 'severity', 'date', 'reviewed', 'actioned']
    list_filter = ['severity', 'flag_type', 'reviewed']
    search_fields = ['user__username']
    ordering = ['-created_at']


@admin.register(TrustScore)
class TrustScoreAdmin(admin.ModelAdmin):
    list_display = ['user', 'score', 'status', 'flags_total', 'updated_at']
    list_filter = ['score']
    search_fields = ['user__username']
    ordering = ['score']
