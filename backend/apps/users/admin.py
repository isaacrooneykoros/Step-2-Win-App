from django.contrib import admin
from django.contrib.auth.admin import UserAdmin as BaseUserAdmin
from .models import User, UserXP


@admin.register(User)
class UserAdmin(BaseUserAdmin):
    """
    Custom admin for User model
    """
    list_display = [
        'username', 'email', 'phone_number', 'wallet_balance', 'locked_balance',
        'total_steps', 'challenges_won', 'device_bound', 'is_active'
    ]
    list_filter = ['is_active', 'is_staff', 'device_platform', 'created_at']
    search_fields = ['username', 'email', 'phone_number', 'device_id']
    ordering = ['-created_at']
    
    fieldsets = (
        ('Primary Account Information', {
            'description': 'Core user identity and contact details',
            'fields': ('username', 'email', 'phone_number')
        }),
        ('Authentication', {
            'fields': ('password',)
        }),
        ('Personal', {
            'fields': ('first_name', 'last_name')
        }),
        ('Permissions', {
            'fields': ('is_active', 'is_staff', 'is_superuser', 'groups', 'user_permissions')
        }),
        ('Wallet & Stats', {
            'fields': ('wallet_balance', 'locked_balance', 'total_steps', 
                      'challenges_won', 'total_earned', 'current_streak', 'challenges_joined')
        }),
        ('Device', {
            'fields': ('device_id', 'device_platform')
        }),
        ('Calibration', {
            'fields': ('calibration_quality', 'calibration_variance_pct', 'last_calibrated_at'),
            'classes': ('collapse',)
        }),
        ('Physical Profile', {
            'fields': ('daily_goal', 'stride_length_cm', 'weight_kg'),
            'classes': ('collapse',)
        }),
        ('Trust & Security', {
            'fields': ('trust_score', 'trust_status'),
            'classes': ('collapse',)
        }),
        ('Timestamps', {
            'fields': ('created_at', 'updated_at', 'date_joined', 'last_login'),
            'classes': ('collapse',)
        }),
    )
    
    readonly_fields = ['created_at', 'updated_at', 'wallet_balance', 'locked_balance']
    
    def device_bound(self, obj):
        return obj.device_id is not None
    device_bound.boolean = True
    device_bound.short_description = 'Device Bound'


@admin.register(UserXP)
class UserXPAdmin(admin.ModelAdmin):
    """
    Admin for UserXP gamification profile
    """
    list_display = ['user', 'level', 'total_xp', 'xp_this_week', 'created_at']
    list_filter = ['level', 'created_at', 'weekly_reset']
    search_fields = ['user__username', 'user__email']
    readonly_fields = ['created_at', 'updated_at']
    date_hierarchy = 'created_at'
    fieldsets = (
        ('User', {
            'fields': ('user',)
        }),
        ('Level & XP', {
            'fields': ('level', 'total_xp', 'xp_this_week')
        }),
        ('Reset Times', {
            'fields': ('weekly_reset',),
            'classes': ('collapse',)
        }),
        ('Timestamps', {
            'fields': ('created_at', 'updated_at'),
            'classes': ('collapse',)
        }),
    )

