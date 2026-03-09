from django.contrib import admin
from .models import LegalDocument, LegalDocumentVersion, UserDocumentAck


@admin.register(LegalDocument)
class LegalDocumentAdmin(admin.ModelAdmin):
    list_display = ['title', 'document_type', 'version_label', 'status', 'published_at', 'last_edited_by']
    list_filter = ['status', 'document_type']
    search_fields = ['title', 'slug']
    readonly_fields = ['version', 'version_label', 'slug', 'published_at', 'created_at', 'updated_at']


@admin.register(LegalDocumentVersion)
class LegalDocumentVersionAdmin(admin.ModelAdmin):
    list_display = ['document', 'version_label', 'published_by', 'published_at']
    list_filter = ['document']
    readonly_fields = ['document', 'version', 'version_label', 'content_html', 'published_by', 'published_at']
    
    def has_add_permission(self, request):
        return False
    
    def has_change_permission(self, request, obj=None):
        return False
    
    def has_delete_permission(self, request, obj=None):
        return False


@admin.register(UserDocumentAck)
class UserDocumentAckAdmin(admin.ModelAdmin):
    list_display = ['user', 'document', 'version_seen', 'acknowledged_at']
    list_filter = ['document', 'acknowledged_at']
    search_fields = ['user__username', 'user__email']
    readonly_fields = ['user', 'document', 'version_seen', 'acknowledged_at']
