"""Account anonymisation -> drop this user's derived risk features and scores."""

from django.conf import settings
from django.db.models.signals import post_save
from django.dispatch import receiver


@receiver(post_save, sender=settings.AUTH_USER_MODEL, dispatch_uid="risk_ml_account_deleted")
def purge_risk_data_on_account_deletion(sender, instance, **kwargs):
    # apps.users.account_deletion.delete_account sets deleted_at and saves inside its
    # transaction, so this runs (and rolls back) with it.
    if getattr(instance, "deleted_at", None) is None:
        return
    from .feature_store import delete_user_risk_data

    delete_user_risk_data(instance.pk)
