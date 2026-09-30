"""Routes for apps/admin_api/console_b_views.py (included from admin_api/urls.py)."""

from django.urls import path

from apps.admin_api import console_b_views as v

urlpatterns = [
    # ROLE: settings
    path("monitoring/jobs/<str:name>/runs/", v.job_runs, name="scheduled-job-runs"),
    path("monitoring/jobs/<str:name>/pause/", v.job_pause, name="scheduled-job-pause"),
    path("monitoring/jobs/<str:name>/resume/", v.job_resume, name="scheduled-job-resume"),
    # ROLE: trust
    path("privacy/exports/", v.export_queue, name="privacy-export-queue"),
    path("privacy/exports/<uuid:export_id>/retry/", v.export_retry, name="privacy-export-retry"),
    # ROLE: trust (read) / owner (create, activate)
    path("anticheat/policies/", v.anticheat_policies, name="anticheat-policies"),
    path("anticheat/policies/<uuid:policy_id>/activate/", v.anticheat_policy_activate, name="anticheat-policy-activate"),
    # ROLE: content (support agents)
    path("support/tickets/outbound/", v.support_outbound, name="support-outbound"),
    path("support/tickets/bulk/", v.support_bulk, name="support-bulk"),
    path("support/tickets/<int:ticket_id>/merge/", v.support_merge, name="support-merge"),
]
