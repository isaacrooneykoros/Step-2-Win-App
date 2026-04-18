from decimal import Decimal

from django.core.management.base import BaseCommand
from django.db.models import Count, Q

from apps.users.models import User


class Command(BaseCommand):
    help = (
        "Audit users with positive wallet balances that have no completed deposit "
        "payment transaction. Use this in production to detect suspicious credits."
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "--strict-topup-only",
            action="store_true",
            help=(
                "Flag any user with positive wallet balance and no completed deposit, "
                "even if they have payout/refund credits."
            ),
        )

    def handle(self, *args, **options):
        strict_topup_only = options["strict_topup_only"]

        users = User.objects.annotate(
            completed_deposits=Count(
                "payment_transactions",
                filter=Q(
                    payment_transactions__type="deposit",
                    payment_transactions__status="completed",
                ),
                distinct=True,
            ),
            payout_credits=Count(
                "transactions",
                filter=Q(transactions__type="payout"),
                distinct=True,
            ),
            refund_credits=Count(
                "transactions",
                filter=Q(transactions__type="refund"),
                distinct=True,
            ),
        ).filter(wallet_balance__gt=Decimal("0.00"), completed_deposits=0)

        suspicious = []
        for user in users:
            has_other_credits = (user.payout_credits + user.refund_credits) > 0
            if strict_topup_only or not has_other_credits:
                suspicious.append(user)

        if not suspicious:
            self.stdout.write(
                self.style.SUCCESS(
                    "OK: No users found with positive wallet balance without approved top-up context."
                )
            )
            return

        self.stdout.write(
            self.style.WARNING(
                f"Found {len(suspicious)} suspicious users with positive balance and no completed deposit."
            )
        )

        for user in suspicious:
            self.stdout.write(
                (
                    f"- id={user.id} username={user.username} balance={user.wallet_balance} "
                    f"payout_credits={user.payout_credits} refund_credits={user.refund_credits} "
                    f"created_at={user.created_at.isoformat()}"
                )
            )

        self.stdout.write(
            "\nNext step: inspect these users' WalletTransaction and PaymentTransaction history before remediation."
        )
