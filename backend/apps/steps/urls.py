from django.urls import path

from . import security_endpoints, views, walk_views

app_name = "steps"

urlpatterns = [
    # Phase 1b: reinstall resume, walks, privacy zone, step-session integrity
    path("resume/", views.resume_day, name="resume_day"),
    path("walks/", walk_views.list_walks, name="walk_list"),
    path("walks/start/", walk_views.start_walk, name="walk_start"),
    path("walks/privacy-zone/", walk_views.privacy_zone, name="walk_privacy_zone"),
    path("walks/<str:walk_id>/", walk_views.walk_detail, name="walk_detail"),
    path("walks/<str:walk_id>/points/", walk_views.walk_points, name="walk_points"),
    path("walks/<str:walk_id>/finish/", walk_views.finish_walk, name="walk_finish"),
    path("walks/<str:walk_id>/integrity/", walk_views.walk_integrity, name="walk_integrity"),
    path(
        "session/integrity/",
        security_endpoints.step_session_integrity,
        name="session_integrity",
    ),
    path("sync/", views.sync_health, name="sync_health"),
    path("today/", views.today_health, name="today_health"),
    path("summary/", views.health_summary, name="health_summary"),
    path("history/", views.health_history, name="health_history"),
    path("weekly/", views.weekly_steps, name="weekly_steps"),
    path("day/<str:date_str>/", views.day_detail, name="day_detail"),
    path("sync/hourly/", views.sync_hourly_steps, name="sync_hourly_steps"),
    path("verification/", views.step_verification, name="step_verification"),
    # Security endpoints
    path("session/start/", security_endpoints.start_step_session, name="session_start"),
    path("session/end/", security_endpoints.end_step_session, name="session_end"),
    path(
        "trust/profile/",
        security_endpoints.get_user_trust_profile,
        name="trust_profile",
    ),
    path("policy/active/", security_endpoints.get_active_policy, name="policy_active"),
]
