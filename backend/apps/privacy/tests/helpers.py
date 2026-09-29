from django.contrib.auth import get_user_model

User = get_user_model()
PASSWORD = "Walk-More-2026!"


def make_user(username="akinyi", phone="254711000101", **extra):
    return User.objects.create_user(
        username=username,
        email=f"{username}@example.com",
        phone_number=phone,
        password=PASSWORD,
        **extra,
    )


def publish(document_type: str, version: int, notify: bool = False):
    """A published legal document at ``version`` (goes through save(), so signals run)."""
    from apps.legal.models import LegalDocument

    slug = "privacy-policy" if document_type == "privacy_policy" else "terms-and-conditions"
    doc, _ = LegalDocument.objects.get_or_create(
        document_type=document_type, defaults={"title": slug.replace("-", " ").title(), "slug": slug}
    )
    doc.content_html = "<p>text</p>"
    doc.status = "published"
    doc.version = version
    doc.version_label = f"1.{version}"
    doc.notify_users = notify
    doc.save()
    return doc
