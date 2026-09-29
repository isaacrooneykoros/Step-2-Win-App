"""Shadow report for device integrity (Phase 1b), to decide when to enforce.

    python manage.py integrity_report --days 7

Counts step sessions and walks by Play Integrity status and failure reason, plus the
shadow emulator / root heuristics, and how many credited steps the enforce policy would
have moved to "goals only". Read-only.
"""

from collections import Counter
from datetime import timedelta

from django.core.management.base import BaseCommand
from django.db.models import Sum
from django.utils import timezone

from apps.steps import integrity
from apps.steps.models import HealthRecord, StepSession, WalkSession


class Command(BaseCommand):
    help = "Summarise Play Integrity verdicts and shadow device heuristics."

    def add_arguments(self, parser):
        parser.add_argument("--days", type=int, default=7)

    def handle(self, *args, **options):
        since = timezone.now() - timedelta(days=max(1, options["days"]))
        self.stdout.write(
            f"Policy: {integrity.current_policy()}  verifier configured: "
            f"{integrity.verifier_configured()}"
        )
        for label, qs in (
            ("Step sessions", StepSession.objects.filter(started_at__gte=since)),
            ("Walks", WalkSession.objects.filter(started_at__gte=since)),
        ):
            statuses = Counter(qs.values_list("integrity_status", flat=True))
            reasons: Counter = Counter()
            heuristics: Counter = Counter()
            for verdict in qs.exclude(integrity_verdict={}).values_list("integrity_verdict", flat=True):
                for reason in (verdict or {}).get("reasons") or []:
                    reasons[reason] += 1
                for flag in (verdict or {}).get("heuristic_flags") or []:
                    heuristics[flag] += 1
            self.stdout.write(f"\n{label}: {sum(statuses.values())}")
            for key, count in statuses.most_common():
                self.stdout.write(f"  {key:<12} {count}")
            if reasons:
                self.stdout.write("  failure reasons: " + ", ".join(f"{k}={v}" for k, v in reasons.most_common()))
            if heuristics:
                self.stdout.write("  shadow heuristics: " + ", ".join(f"{k}={v}" for k, v in heuristics.most_common()))

        users_failed = set(
            StepSession.objects.filter(started_at__gte=since, integrity_status="failed").values_list(
                "user_id", flat=True
            )
        )
        at_stake = (
            HealthRecord.objects.filter(user_id__in=users_failed, synced_at__gte=since).aggregate(
                s=Sum("eligible_steps")
            )["s"]
            or 0
        )
        self.stdout.write(
            f"\nUsers with a failed session: {len(users_failed)}; their money-eligible "
            f"steps in the window: {at_stake:,} (what 'enforce' would move to goals only)"
        )
