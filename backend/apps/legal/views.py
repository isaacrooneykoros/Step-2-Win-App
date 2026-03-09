import logging
from django.utils import timezone
from rest_framework import status
from rest_framework.decorators import api_view, permission_classes, parser_classes
from rest_framework.parsers import MultiPartParser, FormParser, JSONParser
from rest_framework.permissions import IsAuthenticated, IsAdminUser, AllowAny
from rest_framework.response import Response

from .models import LegalDocument, LegalDocumentVersion, UserDocumentAck
from .serializers import (
    LegalDocumentPublicSerializer,
    LegalDocumentAdminSerializer,
    LegalDocumentVersionSerializer,
)
from .utils import process_uploaded_file

logger = logging.getLogger(__name__)


# ── PUBLIC ENDPOINTS (mobile app) ────────────────────────────────────────────

@api_view(['GET'])
@permission_classes([AllowAny])
def list_documents_public(request):
    """
    Returns all published legal documents.
    Called by mobile app to show list of available documents.
    No authentication required — policies must be readable before login.
    """
    docs = LegalDocument.objects.filter(status='published')
    serializer = LegalDocumentPublicSerializer(
        docs, many=True, context={'request': request}
    )
    return Response(serializer.data)


@api_view(['GET'])
@permission_classes([AllowAny])
def get_document_public(request, slug):
    """
    Returns a single published legal document by slug.
    e.g. GET /api/legal/privacy-policy/

    Used when user taps "Privacy Policy" in the app.
    """
    try:
        doc = LegalDocument.objects.get(slug=slug, status='published')
    except LegalDocument.DoesNotExist:
        return Response(
            {'error': f'Document "{slug}" not found or not yet published.'},
            status=404
        )
    serializer = LegalDocumentPublicSerializer(doc, context={'request': request})
    return Response(serializer.data)


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def acknowledge_document(request, slug):
    """
    Records that the authenticated user has read the current version.
    Called when user scrolls to the bottom of a legal document.
    Clears the "Updated" badge for this user.

    POST /api/legal/privacy-policy/acknowledge/
    """
    try:
        doc = LegalDocument.objects.get(slug=slug, status='published')
    except LegalDocument.DoesNotExist:
        return Response({'error': 'Document not found'}, status=404)

    UserDocumentAck.objects.update_or_create(
        user=request.user,
        document=doc,
        defaults={'version_seen': doc.version}
    )
    return Response({'acknowledged': True, 'version': doc.version})


# ── ADMIN ENDPOINTS ───────────────────────────────────────────────────────────

@api_view(['GET'])
@permission_classes([IsAdminUser])
def list_documents_admin(request):
    """
    Returns all documents (all statuses) for the admin panel.
    """
    docs = LegalDocument.objects.all().order_by('document_type')
    serializer = LegalDocumentAdminSerializer(docs, many=True)
    return Response(serializer.data)


@api_view(['GET', 'PUT', 'PATCH'])
@permission_classes([IsAdminUser])
@parser_classes([MultiPartParser, FormParser, JSONParser])
def document_detail_admin(request, pk):
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
        return Response({'error': 'Document not found'}, status=404)

    if request.method == 'GET':
        serializer = LegalDocumentAdminSerializer(doc)
        return Response(serializer.data)

    # PUT / PATCH
    uploaded_file = request.FILES.get('uploaded_file')
    data          = request.data.copy()

    if uploaded_file:
        # Convert file to HTML automatically
        try:
            html, file_type = process_uploaded_file(
                uploaded_file, uploaded_file.name
            )
            data['content_html'] = html
            data['file_type']    = file_type
            # Save the original file
            doc.uploaded_file = uploaded_file
        except ValueError as e:
            return Response({'error': str(e)}, status=400)

    serializer = LegalDocumentAdminSerializer(
        doc, data=data, partial=(request.method == 'PATCH')
    )
    if serializer.is_valid():
        serializer.save(last_edited_by=request.user)
        return Response(serializer.data)
    return Response(serializer.errors, status=400)


@api_view(['POST'])
@permission_classes([IsAdminUser])
def create_document_admin(request):
    """
    Create a new legal document (e.g. a Cookie Policy).
    POST /api/legal/admin/documents/create/
    """
    serializer = LegalDocumentAdminSerializer(data=request.data)
    if serializer.is_valid():
        doc = serializer.save(last_edited_by=request.user)
        return Response(
            LegalDocumentAdminSerializer(doc).data,
            status=201
        )
    return Response(serializer.errors, status=400)


@api_view(['POST'])
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
        return Response({'error': 'Document not found'}, status=404)

    if not doc.content_html.strip():
        return Response(
            {'error': 'Cannot publish an empty document. Add content first.'},
            status=400
        )

    notify       = request.data.get('notify_users', False)
    change_summary = request.data.get('change_summary', '')

    doc.notify_users   = notify
    doc.change_summary = change_summary

    # Save historical version BEFORE incrementing
    old_version = doc.version
    if doc.status == 'published':
        # Save current version to history before overwriting
        LegalDocumentVersion.objects.get_or_create(
            document=doc,
            version=old_version,
            defaults={
                'version_label':  doc.version_label,
                'content_html':   doc.content_html,
                'published_by':   doc.last_edited_by,
                'change_summary': doc.change_summary,
            }
        )

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
        f'Legal document published: {doc.title} v{doc.version_label} '
        f'by {request.user.username}'
    )

    return Response({
        'published':    True,
        'version':      doc.version,
        'version_label': doc.version_label,
        'notify_users': doc.notify_users,
        'published_at': doc.published_at,
    })


@api_view(['GET'])
@permission_classes([IsAdminUser])
def document_history(request, pk):
    """
    Returns all historical versions of a document.
    GET /api/legal/admin/documents/<pk>/history/
    """
    try:
        doc = LegalDocument.objects.get(pk=pk)
    except LegalDocument.DoesNotExist:
        return Response({'error': 'Document not found'}, status=404)

    versions   = doc.history.all()
    serializer = LegalDocumentVersionSerializer(versions, many=True)
    return Response({
        'document': doc.title,
        'current_version': doc.version_label,
        'history': serializer.data,
    })


@api_view(['POST'])
@permission_classes([IsAdminUser])
def restore_version(request, pk, version_id):
    """
    Restore a historical version as the current draft.
    POST /api/legal/admin/documents/<pk>/restore/<version_id>/
    """
    try:
        doc     = LegalDocument.objects.get(pk=pk)
        version = LegalDocumentVersion.objects.get(pk=version_id, document=doc)
    except (LegalDocument.DoesNotExist, LegalDocumentVersion.DoesNotExist):
        return Response({'error': 'Document or version not found'}, status=404)

    doc.content_html    = version.content_html
    doc.status          = 'draft'   # requires re-publishing
    doc.last_edited_by  = request.user
    doc.save()

    return Response({
        'restored': True,
        'from_version': version.version_label,
        'message': f'Content restored from v{version.version_label}. '
                   f'Review and publish to make it live.',
    })
