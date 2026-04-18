from decimal import Decimal

from django.core.management.base import BaseCommand
from django.db import transaction
from django.db.models import Count, Q

from apps.users.models import User


class Command(BaseCommand):
    help = (
        "Safely reset suspicious wallet balances to 0.00 for users with no completed "
        "deposit and no payout/refund credit history. Dry-run by default."
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "--apply",
            action="store_true",
            help="Apply changes. Without this flag, command runs in dry-run mode.",
        )
        parser.add_argument(
            "--limit",
            type=int,
            default=0,
            help="Max number of users to process (0 = no limit).",
        )

    def handle(self, *args, **options):
        apply_changes = options["apply"]
        limit = max(0, int(options["limit"]))

        queryset = User.objects.annotate(
            completed_deposits=Count(
                "payment_transactions",
                filter=Q(
                    payment_transactions__type="deposit",
                    payment_transactions__status="completed",
                ),
                distinct=True,
            ),
            completed_payout_payments=Count(
                "payment_transactions",
                filter=Q(
                    payment_transactions__type="payout",
                    payment_transactions__status="completed",
                ),
                distinct=True,
            ),
            completed_refund_payments=Count(
                "payment_transactions",
                filter=Q(
                    payment_transactions__type="refund",
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

        candidates = []
        skipped = []

        for user in queryset.order_by("id"):
            has_non_topup_credit_history = (
                user.completed_payout_payments > 0
                or user.completed_refund_payments > 0
                or user.payout_credits > 0
                or user.refund_credits > 0
            )

            if has_non_topup_credit_history:
                skipped.append((user, "has payout/refund credit history"))
                continue

            if user.locked_balance > Decimal("0.00"):
                skipped.append((user, "has locked balance > 0"))
                continue

            candidates.append(user)
            if limit and len(candidates) >= limit:
                break

        mode = "APPLY" if apply_changes else "DRY-RUN"
        self.stdout.write(
            self.style.WARNING(
                f"Mode: {mode}. Candidates: {len(candidates)} | Skipped: {len(skipped)}"
            )
        )

        if not candidates:
            self.stdout.write(self.style.SUCCESS("No eligible users found for remediation."))
            return

        total_reset = Decimal("0.00")
        changed = 0

        for user in candidates:
            total_reset += user.wallet_balance
            self.stdout.write(
                f"- id={user.id} username={user.username} current_balance={user.wallet_balance}"
            )

            if not apply_changes:
                continue

            with transaction.atomic():
                locked_user = User.objects.select_for_update().get(id=user.id)
                if locked_user.locked_balance > Decimal("0.00"):
                    self.stdout.write(
                        self.style.WARNING(
                            f"  skipped during apply (now has locked balance={locked_user.locked_balance})"
                        )
                    )
                    continue

                if locked_user.wallet_balance <= Decimal("0.00"):
                    self.stdout.write(
                        self.style.WARNING("  skipped during apply (balance already <= 0)")
                    )
                    continue

                locked_user.wallet_balance = Decimal("0.00")
                locked_user.save(update_fields=["wallet_balance", "updated_at"])
                changed += 1
                self.stdout.write(self.style.SUCCESS("  reset to 0.00"))

        if skipped:
            self.stdout.write("\nSkipped users:")
            for user, reason in skipped[:50]:
                self.stdout.write(
                    f"- id={user.id} username={user.username} balance={user.wallet_balance} reason={reason}"
                )
            if len(skipped) > 50:
                self.stdout.write(f"... and {len(skipped) - 50} more skipped users")

        if apply_changes:
            self.stdout.write(
                self.style.SUCCESS(
                    f"Applied remediation to {changed} users. Total balance targeted: {total_reset}"
                )
            )
        else:
            self.stdout.write(
                self.style.SUCCESS(
                    f"Dry-run complete. Would target {len(candidates)} users. "
                    f"Total balance: {total_reset}"
                )
            )
