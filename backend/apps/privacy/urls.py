from django.urls import path

from . import views

app_name = "privacy"

urlpatterns = [
    path("consents/", views.consents, name="consents"),
    path("exports/", views.exports, name="exports"),
    path("exports/<uuid:export_id>/download/", views.export_download, name="export-download"),
    path("summary/", views.summary, name="summary"),
    path("admin/settings/", views.admin_settings, name="admin-settings"),
]
