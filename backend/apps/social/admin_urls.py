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
]
