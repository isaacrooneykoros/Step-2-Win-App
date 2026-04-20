from __future__ import annotations

import json

from django.conf import settings
from django.core.management.base import BaseCommand

from apps.steps.drift_monitor import (
    AntiCheatDriftThresholds,
    run_anticheat_shadow_drift_monitor,
)


class Command(BaseCommand):
    help = 'Run anti-cheat shadow drift checks and optionally emit breach alerts.'

    def add_arguments(self, parser):
        parser.add_argument('--no-alerts', action='store_true', help='Do not send external webhook alerts')
        parser.add_argument('--lookback-hours', type=int, default=int(getattr(settings, 'ANTICHEAT_DRIFT_LOOKBACK_HOURS', 24)))
        parser.add_argument('--min-samples', type=int, default=int(getattr(settings, 'ANTICHEAT_DRIFT_MIN_SAMPLES', 50)))
        parser.add_argument('--per-sample-alert-pct', type=float, default=float(getattr(settings, 'ANTICHEAT_DRIFT_PER_SAMPLE_ALERT_PCT', 35.0)))
        parser.add_argument('--max-avg-abs-delta-pct', type=float, default=float(getattr(settings, 'ANTICHEAT_DRIFT_MAX_AVG_ABS_DELTA_PCT', 20.0)))
        parser.add_argument('--max-high-drift-ratio-pct', type=float, default=float(getattr(settings, 'ANTICHEAT_DRIFT_MAX_HIGH_DRIFT_RATIO_PCT', 25.0)))
        parser.add_argument('--max-review-mismatch-ratio-pct', type=float, default=float(getattr(settings, 'ANTICHEAT_DRIFT_MAX_REVIEW_MISMATCH_RATIO_PCT', 10.0)))

    def handle(self, *args, **options):
        thresholds = AntiCheatDriftThresholds(
            lookback_hours=options['lookback_hours'],
            min_samples=options['min_samples'],
            per_sample_alert_pct=options['per_sample_alert_pct'],
            max_avg_abs_delta_pct=options['max_avg_abs_delta_pct'],
            max_high_drift_ratio_pct=options['max_high_drift_ratio_pct'],
            max_review_mismatch_ratio_pct=options['max_review_mismatch_ratio_pct'],
        )

        result = run_anticheat_shadow_drift_monitor(
            thresholds=thresholds,
            send_alerts=not options['no_alerts'],
        )
        self.stdout.write(json.dumps(result, indent=2, sort_keys=True))

        if not result['ok']:
            raise SystemExit(2)
