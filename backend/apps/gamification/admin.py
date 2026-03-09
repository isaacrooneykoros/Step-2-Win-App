from django.contrib import admin
from apps.gamification.models import Badge, UserBadge, XPEvent, LevelMilestone, DailyLoginStreak


@admin.register(Badge)
class BadgeAdmin(admin.ModelAdmin):
    list_display = ['icon', 'name', 'badge_type', 'criteria_type', 'criteria_value', 'color']
    list_filter = ['badge_type', 'criteria_type', 'created_at']
    search_fields = ['slug', 'name', 'description']
    readonly_fields = ['created_at', 'updated_at']
    fieldsets = (
        ('Basic Info', {
            'fields': ('slug', 'name', 'description', 'icon', 'color')
        }),
        ('Badge Type', {
            'fields': ('badge_type', 'criteria_type', 'criteria_value')
        }),
        ('Timestamps', {
            'fields': ('created_at', 'updated_at'),
            'classes': ('collapse',)
        }),
    )
    prepopulated_fields = {'slug': ('name',)}


@admin.register(UserBadge)
class UserBadgeAdmin(admin.ModelAdmin):
    list_display = ['badge', 'user', 'earned_at', 'is_new']
    list_filter = ['badge', 'earned_at', 'is_new']
    search_fields = ['user__username', 'badge__name']
    readonly_fields = ['earned_at']
    date_hierarchy = 'earned_at'


@admin.register(XPEvent)
class XPEventAdmin(admin.ModelAdmin):
    list_display = ['user', 'event_type', 'amount', 'created_at', 'processed']
    list_filter = ['event_type', 'created_at', 'processed']
    search_fields = ['user__username', 'description']
    readonly_fields = ['user', 'created_at']
    date_hierarchy = 'created_at'
    actions = ['mark_as_processed']

    def mark_as_processed(self, request, queryset):
        updated = queryset.update(processed=True)
        self.message_user(request, f"{updated} events marked as processed.")
    mark_as_processed.short_description = "Mark selected as processed"


@admin.register(LevelMilestone)
class LevelMilestoneAdmin(admin.ModelAdmin):
    list_display = ['user', 'level', 'total_xp', 'reached_at']
    list_filter = ['level', 'reached_at']
    search_fields = ['user__username']
    readonly_fields = ['reached_at']
    date_hierarchy = 'reached_at'


@admin.register(DailyLoginStreak)
class DailyLoginStreakAdmin(admin.ModelAdmin):
    list_display = ['user', 'current_streak', 'longest_streak', 'total_logins', 'last_login_date']
    list_filter = ['last_login_date', 'updated_at']
    search_fields = ['user__username']
    readonly_fields = ['created_at', 'updated_at']
    fieldsets = (
        ('User', {
            'fields': ('user',)
        }),
        ('Streak Data', {
            'fields': ('current_streak', 'longest_streak', 'last_login_date', 'total_logins')
        }),
        ('Timestamps', {
            'fields': ('created_at', 'updated_at'),
            'classes': ('collapse',)
        }),
    )
