import logging

from drf_spectacular.utils import OpenApiTypes, extend_schema, inline_serializer
from rest_framework import serializers
from rest_framework.decorators import (api_view, parser_classes,
                                       permission_classes)
from rest_framework.parsers import FormParser, JSONParser, MultiPartParser
from rest_framework.permissions import AllowAny, IsAdminUser, IsAuthenticated
from rest_framework.response import Response

from .models import LegalDocument, LegalDocumentVersion, UserDocumentAck
from .serializers import (LegalDocumentAdminSerializer,
                          LegalDocumentPublicSerializer,
                          LegalDocumentVersionSerializer)
from .utils import process_uploaded_file

logger = logging.getLogger(__name__)

# Customers must always be able to read these; publish a new version instead of archiving.
NEVER_ARCHIVE = ("terms_and_conditions", "privacy_policy")


def _audit(request, action, doc, description, changes=None):
    """Every staff write on legal documents lands in the admin audit log."""
    from apps.admin_api.models import AuditLog

    AuditLog.log_action(
        admin=request.user, action=action, resource_type="legal_document", resource_id=doc.pk,
        resource_name=f"{doc.title} v{doc.version_label}"[:255], description=description,
        changes=changes, request=request,
    )


# ── PUBLIC ENDPOINTS (mobile app) ────────────────────────────────────────────


@extend_schema(responses={200: LegalDocumentPublicSerializer(many=True)})
@api_view(["GET"])
@permission_classes([AllowAny])
def list_documents_public(request):
    """
    Returns all published legal documents.
    Called by mobile app to show list of available documents.
    No authentication required — policies must be readable before login.
    """
    docs = LegalDocument.objects.filter(status="published")
    serializer = LegalDocumentPublicSerializer(
        docs, many=True, context={"request": request}
    )
    return Response(serializer.data)


@extend_schema(
    responses={
        200: LegalDocumentPublicSerializer,
        404: inline_serializer(
            name="LegalDocPublicNotFound",
            fields={"error": serializers.CharField()},
        ),
    }
)
@api_view(["GET"])
@permission_classes([AllowAny])
def get_document_public(request, slug):
    """
    Returns a single published legal document by slug.
    e.g. GET /api/legal/privacy-policy/

    Used when user taps "Privacy Policy" in the app.
    """
    try:
        doc = LegalDocument.objects.get(slug=slug, status="published")
    except LegalDocument.DoesNotExist:
        return Response(
            {"error": f'Document "{slug}" not found or not yet published.'}, status=404
        )
    serializer = LegalDocumentPublicSerializer(doc, context={"request": request})
    return Response(serializer.data)


@extend_schema(
    request=None,
    responses={
        200: inline_serializer(
            name="AcknowledgeDocumentResponse",
            fields={
                "acknowledged": serializers.BooleanField(),
                "version": serializers.IntegerField(),
            },
        ),
        404: inline_serializer(
            name="AcknowledgeDocumentNotFound",
            fields={"error": serializers.CharField()},
        ),
    },
)
@api_view(["POST"])
@permission_classes([IsAuthenticated])
def acknowledge_document(request, slug):
    """
    Records that the authenticated user has read the current version.
    Called when user scrolls to the bottom of a legal document.
    Clears the "Updated" badge for this user.

    POST /api/legal/privacy-policy/acknowledge/
    """
    try:
        doc = LegalDocument.objects.get(slug=slug, status="published")
    except LegalDocument.DoesNotExist:
        return Response({"error": "Document not found"}, status=404)

    UserDocumentAck.objects.update_or_create(
        user=request.user, document=doc, defaults={"version_seen": doc.version}
    )
    return Response({"acknowledged": True, "version": doc.version})


# ── ADMIN ENDPOINTS ───────────────────────────────────────────────────────────


@extend_schema(responses={200: LegalDocumentAdminSerializer(many=True)})
@api_view(["GET"])
@permission_classes([IsAdminUser])
def list_documents_admin(request):
    """
    Returns all documents (all statuses) for the admin panel.
    """
    docs = LegalDocument.objects.all().order_by("document_type")
    serializer = LegalDocumentAdminSerializer(docs, many=True)
    return Response(serializer.data)


@extend_schema(
    request=LegalDocumentAdminSerializer,
    responses={
        200: LegalDocumentAdminSerializer,
        400: inline_serializer(
            name="LegalDocumentAdminBadRequest",
            fields={"error": serializers.CharField(required=False)},
        ),
        404: inline_serializer(
            name="LegalDocumentAdminNotFound",
            fields={"error": serializers.CharField()},
        ),
    },
)
@api_view(["GET", "PUT", "PATCH", "DELETE"])
@permission_classes([IsAdminUser])
@parser_classes([MultiPartParser, FormParser, JSONParser])
def document_detail_admin(request, pk):
    # ROLE: content
    """
    GET  — fetch single document for editing
    PUT/PATCH — update document content (text or file upload)

    File upload flow:
      1. Admin uploads DOCX/PDF via multipart form
      2. Backend converts to HTML using mammoth
      3. content_html is updated automatically
      4. Original file is stored for download
    """
    try:
        doc = LegalDocument.objects.get(pk=pk)
    except LegalDocument.DoesNotExist:
        return Response({"error": "Document not found"}, status=404)

    if request.method == "GET":
        serializer = LegalDocumentAdminSerializer(doc)
        return Response(serializer.data)

    if request.method == "DELETE":
        # Only drafts that were never published: anything customers may have read
        # (or accepted) stays, and is archived instead.
        if doc.status != "draft" or doc.published_at or doc.history.exists() or doc.user_acks.exists():
            return Response(
                {"error": "Only drafts that were never published can be deleted. Archive it instead."},
                status=409,
            )
        _audit(request, "delete", doc, f"Deleted draft legal document {doc.title}",
               {"document_type": doc.document_type})
        doc.delete()
        return Response(status=204)

    # PUT / PATCH
    uploaded_file = request.FILES.get("uploaded_file")
    data = request.data.copy()

    # Edits are staged as a draft. They only reach users through publish, so
    # saving work on a published policy never changes what users see.
    if "content_html" in data:
        staged = data.get("content_html")
        del data["content_html"]
        data["draft_html"] = staged or ""

    if uploaded_file:
        # Convert file to HTML automatically
        try:
            html, file_type = process_uploaded_file(uploaded_file, uploaded_file.name)
            data["draft_html"] = html
            data["file_type"] = file_type
            # Save the original file
            doc.uploaded_file = uploaded_file
        except ValueError as e:
            return Response({"error": str(e)}, status=400)

    serializer = LegalDocumentAdminSerializer(
        doc, data=data, partial=(request.method == "PATCH")
    )
    if serializer.is_valid():
        before = {k: getattr(doc, k) for k in serializer.validated_data if k != "uploaded_file"}
        serializer.save(last_edited_by=request.user)
        changes = {}
        for k, old in before.items():
            new = getattr(doc, k)
            if old != new:
                changes[k] = (
                    {"old": f"{len(old or '')} chars", "new": f"{len(new or '')} chars"}
                    if k in ("draft_html", "content_html") else {"old": str(old), "new": str(new)}
                )
        if uploaded_file:
            changes["uploaded_file"] = {"new": uploaded_file.name}
        if changes:
            _audit(request, "update", doc, f"Edited draft of {doc.title}", changes)
        return Response(serializer.data)
    return Response(serializer.errors, status=400)


@extend_schema(
    request=LegalDocumentAdminSerializer,
    responses={
        201: LegalDocumentAdminSerializer,
        400: inline_serializer(
            name="CreateLegalDocumentBadRequest",
            fields={"error": serializers.CharField(required=False)},
        ),
    },
)
@api_view(["POST"])
@permission_classes([IsAdminUser])
def create_document_admin(request):
    """
    Create a new legal document (e.g. a Cookie Policy).
    POST /api/legal/admin/documents/create/
    """
    serializer = LegalDocumentAdminSerializer(data=request.data)
    if serializer.is_valid():
        doc = serializer.save(last_edited_by=request.user)
        _audit(request, "create", doc, f"Created legal document {doc.title} (draft)",
               {"document_type": doc.document_type})
        return Response(LegalDocumentAdminSerializer(doc).data, status=201)
    return Response(serializer.errors, status=400)


@extend_schema(
    request=inline_serializer(
        name="PublishDocumentRequest",
        fields={
            "notify_users": serializers.BooleanField(required=False),
            "change_summary": serializers.CharField(required=False),
        },
    ),
    responses={
        200: inline_serializer(
            name="PublishDocumentResponse",
            fields={
                "published": serializers.BooleanField(),
                "version": serializers.IntegerField(),
                "version_label": serializers.CharField(),
                "notify_users": serializers.BooleanField(),
                "published_at": serializers.DateTimeField(),
            },
        ),
        400: inline_serializer(
            name="PublishDocumentBadRequest",
            fields={"error": serializers.CharField()},
        ),
        404: inline_serializer(
            name="PublishDocumentNotFound",
            fields={"error": serializers.CharField()},
        ),
    },
)
@api_view(["POST"])
@permission_classes([IsAdminUser])
def publish_document(request, pk):
    """
    Publish a document. Increments version, saves to history, notifies users.

    POST /api/legal/admin/documents/<pk>/publish/
    Body: { "notify_users": true, "change_summary": "Updated Section 5" }
    """
    try:
        doc = LegalDocument.objects.get(pk=pk)
    except LegalDocument.DoesNotExist:
        return Response({"error": "Document not found"}, status=404)

    staged = doc.draft_html if doc.draft_html.strip() else doc.content_html
    if not staged.strip():
        return Response(
            {"error": "Cannot publish an empty document. Add content first."},
            status=400,
        )

    notify = request.data.get("notify_users", False)
    change_summary = request.data.get("change_summary", "")

    # Save historical version BEFORE incrementing
    old_version = doc.version
    if doc.status == "published":
        # Save current version to history before overwriting
        LegalDocumentVersion.objects.get_or_create(
            document=doc,
            version=old_version,
            defaults={
                "version_label": doc.version_label,
                "content_html": doc.content_html,
                "published_by": doc.last_edited_by,
                "change_summary": doc.change_summary,
            },
        )

    doc.notify_users = notify
    doc.change_summary = change_summary
    doc.content_html = staged
    doc.draft_html = ""
    doc.publish(user=request.user)

    # Save new version to history
    LegalDocumentVersion.objects.create(
        document=doc,
        version=doc.version,
        version_label=doc.version_label,
        content_html=doc.content_html,
        published_by=request.user,
        change_summary=change_summary,
    )

    logger.info(
        f"Legal document published: {doc.title} v{doc.version_label} "
        f"by {request.user.username}"
    )
    _audit(request, "publish", doc, f"Published {doc.title} v{doc.version_label}",
           {"version": {"old": old_version, "new": doc.version}, "notify_users": bool(notify),
            "change_summary": change_summary})

    return Response(
        {
            "published": True,
            "version": doc.version,
            "version_label": doc.version_label,
            "notify_users": doc.notify_users,
            "published_at": doc.published_at,
        }
    )


@extend_schema(
    responses={
        200: inline_serializer(
            name="DocumentHistoryResponse",
            fields={
                "document": serializers.CharField(),
                "current_version": serializers.CharField(),
                "history": LegalDocumentVersionSerializer(many=True),
            },
        ),
        404: inline_serializer(
            name="DocumentHistoryNotFound",
            fields={"error": serializers.CharField()},
        ),
    }
)
@api_view(["GET"])
@permission_classes([IsAdminUser])
def document_history(request, pk):
    """
    Returns all historical versions of a document.
    GET /api/legal/admin/documents/<pk>/history/
    """
    try:
        doc = LegalDocument.objects.get(pk=pk)
    except LegalDocument.DoesNotExist:
        return Response({"error": "Document not found"}, status=404)

    versions = doc.history.all()
    serializer = LegalDocumentVersionSerializer(versions, many=True)
    return Response(
        {
            "document": doc.title,
            "current_version": doc.version_label,
            "history": serializer.data,
        }
    )


@extend_schema(
    request=None,
    responses={
        200: inline_serializer(
            name="RestoreVersionResponse",
            fields={
                "restored": serializers.BooleanField(),
                "from_version": serializers.CharField(),
                "message": serializers.CharField(),
            },
        ),
        404: inline_serializer(
            name="RestoreVersionNotFound",
            fields={"error": serializers.CharField()},
        ),
    },
)
@api_view(["POST"])
@permission_classes([IsAdminUser])
def restore_version(request, pk, version_id):
    """
    Restore a historical version as the current draft.
    POST /api/legal/admin/documents/<pk>/restore/<version_id>/
    """
    try:
        doc = LegalDocument.objects.get(pk=pk)
        version = LegalDocumentVersion.objects.get(pk=version_id, document=doc)
    except (LegalDocument.DoesNotExist, LegalDocumentVersion.DoesNotExist):
        return Response({"error": "Document or version not found"}, status=404)

    # Restore into the draft; the live version stays online until the admin
    # reviews and publishes it.
    doc.draft_html = version.content_html
    doc.last_edited_by = request.user
    doc.save()
    _audit(request, "restore", doc, f"Restored v{version.version_label} of {doc.title} into the draft",
           {"from_version": version.version})

    return Response(
        {
            "restored": True,
            "from_version": version.version_label,
            "message": f"Content restored from v{version.version_label}. "
            f"Review and publish to make it live.",
        }
    )


# ── Archive / unarchive / acceptance stats (admin console Part B) ─────────────


@extend_schema(request=None, responses={200: LegalDocumentAdminSerializer})
@api_view(["POST"])
@permission_classes([IsAdminUser])
def archive_document(request, pk):
    """Unpublish: customers stop seeing the document. History and acceptances stay."""
    # ROLE: content
    try:
        doc = LegalDocument.objects.get(pk=pk)
    except LegalDocument.DoesNotExist:
        return Response({"error": "Document not found"}, status=404)
    if doc.document_type in NEVER_ARCHIVE:
        return Response(
            {"error": "The Terms and the Privacy Policy must stay readable. Publish a new version instead."},
            status=409,
        )
    if doc.status != "published":
        return Response({"error": "Only a published document can be archived."}, status=409)
    doc.status = "archived"
    doc.last_edited_by = request.user
    doc.save(update_fields=["status", "last_edited_by", "updated_at"])
    _audit(request, "archive", doc, f"Archived (unpublished) {doc.title}", {"status": {"old": "published", "new": "archived"}})
    return Response(LegalDocumentAdminSerializer(doc).data)


@extend_schema(request=None, responses={200: LegalDocumentAdminSerializer})
@api_view(["POST"])
@permission_classes([IsAdminUser])
def unarchive_document(request, pk):
    """Put an archived document back online at the same version (no new version)."""
    # ROLE: content
    try:
        doc = LegalDocument.objects.get(pk=pk)
    except LegalDocument.DoesNotExist:
        return Response({"error": "Document not found"}, status=404)
    if doc.status != "archived" or not doc.content_html.strip():
        return Response({"error": "Only an archived document with content can be put back online."}, status=409)
    doc.status = "published"
    doc.last_edited_by = request.user
    doc.save(update_fields=["status", "last_edited_by", "updated_at"])
    _audit(request, "publish", doc, f"Put {doc.title} v{doc.version_label} back online",
           {"status": {"old": "archived", "new": "published"}})
    return Response(LegalDocumentAdminSerializer(doc).data)


@extend_schema(responses={200: OpenApiTypes.OBJECT})
@api_view(["GET"])
@permission_classes([IsAdminUser])
def document_acks(request, pk):
    """How many accounts have read each version (UserDocumentAck)."""
    # ROLE: content
    from django.contrib.auth import get_user_model
    from django.db.models import Count

    try:
        doc = LegalDocument.objects.get(pk=pk)
    except LegalDocument.DoesNotExist:
        return Response({"error": "Document not found"}, status=404)
    rows = list(
        UserDocumentAck.objects.filter(document=doc).values("version_seen").annotate(n=Count("id")).order_by("-version_seen")
    )
    labels = dict(doc.history.values_list("version", "version_label"))
    users = get_user_model().objects.filter(is_active=True, is_staff=False)
    if hasattr(get_user_model(), "deleted_at"):
        users = users.filter(deleted_at__isnull=True)
    total_users = users.count()
    current = sum(r["n"] for r in rows if r["version_seen"] >= doc.version)
    return Response({
        "document": doc.title,
        "current_version": doc.version,
        "current_version_label": doc.version_label,
        "active_customers": total_users,
        "acknowledged_current": current,
        "acknowledged_current_pct": round(100 * current / total_users, 1) if total_users else None,
        "by_version": [
            {"version": r["version_seen"], "version_label": labels.get(r["version_seen"], f"1.{r['version_seen']}"),
             "count": r["n"]}
            for r in rows
        ],
    })
