from django.urls import path

from . import admin_views

app_name = "social_admin"

urlpatterns = [
    path("settings/", admin_views.social_settings_view, name="settings"),
    path("overview/", admin_views.overview, name="overview"),
    path("reports/", admin_views.reports, name="reports"),
    path("reports/<int:report_id>/resolve/", admin_views.resolve_report, name="resolve-report"),
    path("teams/", admin_views.teams_list, name="teams"),
    path("teams/<int:team_id>/moderate/", admin_views.moderate_team, name="moderate-team"),
    # Admin console Part B. ROLE: trust
    path("teams/<int:team_id>/", admin_views.team_delete, name="team-delete"),
    path("teams/<int:team_id>/members/", admin_views.team_members, name="team-members"),
    path("teams/<int:team_id>/members/<int:user_id>/remove/", admin_views.team_remove_member, name="team-remove-member"),
    path("teams/<int:team_id>/transfer/", admin_views.team_transfer_ownership, name="team-transfer"),
    path("feed/", admin_views.feed_items, name="feed-items"),
    path("feed/<int:event_id>/<str:verb>/", admin_views.feed_item_visibility, name="feed-item-visibility"),
    path("challenge-messages/", admin_views.challenge_messages, name="challenge-messages"),
    path("challenge-messages/<int:message_id>/<str:verb>/", admin_views.challenge_message_visibility,
         name="challenge-message-visibility"),
]
