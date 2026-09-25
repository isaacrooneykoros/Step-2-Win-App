"""Nightly shadow pipeline: harvest labels, recompute recent features, score them."""

from __future__ import annotations

import logging
from datetime import date, timedelta

from .feature_store import compute_features, local_today
from .labels import harvest_all
from .scoring import load_active_scorer, score_days

logger = logging.getLogger(__name__)

LABEL_LOOKBACK_DAYS = 60


def compute_features_and_scores(days: int = 3, *, today: date | None = None) -> dict:
    """
    Recompute features for the last ``days`` local days (today included, so late syncs
    for the previous days are picked up) and store shadow risk scores.

    Batched and idempotent: safe to re-run or to run twice concurrently (rows are upserted
    on their unique keys). Never touches steps, standings, trust or payouts.
    """
    days = max(1, int(days))
    end = today or local_today()
    start = end - timedelta(days=days - 1)
    summary = {"start": str(start), "end": str(end)}
    try:
        summary["labels"] = harvest_all(since=end - timedelta(days=LABEL_LOOKBACK_DAYS))
    except Exception:  # label harvesting must not block scoring
        logger.exception("risk_ml: label harvest failed")
        summary["labels"] = {"error": True}
    summary["features"] = compute_features(start, end)
    scorer = load_active_scorer()
    summary["scores"] = score_days(start, end, scorer=scorer)
    logger.info("risk_ml nightly: %s", summary)
    return summary
