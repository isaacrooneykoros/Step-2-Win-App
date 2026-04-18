from __future__ import annotations

import json

from django.core.management.base import BaseCommand

from apps.payments.reconciliation import ReconciliationThresholds, run_financial_reconciliation


class Command(BaseCommand):
    help = 'Run financial integrity reconciliation checks and emit breach alerts.'

    def add_arguments(self, parser):
        parser.add_argument('--no-alerts', action='store_true', help='Do not send external webhook alerts')
        parser.add_argument('--max-stuck-processing', type=int, default=10)
        parser.add_argument('--max-unprocessed-callbacks', type=int, default=5)
        parser.add_argument('--max-negative-balance-users', type=int, default=0)
        parser.add_argument('--max-callback-failure-rate-pct', type=float, default=5.0)

    def handle(self, *args, **options):
        thresholds = ReconciliationThresholds(
            max_stuck_processing=options['max_stuck_processing'],
            max_unprocessed_callbacks=options['max_unprocessed_callbacks'],
            max_negative_balance_users=options['max_negative_balance_users'],
            max_callback_failure_rate_pct=options['max_callback_failure_rate_pct'],
        )

        result = run_financial_reconciliation(
            thresholds=thresholds,
            send_alerts=not options['no_alerts'],
        )
        self.stdout.write(json.dumps(result, indent=2, sort_keys=True))

        if not result['ok']:
            raise SystemExit(2)
