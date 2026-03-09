from django.urls import path
from . import views

urlpatterns = [
    # User-facing (authenticated)
    path('deposit/', views.initiate_deposit, name='initiate_deposit'),
    path('deposit/<str:order_id>/status/', views.deposit_status, name='deposit_status'),
    path('wallet/', views.wallet_status, name='wallet_status'),
    path('withdrawal/request/', views.request_withdrawal, name='request_withdrawal'),
    path('withdrawal/history/', views.withdrawal_history, name='withdrawal_history'),
    path('withdrawal/<uuid:withdrawal_id>/cancel/', views.cancel_withdrawal, name='cancel_withdrawal'),
    path('banks/', views.get_banks, name='get_banks'),

    # PochPay callbacks (PUBLIC — no auth, no CSRF)
    path('mpesa/deposit-callback/', views.deposit_callback, name='deposit_callback'),
    path('mpesa/payout-callback/', views.payout_callback, name='payout_callback'),
    path('mpesa/withdrawal-callback/', views.withdrawal_callback, name='withdrawal_callback'),
]
