"""
Shared internal helpers for the payments views package.
"""
import logging

logger = logging.getLogger(__name__)


def create_wallet_transaction(user, type, amount, reference, description):
    """
    Creates a record in the existing WalletTransaction model.
    """
    from apps.wallet.models import WalletTransaction
    from apps.users.models import User

    user_obj = User.objects.get(id=user.id)
    balance_before = user_obj.wallet_balance - amount

    WalletTransaction.objects.create(
        user           = user,
        type           = type,
        amount         = amount,
        balance_before = balance_before,
        balance_after  = user_obj.wallet_balance,
        description    = description,
        reference_id   = reference,
    )


def notify_user(user, event: str, **kwargs):
    """
    Sends in-app notification / push notification.
    Connect to your existing notification system.
    """
    # TODO: integrate with your existing notification system
    logger.info(f'Notification | user={user.id} | event={event} | data={kwargs}')


def notify_admin_new_withdrawal(withdrawal):
    """Notify admins a new withdrawal is pending review."""
    logger.info(
        f'ADMIN ALERT: New withdrawal pending | '
        f'user={withdrawal.user.username} | '
        f'KES {withdrawal.amount_kes} | {withdrawal.destination_display}'
    )
