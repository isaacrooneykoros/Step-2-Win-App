from django.contrib import admin

from .models import (Block, FeedEvent, FriendRequest, SocialReport,
                     SocialSettings, Team, TeamMembership, WeeklyArchive)


@admin.register(SocialSettings)
class SocialSettingsAdmin(admin.ModelAdmin):
    list_display = ["social_enabled", "teams_enabled", "feed_enabled", "max_team_members", "updated_at"]


@admin.register(Team)
class TeamAdmin(admin.ModelAdmin):
    list_display = ["name", "visibility", "member_count", "is_disabled", "created_at"]
    list_filter = ["visibility", "is_disabled"]
    search_fields = ["name"]


@admin.register(TeamMembership)
class TeamMembershipAdmin(admin.ModelAdmin):
    list_display = ["team", "user", "role", "joined_at"]
    raw_id_fields = ["team", "user"]


@admin.register(FriendRequest)
class FriendRequestAdmin(admin.ModelAdmin):
    list_display = ["from_user", "to_user", "status", "created_at"]
    list_filter = ["status"]
    raw_id_fields = ["from_user", "to_user"]


@admin.register(Block)
class BlockAdmin(admin.ModelAdmin):
    list_display = ["blocker", "blocked", "created_at"]
    raw_id_fields = ["blocker", "blocked"]


@admin.register(SocialReport)
class SocialReportAdmin(admin.ModelAdmin):
    list_display = ["target_type", "reason", "status", "created_at"]
    list_filter = ["status", "target_type", "reason"]
    raw_id_fields = ["reporter", "target_user", "target_team", "reviewed_by"]


@admin.register(FeedEvent)
class FeedEventAdmin(admin.ModelAdmin):
    list_display = ["user", "kind", "key", "created_at"]
    list_filter = ["kind"]
    raw_id_fields = ["user"]


@admin.register(WeeklyArchive)
class WeeklyArchiveAdmin(admin.ModelAdmin):
    list_display = ["week_start", "users_ranked", "teams_ranked", "friends_winners", "finalized_at"]
