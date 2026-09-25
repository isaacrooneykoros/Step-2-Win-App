import json
from datetime import date

from django.core.management.base import BaseCommand


class Command(BaseCommand):
    help = "Harvest risk-model labels from admin flag actions and payout-hold reviews (idempotent)."

    def add_arguments(self, parser):
        parser.add_argument("--since", help="only flags on or after YYYY-MM-DD")

    def handle(self, *args, **opts):
        from apps.risk_ml.labels import harvest_all

        since = date.fromisoformat(opts["since"]) if opts["since"] else None
        self.stdout.write(json.dumps(harvest_all(since=since), indent=2))
