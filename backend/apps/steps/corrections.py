"""Staff step corrections: set or void one user-day's steps, with recompute.

A correction is a StepCorrection row (append-only). Raw evidence is never touched:
sync events, hourly rows, evidence streams and HealthRecord.last_raw_steps stay as
they were. The correction is applied on top of whatever the day's syncs earned by
evidence.refresh_day (``apply_to_record``), so a later sync cannot undo it and removing
it ("clear") returns the day to its synced value.

After a correction:
- the day's credited and money-eligible steps are recomputed (refresh_day);
- Participant.steps of the user's ACTIVE challenges covering the day are recomputed
  through the same path the sync uses (steps.views.recompute_challenge_progress);
- User.total_steps / best_day_steps are recomputed from the day records;
- social weekly totals for that week (the user and their teams) are refreshed.

Days inside a challenge that is already settled (completed) for this user are refused:
payouts were paid from those numbers.
"""

from __future__ import annotations

from datetime import date as date_cls

from django.db import transaction
from django.db.models import Max, Sum

from .models import HealthRecord, StepCorrection

MAX_DAY_STEPS = 150_000


class StepCorrectionError(Exception):
    def __init__(self, message: str, status_code: int = 400, code: str = "invalid"):
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.code = code


def current_correction(user_id, day) -> StepCorrection | None:
    """The correction in force for a day (the newest row), or None (none / cleared)."""
    latest = StepCorrection.objects.filter(user_id=user_id, date=day).order_by("-created_at", "-id").first()
    if latest is None or latest.kind == StepCorrection.KIND_CLEAR:
        return None
    return latest


def apply_to_record(record) -> None:
    """Called at the end of evidence.refresh_day: put the staff correction on top."""
    if not record.pk:
        return
    c = current_correction(record.user_id, record.date)
    meta = dict(record.anticheat or {})
    if c is None:
        if meta.pop("admin_correction", None) is not None:
            record.anticheat = meta
        return
    value = 0 if c.kind == StepCorrection.KIND_VOID else max(0, int(c.steps or 0))
    record.steps = value
    record.eligible_steps = value
    meta["admin_correction"] = {
        "id": c.id,
        "kind": c.kind,
        "steps": value,
        "at": c.created_at.isoformat() if c.created_at else None,
    }
    record.anticheat = meta


def _pre_correction_values(record, correction):
    """(steps, eligible_steps) the day had before the current run of corrections."""
    chain = []
    for row in StepCorrection.objects.filter(user_id=record.user_id, date=record.date).exclude(
        id=correction.id
    ).order_by("-created_at", "-id"):
        if row.kind == StepCorrection.KIND_CLEAR:
            break
        chain.append(row)
    if not chain:
        return None
    return chain[-1].previous_steps, chain[-1].previous_eligible_steps


def _apply_without_refresh(record, correction) -> None:
    if correction.kind == StepCorrection.KIND_CLEAR:
        # Back to the values the day had before this run of corrections started.
        original = _pre_correction_values(record, correction)
        if original is not None:
            record.steps, record.eligible_steps = original
        meta = dict(record.anticheat or {})
        meta.pop("admin_correction", None)
        record.anticheat = meta
    else:
        apply_to_record(record)
    type(record).objects.filter(pk=record.pk).update(
        steps=record.steps, eligible_steps=record.eligible_steps, anticheat=record.anticheat
    )


def settled_challenges_covering(user, day) -> list:
    from apps.challenges.models import Participant

    return list(
        Participant.objects.filter(
            user=user, challenge__status="completed", challenge__start_date__lte=day, challenge__end_date__gte=day
        ).values_list("challenge__name", flat=True)
    )


def recompute_user_totals(user) -> None:
    agg = HealthRecord.objects.filter(user=user).aggregate(total=Sum("steps"), best=Max("steps"))
    type(user).objects.filter(id=user.id).update(
        total_steps=int(agg["total"] or 0), best_day_steps=int(agg["best"] or 0)
    )


def refresh_social_week(user, day) -> None:
    try:
        from apps.social.common import week_start_for
        from apps.social.models import TeamMembership
        from apps.social.rankings import refresh_team_totals, refresh_user_weeks

        ws = week_start_for(day)
        refresh_user_weeks([user.id], [ws])
        team_ids = list(TeamMembership.objects.filter(user=user).values_list("team_id", flat=True))
        if team_ids:
            refresh_team_totals(ws, team_ids)
    except Exception:  # rankings are derived data; the job refreshes them anyway
        import logging

        logging.getLogger(__name__).exception("Social weekly refresh after a step correction failed")


def correct_day(*, user, day: date_cls, kind: str, steps: int | None, reason: str, admin) -> dict:
    """Record a correction and recompute everything that depends on the day."""
    from .evidence import refresh_day
    from .views import recompute_challenge_progress

    if kind not in (StepCorrection.KIND_SET, StepCorrection.KIND_VOID, StepCorrection.KIND_CLEAR):
        raise StepCorrectionError("kind must be set, void or clear.")
    reason = str(reason or "").strip()
    if len(reason) < 5:
        raise StepCorrectionError("A reason of at least 5 characters is required.")
    if kind == StepCorrection.KIND_SET:
        try:
            steps = int(steps)
        except (TypeError, ValueError):
            raise StepCorrectionError("Enter the day's steps as a whole number.")
        if steps < 0 or steps > MAX_DAY_STEPS:
            raise StepCorrectionError(f"Steps must be between 0 and {MAX_DAY_STEPS:,}.")
    else:
        steps = None
    from django.utils import timezone

    if day > timezone.localdate():
        raise StepCorrectionError("You can't correct a day in the future.")
    settled = settled_challenges_covering(user, day)
    if settled:
        raise StepCorrectionError(
            "This day is part of a challenge that is already settled ("
            + ", ".join(settled[:3])
            + "). Its payouts were made from these steps, so the day can't be changed.",
            409,
            "settled_challenge",
        )

    with transaction.atomic():
        record = HealthRecord.objects.select_for_update().filter(user=user, date=day).first()
        if record is None:
            if kind != StepCorrection.KIND_SET:
                raise StepCorrectionError("There are no steps recorded for this day.", 404, "no_record")
            record = HealthRecord.objects.create(
                user=user, date=day, source="manual", steps=0, anticheat={"created_by_correction": True}
            )
        before_steps = int(record.steps or 0)
        before_eligible = record.eligible_steps
        if kind == StepCorrection.KIND_CLEAR and current_correction(user.id, day) is None:
            raise StepCorrectionError("This day has no correction to remove.", 409, "no_correction")
        correction = StepCorrection.objects.create(
            user=user, date=day, kind=kind, steps=steps, previous_steps=before_steps,
            previous_eligible_steps=before_eligible, reason=reason[:1000], created_by=admin,
        )
        if "p1b" in (record.anticheat or {}):
            if kind == StepCorrection.KIND_CLEAR:
                # refresh_day starts from the stored credit, which the correction replaced:
                # put back what the day had before the corrections, then re-derive.
                original = _pre_correction_values(record, correction)
                if original is not None:
                    record.steps = original[0]
                    type(record).objects.filter(pk=record.pk).update(steps=record.steps)
            refresh_day(record)
        else:
            # A day the evidence engine never processed (before Phase 1b): don't
            # re-derive it, just put the correction on / take it off.
            _apply_without_refresh(record, correction)
        record.refresh_from_db()
        recompute_challenge_progress(user, day, record)
    recompute_user_totals(user)
    refresh_social_week(user, day)
    return {
        "correction_id": correction.id,
        "date": day.isoformat(),
        "kind": kind,
        "steps": {"old": before_steps, "new": int(record.steps or 0)},
        "eligible_steps": {"old": before_eligible, "new": record.eligible_steps},
        "is_suspicious": record.is_suspicious,
    }


def correction_row(c: StepCorrection) -> dict:
    return {
        "id": c.id,
        "date": c.date.isoformat(),
        "kind": c.kind,
        "steps": c.steps,
        "previous_steps": c.previous_steps,
        "previous_eligible_steps": c.previous_eligible_steps,
        "reason": c.reason,
        "created_by": c.created_by.username if c.created_by_id else None,
        "created_at": c.created_at.isoformat(),
    }
