from django.contrib import admin
from django.utils import timezone
from .models import WalletTransaction, Withdrawal


@admin.register(WalletTransaction)
class WalletTransactionAdmin(admin.ModelAdmin):
    """
    Admin interface for wallet transactions
    """
    list_display = [
        'id', 'user', 'type', 'amount', 'balance_after', 
        'description', 'created_at'
    ]
    list_filter = ['type', 'created_at']
    search_fields = ['user__username', 'user__email', 'reference_id', 'description']
    readonly_fields = [
        'user', 'type', 'amount', 'balance_before', 'balance_after',
        'description', 'reference_id', 'metadata', 'created_at'
    ]
    ordering = ['-created_at']
    date_hierarchy = 'created_at'
    
    def has_add_permission(self, request):
        return False
    
    def has_delete_permission(self, request, obj=None):
        return False


@admin.register(Withdrawal)
class WithdrawalAdmin(admin.ModelAdmin):
    """
    Admin interface for withdrawal requests
    """
    list_display = [
        'reference_number', 'user', 'amount', 'status', 
        'created_at', 'processed_at'
    ]
    list_filter = ['status', 'created_at', 'processed_at']
    search_fields = ['user__username', 'user__email', 'reference_number']
    readonly_fields = ['reference_number', 'created_at', 'processed_by']
    
    fieldsets = (
        ('Request Info', {
            'fields': ('reference_number', 'user', 'amount', 'account_details', 'created_at')
        }),
        ('Status', {
            'fields': ('status', 'processed_at', 'processed_by')
        }),
        ('Admin Notes', {
            'fields': ('admin_notes', 'rejection_reason')
        }),
    )
    
    ordering = ['-created_at']
    date_hierarchy = 'created_at'
    
    actions = ['approve_withdrawals', 'reject_withdrawals']
    
    def approve_withdrawals(self, request, queryset):
        """
        Approve selected withdrawal requests
        """
        updated = queryset.filter(status='pending').update(
            status='approved',
            processed_at=timezone.now(),
            processed_by=request.user
        )
        self.message_user(request, f'{updated} withdrawal(s) approved')
    approve_withdrawals.short_description = 'Approve selected withdrawals'
    
    def reject_withdrawals(self, request, queryset):
        """
        Reject selected withdrawal requests
        """
        from apps.wallet.models import WalletTransaction
        from django.db import transaction as db_transaction
        
        for withdrawal in queryset.filter(status='pending'):
            with db_transaction.atomic():
                # Refund the amount
                user = withdrawal.user
                user.wallet_balance += withdrawal.amount
                user.save()
                
                # Update withdrawal status
                withdrawal.status = 'rejected'
                withdrawal.processed_at = timezone.now()
                withdrawal.processed_by = request.user
                withdrawal.rejection_reason = 'Rejected by admin'
                withdrawal.save()
                
                # Create refund transaction
                WalletTransaction.objects.create(
                    user=user,
                    type='refund',
                    amount=withdrawal.amount,
                    balance_before=user.wallet_balance - withdrawal.amount,
                    balance_after=user.wallet_balance,
                    description=f'Withdrawal refund #{withdrawal.reference_number}',
                    reference_id=str(withdrawal.reference_number)
                )
        
        self.message_user(request, 'Selected withdrawal(s) rejected and refunded')
    reject_withdrawals.short_description = 'Reject and refund selected withdrawals'
