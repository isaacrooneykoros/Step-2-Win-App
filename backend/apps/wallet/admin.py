from django.contrib import admin
from .models import WalletTransaction


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


