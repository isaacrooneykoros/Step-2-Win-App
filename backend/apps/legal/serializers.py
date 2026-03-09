from rest_framework import serializers
from .models import LegalDocument, LegalDocumentVersion, UserDocumentAck


class LegalDocumentPublicSerializer(serializers.ModelSerializer):
    """
    What the mobile app receives — only published documents, no admin fields.
    """
    has_update = serializers.SerializerMethodField()

    class Meta:
        model  = LegalDocument
        fields = [
            'id', 'document_type', 'title', 'slug',
            'content_html', 'version', 'version_label',
            'notify_users', 'change_summary',
            'published_at', 'has_update',
            # uploaded_file URL for download button
            'uploaded_file',
        ]

    def get_has_update(self, obj):
        """
        Returns True if the current user has not acknowledged this version.
        Used to show "Updated" badge in the app.
        """
        request = self.context.get('request')
        if not request or not request.user.is_authenticated:
            return False
        ack = UserDocumentAck.objects.filter(
            user=request.user, document=obj
        ).first()
        if not ack:
            return obj.notify_users   # never read at all
        return ack.version_seen < obj.version and obj.notify_users


class LegalDocumentAdminSerializer(serializers.ModelSerializer):
    """
    Full serializer for the admin panel — includes all fields.
    """
    last_edited_by_username = serializers.SerializerMethodField()
    history_count           = serializers.SerializerMethodField()

    class Meta:
        model  = LegalDocument
        fields = [
            'id', 'document_type', 'title', 'slug',
            'content_html', 'uploaded_file', 'file_type',
            'version', 'version_label', 'status',
            'notify_users', 'change_summary',
            'last_edited_by', 'last_edited_by_username',
            'published_at', 'created_at', 'updated_at',
            'history_count',
        ]
        read_only_fields = [
            'version', 'version_label', 'slug',
            'published_at', 'created_at', 'updated_at',
        ]

    def get_last_edited_by_username(self, obj):
        return obj.last_edited_by.username if obj.last_edited_by else None

    def get_history_count(self, obj):
        return obj.history.count()


class LegalDocumentVersionSerializer(serializers.ModelSerializer):
    published_by_username = serializers.SerializerMethodField()

    class Meta:
        model  = LegalDocumentVersion
        fields = [
            'id', 'version', 'version_label', 'content_html',
            'published_by', 'published_by_username',
            'published_at', 'change_summary',
        ]

    def get_published_by_username(self, obj):
        return obj.published_by.username if obj.published_by else 'System'
