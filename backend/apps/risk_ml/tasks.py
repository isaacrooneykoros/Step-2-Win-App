from celery import shared_task


@shared_task
def compute_features_and_scores_task(days: int = 3):
    """Nightly (01:30 UTC): shadow risk features + scores for the last ``days`` days."""
    from .pipeline import compute_features_and_scores

    return compute_features_and_scores(days=days)
