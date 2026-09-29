"""
1. Account deletion: when a user's ``deleted_at`` is first set (apps.users.account_deletion
   saves the anonymised row inside its transaction), remove the privacy leftovers
   (erasure.scrub_deleted_user). The pre_save hook remembers the old username / email /
   phone so they can be replaced in staff audit text.
2. Re-consent: when the Terms or the Privacy Policy is published with "notify users" on,
   raise PrivacySettings.min_*_version so users are asked to accept the new version.
"""

from django.conf import settings
from django.db.models.signals import post_save, pre_save
from django.dispatch import receiver


@receiver(pre_save, sender=settings.AUTH_USER_MODEL, dispatch_uid="privacy_capture_identity")
def capture_identity_before_deletion(sender, instance, **kwargs):
    if getattr(instance, "deleted_at", None) is None or not instance.pk:
        return
    row = sender.objects.filter(pk=instance.pk).values("deleted_at", "username", "email", "phone_number").first()
    if row and row["deleted_at"] is None:
        instance._privacy_deleting_identity = (row["username"], row["email"], row["phone_number"])


@receiver(post_save, sender=settings.AUTH_USER_MODEL, dispatch_uid="privacy_account_deleted")
def scrub_on_account_deletion(sender, instance, **kwargs):
    identity = getattr(instance, "_privacy_deleting_identity", None)
    if identity is None or getattr(instance, "deleted_at", None) is None:
        return
    del instance._privacy_deleting_identity
    from .erasure import scrub_deleted_user

    scrub_deleted_user(instance, identity)


@receiver(post_save, sender="legal.LegalDocument", dispatch_uid="privacy_reconsent_on_publish")
def raise_minimum_version_on_material_change(sender, instance, **kwargs):
    if instance.status != "published" or not instance.notify_users:
        return
    field = {"terms_and_conditions": "min_terms_version", "privacy_policy": "min_privacy_version"}.get(
        instance.document_type
    )
    if not field:
        return
    from .models import PrivacySettings

    s = PrivacySettings.load()
    if int(instance.version) > getattr(s, field):
        setattr(s, field, int(instance.version))
        s.save(update_fields=[field, "updated_at"])
