from django.contrib import admin
from django.utils.html import format_html
from .models import Challenge, Participant, ChallengeMessage, ChallengeResult


@admin.register(Challenge)
class ChallengeAdmin(admin.ModelAdmin):
    """
    Admin interface for challenges
    """
    list_display = [
        'name', 'is_public', 'is_featured', 'status',
        'participant_count', 'total_pool', 'entry_fee',
        'start_date', 'end_date'
    ]
    list_filter = ['is_public', 'is_featured', 'status', 'theme']
    list_editable = ['is_featured', 'is_public']
    search_fields = ['name']
    readonly_fields = ['view_count', 'total_pool', 'invite_code']
    ordering = ['-created_at']
    date_hierarchy = 'created_at'

    fieldsets = [
        ('Challenge Info', {
            'fields': ['name', 'status', 'milestone', 'entry_fee',
                       'start_date', 'end_date', 'max_participants', 'theme']
        }),
        ('Visibility', {
            'fields': ['is_public', 'is_featured', 'featured_until',
                       'is_platform_challenge', 'platform_bonus_kes']
        }),
        ('Stats', {
            'fields': ['total_pool', 'view_count', 'invite_code'],
            'classes': ['collapse']
        }),
    ]
    
    actions = ['activate_challenges', 'complete_challenges', 'cancel_challenges']
    
    def participant_count(self, obj):
        return obj.participants.count()
    participant_count.short_description = 'Participants'
    
    def activate_challenges(self, request, queryset):
        updated = queryset.filter(status='pending').update(status='active')
        self.message_user(request, f'{updated} challenge(s) activated')
    activate_challenges.short_description = 'Activate selected challenges'
    
    def complete_challenges(self, request, queryset):
        updated = queryset.filter(status='active').update(status='completed')
        self.message_user(request, f'{updated} challenge(s) marked as completed')
    complete_challenges.short_description = 'Complete selected challenges'
    
    def cancel_challenges(self, request, queryset):
        # Only cancel pending challenges
        updated = queryset.filter(status='pending').update(status='cancelled')
        self.message_user(request, f'{updated} challenge(s) cancelled')
    cancel_challenges.short_description = 'Cancel selected pending challenges'


@admin.register(Participant)
class ParticipantAdmin(admin.ModelAdmin):
    """
    Admin interface for participants
    """
    list_display = [
        'user', 'challenge', 'steps', 'progress_bar',
        'qualified', 'payout', 'joined_at'
    ]
    list_filter = ['qualified', 'challenge__status', 'joined_at']
    search_fields = ['user__username', 'user__email', 'challenge__name']
    readonly_fields = ['joined_at', 'progress_percentage']
    ordering = ['-joined_at']
    date_hierarchy = 'joined_at'
    
    fieldsets = (
        ('Participant Info', {
            'fields': ('challenge', 'user', 'joined_at')
        }),
        ('Progress', {
            'fields': ('steps', 'qualified', 'progress_percentage')
        }),
        ('Payout', {
            'fields': ('payout', 'rank')
        }),
    )
    
    def progress_bar(self, obj):
        percentage = obj.progress_percentage
        color = 'green' if obj.qualified else 'orange' if percentage > 50 else 'red'
        return format_html(
            '<div style="width:100px; background:#ddd; border-radius:3px;">'
            '<div style="width:{}px; background:{}; height:20px; border-radius:3px; text-align:center; color:white; font-size:11px; line-height:20px;">'
            '{}%'
            '</div></div>',
            percentage,
            color,
            percentage
        )
    progress_bar.short_description = 'Progress'


@admin.register(ChallengeMessage)
class ChallengeMessageAdmin(admin.ModelAdmin):
    """
    Admin interface for challenge chat messages
    """
    list_display = ['challenge', 'user', 'message_preview', 'is_system', 'created_at']
    list_filter = ['is_system', 'event_type', 'created_at']
    search_fields = ['message', 'challenge__name', 'user__username']
    readonly_fields = ['created_at']
    ordering = ['-created_at']
    date_hierarchy = 'created_at'
    
    def message_preview(self, obj):
        return obj.message[:100] + '...' if len(obj.message) > 100 else obj.message
    message_preview.short_description = 'Message'


@admin.register(ChallengeResult)
class ChallengeResultAdmin(admin.ModelAdmin):
    """
    Admin interface for challenge results — IMMUTABLE audit trail
    """
    list_display = [
        'challenge', 'user', 'final_steps', 'final_rank',
        'payout_kes', 'payout_method', 'tied_with_count',
        'tiebreaker_level', 'finalized_at'
    ]
    list_filter = ['payout_method', 'tiebreaker_level', 'qualified']
    search_fields = ['user__username', 'challenge__name']
    readonly_fields = [f.name for f in ChallengeResult._meta.fields]  # all readonly
    ordering = ['-finalized_at']
    date_hierarchy = 'finalized_at'

    def has_add_permission(self, request):
        return False   # never create manually

    def has_delete_permission(self, request, obj=None):
        return False   # never delete — financial records

    def has_change_permission(self, request, obj=None):
        return False   # immutable
