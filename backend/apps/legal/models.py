from django.db import models
from django.conf import settings
from django.utils.text import slugify


class LegalDocument(models.Model):
    """
    Stores the current and historical versions of legal documents
    (Privacy Policy, Terms and Conditions, etc.)

    Key design decisions:
    - content_html stores the rendered HTML — what the app displays
    - uploaded_file stores the original DOCX/PDF — for download
    - version is auto-incremented on every publish
    - is_published controls visibility to the mobile app
    - notify_users flags the app to show "Updated" badge to users
      who haven't re-read the document since this version
    """

    DOCUMENT_TYPES = [
        ('privacy_policy',       'Privacy Policy'),
        ('terms_and_conditions', 'Terms and Conditions'),
        ('cookie_policy',        'Cookie Policy'),
        ('refund_policy',        'Refund Policy'),
        ('other',                'Other'),
    ]

    STATUS_CHOICES = [
        ('draft',     'Draft'),
        ('published', 'Published'),
        ('archived',  'Archived'),
    ]

    # ── Identity ──────────────────────────────────────────────────────────
    document_type = models.CharField(
        max_length=30, choices=DOCUMENT_TYPES, unique=True,
        help_text='Each document type has exactly one published version at a time.'
    )
    title = models.CharField(
        max_length=200,
        help_text='Display title shown to users. e.g. "Privacy Policy"'
    )
    slug = models.SlugField(
        max_length=100, unique=True,
        help_text='URL slug. Auto-generated from title. e.g. "privacy-policy"'
    )

    # ── Content ───────────────────────────────────────────────────────────
    content_html = models.TextField(
        blank=True,
        help_text='Full document content as HTML. Rendered in the mobile app.'
    )
    uploaded_file = models.FileField(
        upload_to='legal/files/',
        null=True, blank=True,
        help_text='Original DOCX or PDF file. Stored for download and as source of truth.'
    )
    file_type = models.CharField(
        max_length=10, blank=True,
        help_text='docx / pdf / html — auto-detected from upload'
    )

    # ── Versioning ────────────────────────────────────────────────────────
    version = models.PositiveIntegerField(
        default=1,
        help_text='Auto-incremented each time the document is published.'
    )
    version_label = models.CharField(
        max_length=20, blank=True,
        help_text='Human-readable version e.g. "1.2". Auto-generated as "1.{version}"'
    )
    status = models.CharField(
        max_length=10, choices=STATUS_CHOICES, default='draft'
    )

    # ── Change notification ───────────────────────────────────────────────
    notify_users = models.BooleanField(
        default=False,
        help_text='If True, mobile app shows "Updated" badge to users who '
                  'have not re-read this version.'
    )
    change_summary = models.CharField(
        max_length=500, blank=True,
        help_text='Optional: brief description of what changed in this version. '
                  'Shown to users in the update notification.'
    )

    # ── Audit ─────────────────────────────────────────────────────────────
    last_edited_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True, blank=True,
        related_name='edited_legal_docs'
    )
    published_at = models.DateTimeField(null=True, blank=True)
    created_at   = models.DateTimeField(auto_now_add=True)
    updated_at   = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['document_type']

    def __str__(self):
        return f'{self.title} v{self.version_label} ({self.status})'

    def save(self, *args, **kwargs):
        if not self.slug:
            self.slug = slugify(self.title)
        if not self.version_label:
            self.version_label = f'1.{self.version}'
        super().save(*args, **kwargs)

    def publish(self, user=None):
        """
        Publish this document. Auto-increments version if already published before.
        Records who published it and when.
        """
        from django.utils import timezone
        if self.status == 'published':
            # Re-publishing — increment version
            self.version      += 1
            self.version_label = f'1.{self.version}'
        self.status       = 'published'
        self.published_at = timezone.now()
        if user:
            self.last_edited_by = user
        self.save()


class LegalDocumentVersion(models.Model):
    """
    Immutable historical record of every published version.
    Created automatically when a document is published.
    Enables full audit trail and version history in admin.
    """
    document     = models.ForeignKey(
                     LegalDocument, on_delete=models.CASCADE,
                     related_name='history'
                   )
    version      = models.PositiveIntegerField()
    version_label = models.CharField(max_length=20)
    content_html = models.TextField()
    published_by = models.ForeignKey(
                     settings.AUTH_USER_MODEL,
                     on_delete=models.SET_NULL,
                     null=True, blank=True
                   )
    published_at = models.DateTimeField(auto_now_add=True)
    change_summary = models.CharField(max_length=500, blank=True)

    class Meta:
        ordering = ['-published_at']
        unique_together = ['document', 'version']

    def __str__(self):
        return f'{self.document.title} v{self.version_label}'


class UserDocumentAck(models.Model):
    """
    Tracks which version of each document a user has acknowledged.
    Used to show "Updated — please re-read" badge in the mobile app.
    """
    user          = models.ForeignKey(
                      settings.AUTH_USER_MODEL,
                      on_delete=models.CASCADE,
                      related_name='document_acks'
                    )
    document      = models.ForeignKey(
                      LegalDocument, on_delete=models.CASCADE,
                      related_name='user_acks'
                    )
    version_seen  = models.PositiveIntegerField()
    acknowledged_at = models.DateTimeField(auto_now=True)

    class Meta:
        unique_together = ['user', 'document']

    def __str__(self):
        return f'{self.user.username} acked {self.document.title} v{self.version_seen}'
