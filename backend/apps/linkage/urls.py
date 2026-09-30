from django.urls import path

from . import views

app_name = "linkage"

urlpatterns = [
    path("users/<int:user_id>/linked/", views.user_linked_accounts, name="user-linked"),
    path("users/<int:user_id>/timeline/", views.user_timeline, name="user-timeline"),
    path("clusters/", views.cluster_list, name="clusters"),
    path("households/", views.mark_household, name="households"),
    path("households/<int:mark_id>/revoke/", views.revoke_household, name="household-revoke"),
    path("settings/", views.linkage_settings, name="settings"),
    path("runs/", views.linkage_runs, name="runs"),  # ROLE: trust
]
