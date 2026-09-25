"""
Labels: harvest human decisions into ``Label`` rows (idempotent), and resolve them into
one training label per user-day.

Sources
- FraudFlag admin actions (``details.admin_action``): ban/suspend/restrict -> cheat,
  dismiss -> honest, warn/unrestrict/... -> unsure. NOISY: an action is about the
  account and one rule hit, not a verified finding about every step that day.
- HeldPayout reviews (added by the payout-hold work, Phase 1a): looked up through the
  app registry so this module works before that model exists. Released -> honest,
  forfeited/withheld -> cheat for the challenge window.
- Admin manual labels (the staff endpoint).
- Synthetic labels: only from the evaluation tooling; excluded from training by default.
"""

from __future__ import annotations

import logging
from datetime import date, timedelta

from django.apps import apps as django_apps
from django.db import transaction

from .models import Label

logger = logging.getLogger(__name__)

FLAG_ACTION_LABELS = {
    "ban": Label.LABEL_CHEAT,
    "suspend": Label.LABEL_CHEAT,
    "restrict": Label.LABEL_CHEAT,
    "dismiss": Label.LABEL_HONEST,
    "warn": Label.LABEL_UNSURE,
}
# HeldPayout decision values we understand (field name probed in HELD_DECISION_FIELDS).
HELD_HONEST = {"released", "release", "approved", "paid", "cleared"}
HELD_CHEAT = {"forfeited", "forfeit", "withheld", "rejected", "confiscated", "denied", "voided"}
HELD_DECISION_FIELDS = ("decision", "status", "state", "resolution")
MAX_WINDOW_DAYS = 62


def upsert_label(*, user_id, date_start: date, date_end: date, label: str, source: str, source_ref: str,
                 notes: str = "", created_by=None) -> tuple[Label, bool]:
    """One label per (user, source, source_ref, window): a later decision replaces an earlier one."""
    if label not in dict(Label.LABEL_CHOICES):
        raise ValueError(f"bad label {label!r}")
    if source not in dict(Label.SOURCE_CHOICES):
        raise ValueError(f"bad source {source!r}")
    obj, created = Label.objects.update_or_create(
        user_id=user_id, source=source, source_ref=source_ref, date_start=date_start, date_end=date_end,
        defaults={"label": label, "notes": notes[:2000], "created_by": created_by},
    )
    return obj, created


def harvest_flag_labels(since: date | None = None) -> dict:
    from apps.steps.models import FraudFlag

    qs = FraudFlag.objects.filter(reviewed=True, user__deleted_at__isnull=True)
    if since:
        qs = qs.filter(date__gte=since)
    counts = {"created": 0, "updated": 0, "skipped": 0}
    for flag in qs.only("id", "user_id", "date", "flag_type", "details").iterator(chunk_size=500):
        details = flag.details if isinstance(flag.details, dict) else {}
        action = details.get("admin_action")
        label = FLAG_ACTION_LABELS.get(action)
        if label is None:
            counts["skipped"] += 1
            continue
        _, created = upsert_label(user_id=flag.user_id, date_start=flag.date, date_end=flag.date, label=label,
                                  source=Label.SOURCE_FLAG_ACTION, source_ref=f"flag:{flag.pk}",
                                  notes=f"{flag.flag_type}: admin {action}")
        counts["created" if created else "updated"] += 1
    return counts


def find_held_payout_model():
    """The Phase 1a HeldPayout model if it is installed (any app), else None."""
    for model in django_apps.get_models():
        if model.__name__ == "HeldPayout":
            return model
    return None


def _held_decision(obj) -> str | None:
    for name in HELD_DECISION_FIELDS:
        val = getattr(obj, name, None)
        if isinstance(val, str) and val:
            v = val.lower()
            if v in HELD_HONEST:
                return Label.LABEL_HONEST
            if v in HELD_CHEAT:
                return Label.LABEL_CHEAT
    return None


def _held_window(obj) -> tuple[date, date] | None:
    challenge = getattr(obj, "challenge", None)
    start = getattr(obj, "window_start", None) or getattr(challenge, "start_date", None)
    end = getattr(obj, "window_end", None) or getattr(challenge, "end_date", None)
    if start is None or end is None:
        when = getattr(obj, "decided_at", None) or getattr(obj, "reviewed_at", None) or getattr(obj, "created_at", None)
        if when is None:
            return None
        end = when.date()
        start = end - timedelta(days=6)
    if (end - start).days > MAX_WINDOW_DAYS:
        start = end - timedelta(days=MAX_WINDOW_DAYS)
    return start, end


def harvest_held_payout_labels() -> dict:
    """Ingest decided payout holds. Works (as a no-op) before the HeldPayout model exists."""
    model = find_held_payout_model()
    if model is None:
        return {"available": False, "created": 0, "updated": 0, "skipped": 0}
    counts = {"available": True, "created": 0, "updated": 0, "skipped": 0}
    for obj in model.objects.all().iterator(chunk_size=200):
        user_id = getattr(obj, "user_id", None)
        label = _held_decision(obj)
        window = _held_window(obj)
        if not user_id or label is None or window is None:
            counts["skipped"] += 1
            continue
        note = getattr(obj, "review_note", None) or getattr(obj, "reason", None) or ""
        _, created = upsert_label(user_id=user_id, date_start=window[0], date_end=window[1], label=label,
                                  source=Label.SOURCE_PAYOUT_REVIEW, source_ref=f"heldpayout:{obj.pk}",
                                  notes=str(note)[:500])
        counts["created" if created else "updated"] += 1
    return counts


def harvest_all(since: date | None = None) -> dict:
    with transaction.atomic():
        return {"flags": harvest_flag_labels(since), "held_payouts": harvest_held_payout_labels()}


# Source precedence when labels disagree on a day: direct human judgements first.
SOURCE_PRIORITY = {
    Label.SOURCE_ADMIN_MANUAL: 3,
    Label.SOURCE_PAYOUT_REVIEW: 2,
    Label.SOURCE_FLAG_ACTION: 1,
    Label.SOURCE_SYNTHETIC: 0,
}


def resolve_day_labels(*, include_synthetic: bool = False) -> dict:
    """
    {(user_id, date): "cheat" | "honest"} - one label per user-day.

    Highest-priority source wins; within a source, conflicting cheat/honest -> unsure
    (dropped). Windows expand to each day they cover. "unsure" is never returned.
    """
    sources = list(Label.REAL_SOURCES) + ([Label.SOURCE_SYNTHETIC] if include_synthetic else [])
    per_day: dict = {}
    for uid, start, end, label, source in (Label.objects.filter(source__in=sources)
                                           .values_list("user_id", "date_start", "date_end", "label", "source")
                                           .iterator(chunk_size=2000)):
        days = min((end - start).days, MAX_WINDOW_DAYS)
        for i in range(days + 1):
            key = (uid, start + timedelta(days=i))
            per_day.setdefault(key, {}).setdefault(SOURCE_PRIORITY[source], set()).add(label)
    out = {}
    for key, by_prio in per_day.items():
        top = by_prio[max(by_prio)]
        decided = top - {Label.LABEL_UNSURE}
        if len(decided) == 1:
            out[key] = decided.pop()
    return out
