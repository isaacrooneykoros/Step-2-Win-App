from celery import shared_task


@shared_task
def recompute_linkage_task():
    """Nightly (23:15 UTC = 02:15 EAT, before the 00:05 UTC settlement): identity graph
    edges + clusters. Idempotent; see apps/linkage/store.py."""
    from .store import recompute_linkage

    return recompute_linkage()
