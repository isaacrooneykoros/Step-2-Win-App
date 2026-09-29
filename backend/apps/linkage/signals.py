"""Account anonymisation -> drop this account's linkage edges, membership and marks."""

from django.conf import settings
from django.db.models.signals import post_save
from django.dispatch import receiver


@receiver(post_save, sender=settings.AUTH_USER_MODEL, dispatch_uid="linkage_account_deleted")
def purge_linkage_on_account_deletion(sender, instance, **kwargs):
    if getattr(instance, "deleted_at", None) is None:
        return
    from .store import delete_user_linkage

    delete_user_linkage(instance.pk)
