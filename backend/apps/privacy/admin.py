from django.contrib import admin

from .models import Consent, DataExportRequest, PrivacySettings


@admin.register(PrivacySettings)
class PrivacySettingsAdmin(admin.ModelAdmin):
    list_display = ("__str__", "retention_enabled", "sync_payload_days", "risk_ml_days", "updated_at")
    readonly_fields = ("updated_at", "updated_by")

    def has_add_permission(self, request):
        return not PrivacySettings.objects.exists()

    def has_delete_permission(self, request, obj=None):
        return False


@admin.register(Consent)
class ConsentAdmin(admin.ModelAdmin):
    """Read-only: the consent ledger is evidence and is never edited."""

    list_display = ("user", "purpose", "granted", "version", "source", "created_at")
    list_filter = ("purpose", "granted", "source")
    search_fields = ("user__username",)

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False


@admin.register(DataExportRequest)
class DataExportRequestAdmin(admin.ModelAdmin):
    """Status only: the archive (personal data) is never shown to staff."""

    list_display = ("id", "user", "status", "requested_at", "finished_at", "expires_at", "size_bytes", "download_count")
    list_filter = ("status",)
    exclude = ("archive",)
    readonly_fields = [f for f in (
        "user", "status", "requested_at", "started_at", "finished_at", "expires_at", "attempts",
        "size_bytes", "sha256", "download_count", "last_downloaded_at", "error",
    )]

    def has_add_permission(self, request):
        return False
