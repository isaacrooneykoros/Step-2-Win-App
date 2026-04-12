"""
payments.views package — re-exports all view functions so that
``from apps.payments import views; views.initiate_deposit`` keeps working
and ``urls.py`` needs no changes.
"""
from .deposit import initiate_deposit, wallet_status, deposit_status
from .webhooks import deposit_callback, payout_callback, withdrawal_callback
from .withdrawal import get_banks, request_withdrawal, withdrawal_history, cancel_withdrawal

__all__ = [
    'initiate_deposit',
    'wallet_status',
    'deposit_status',
    'deposit_callback',
    'payout_callback',
    'withdrawal_callback',
    'get_banks',
    'request_withdrawal',
    'withdrawal_history',
    'cancel_withdrawal',
]
