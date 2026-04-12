from django.db import models
from django.conf import settings
from django.core.exceptions import ValidationError
from decimal import Decimal
import uuid
from auditlog.registry import auditlog


def generate_reference_number():
    return str(uuid.uuid4())


class WalletTransaction(models.Model):
    """
    Model for tracking all wallet transactions.

    The ``user`` field is nullable only for platform-level fee records
    (``type='fee'``). Every other transaction type must have a user.
    This invariant is enforced by :meth:`clean`.
    """
    TYPE_CHOICES = [
        ('deposit', 'Deposit'),
        ('withdrawal', 'Withdrawal'),
        ('challenge_entry', 'Challenge Entry'),
        ('payout', 'Payout'),
        ('fee', 'Platform Fee'),
        ('refund', 'Refund'),
    ]
    
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, 
        on_delete=models.CASCADE, 
        related_name='transactions',
        null=True,
        blank=True,
        help_text=(
            'Required for all transaction types except "fee". '
            'Platform fee records may have user=None.'
        ),
    )
    type = models.CharField(max_length=20, choices=TYPE_CHOICES)
    amount = models.DecimalField(
        max_digits=10, 
        decimal_places=2,
        help_text='Positive for credits, negative for debits'
    )
    balance_before = models.DecimalField(
        max_digits=10, 
        decimal_places=2, 
        default=Decimal('0.00')
    )
    balance_after = models.DecimalField(
        max_digits=10, 
        decimal_places=2
    )
    description = models.CharField(max_length=255)
    reference_id = models.CharField(
        max_length=100, 
        unique=True, 
        null=True, 
        blank=True,
        help_text='External transaction reference'
    )
    metadata = models.JSONField(
        null=True, 
        blank=True,
        help_text='Additional transaction data'
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        indexes = [
            models.Index(fields=['user', '-created_at']),
            models.Index(fields=['type']),
            models.Index(fields=['created_at']),
        ]
        ordering = ['-created_at']
    
    def clean(self):
        # Platform fee transactions may legitimately have no user (they represent
        # the pool-level deduction, not a per-user credit/debit). All other types
        # MUST be linked to a user.
        if self.type != 'fee' and self.user_id is None:
            raise ValidationError(
                {'user': f'user is required for transaction type "{self.type}".'}
            )

    def __str__(self):
        return f"{self.get_type_display()} - {self.amount} - {self.created_at}"  # type: ignore[attr-defined]


class Withdrawal(models.Model):
    """
    Model for instant withdrawal transactions
    """
    STATUS_CHOICES = [
        ('processing', 'Processing'),
        ('completed', 'Completed'),
        ('failed', 'Failed'),
    ]
    
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, 
        on_delete=models.CASCADE,
        related_name='withdrawals'
    )
    amount = models.DecimalField(max_digits=10, decimal_places=2)
    account_details = models.TextField(
        help_text='Bank account or payment details'
    )
    status = models.CharField(
        max_length=20, 
        choices=STATUS_CHOICES, 
        default='processing'
    )
    admin_notes = models.TextField(
        blank=True,
        help_text='Internal admin notes'
    )
    rejection_reason = models.TextField(
        blank=True,
        help_text='Reason for rejection (shown to user)'
    )
    reference_number = models.CharField(
        max_length=50,
        unique=True,
        default=generate_reference_number,
        help_text='Unique withdrawal reference'
    )
    created_at = models.DateTimeField(auto_now_add=True)
    processed_at = models.DateTimeField(null=True, blank=True)
    processed_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='processed_withdrawals'
    )

    class Meta:
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['user', '-created_at']),
            models.Index(fields=['status', '-created_at']),
        ]
    
    def __str__(self):
        return f"{self.user.username} - ${self.amount} - {self.status}"


auditlog.register(WalletTransaction)
