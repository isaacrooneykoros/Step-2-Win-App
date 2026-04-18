from django.contrib import admin
from .models import PaymentTransaction, CallbackLog, WithdrawalRequest, PlatformRevenue


@admin.register(PlatformRevenue)
class PlatformRevenueAdmin(admin.ModelAdmin):
    list_display = ['challenge', 'amount_kes', 'collected_at']
    list_filter = ['collected_at']
    search_fields = ['challenge__name']
    readonly_fields = ['challenge', 'amount_kes', 'collected_at']
    ordering = ['-collected_at']

    def has_delete_permission(self, request, obj=None):
        return False  # Never delete financial records

    def has_add_permission(self, request):
        return False  # Auto-created by finalize_challenge


@admin.register(PaymentTransaction)
class PaymentTransactionAdmin(admin.ModelAdmin):
    list_display  = ['user', 'type', 'status', 'amount_kes', 'mpesa_reference',
                     'phone_number', 'created_at']
    list_filter   = ['type', 'status']
    search_fields = ['user__username', 'order_id', 'tracking_reference', 'mpesa_reference']
    readonly_fields = ['id', 'order_id', 'tracking_reference', 'collection_id',
                       'request_id', 'mpesa_reference', 'created_at']
    ordering      = ['-created_at']


@admin.register(CallbackLog)
class CallbackLogAdmin(admin.ModelAdmin):
    list_display  = ['type', 'order_id', 'processed', 'created_at']
    list_filter   = ['type', 'processed']
    ordering      = ['-created_at']


@admin.register(WithdrawalRequest)
class WithdrawalRequestAdmin(admin.ModelAdmin):
    list_display = ['user', 'method', 'amount_kes', 'status',
                    'destination_display', 'reviewed_by', 'created_at']
    list_filter = ['status', 'method']
    search_fields = ['user__username', 'tracking_reference', 'mpesa_reference',
                     'phone_number', 'account_number']
    readonly_fields = ['id', 'tracking_reference', 'request_id',
                       'mpesa_reference', 'created_at']
    ordering = ['-created_at']

    def has_delete_permission(self, request, obj=None):
        return False
