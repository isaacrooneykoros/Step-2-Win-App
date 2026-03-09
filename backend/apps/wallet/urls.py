from django.urls import path
from . import views

app_name = 'wallet'

urlpatterns = [
    path('summary/', views.wallet_summary, name='summary'),
    path('transactions/', views.TransactionListView.as_view(), name='transactions'),
    path('transactions/stats/', views.transaction_stats, name='transaction_stats'),
    path('deposit/', views.deposit, name='deposit'),
    path('withdraw/', views.withdraw, name='withdraw'),
    path('withdrawals/', views.WithdrawalListView.as_view(), name='withdrawals'),
    path('withdrawals/<str:reference_number>/', views.withdrawal_detail, name='withdrawal_detail'),
]
