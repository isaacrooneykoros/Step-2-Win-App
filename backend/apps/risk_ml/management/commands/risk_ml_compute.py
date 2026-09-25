import json
from datetime import date, timedelta

from django.core.management.base import BaseCommand, CommandError


class Command(BaseCommand):
    help = "Recompute shadow risk features and scores (default: last 3 local days)."

    def add_arguments(self, parser):
        parser.add_argument("--days", type=int, default=3)
        parser.add_argument("--start", help="YYYY-MM-DD (with --end: explicit backfill window)")
        parser.add_argument("--end", help="YYYY-MM-DD")
        parser.add_argument("--no-score", action="store_true", help="features only")

    def handle(self, *args, **opts):
        from apps.risk_ml.feature_store import compute_features, local_today
        from apps.risk_ml.pipeline import compute_features_and_scores
        from apps.risk_ml.scoring import score_days

        if opts["start"] or opts["end"]:
            try:
                start = date.fromisoformat(opts["start"] or opts["end"])
                end = date.fromisoformat(opts["end"] or opts["start"])
            except ValueError as exc:
                raise CommandError(f"bad date: {exc}")
        elif opts["no_score"]:
            end = local_today()
            start = end - timedelta(days=max(1, opts["days"]) - 1)
        else:
            out = compute_features_and_scores(days=opts["days"])
            self.stdout.write(json.dumps(out, indent=2, default=str))
            return
        out = {"features": compute_features(start, end)}
        if not opts["no_score"]:
            out["scores"] = score_days(start, end)
        self.stdout.write(json.dumps(out, indent=2, default=str))
