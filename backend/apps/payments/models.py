import uuid
from django.db import models
from django.conf import settings


class PaymentTransaction(models.Model):
    """
    Master record for every M-Pesa payment (deposit or payout).
    Links Step2Win's internal wallet to PochPay's external transaction.

    For deposits: one record per user deposit attempt.
    For payouts:  one record per winner per challenge payout.
    """

    TYPE_CHOICES = [
        ('deposit',     'Deposit'),          # User funds their wallet
        ('payout',      'Challenge Payout'), # Winner receives prize
        ('refund',      'Refund'),           # Failed challenge refund
    ]

    STATUS_CHOICES = [
        ('initiated',  'Initiated'),   # We called PochPay, waiting for user
        ('pending',    'Pending'),     # M-Pesa processing
        ('completed',  'Completed'),   # Confirmed successful
        ('failed',     'Failed'),      # Payment failed
        ('cancelled',  'Cancelled'),   # User cancelled M-Pesa prompt
    ]

    # Internal identifiers
    id                  = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user                = models.ForeignKey(
                            settings.AUTH_USER_MODEL,
                            on_delete=models.PROTECT,
                            related_name='payment_transactions'
                          )
    type                = models.CharField(max_length=20, choices=TYPE_CHOICES)
    status              = models.CharField(max_length=20, choices=STATUS_CHOICES, default='initiated')
    amount_kes          = models.DecimalField(max_digits=12, decimal_places=2)

    # PochPay identifiers — store both sides for reconciliation
    order_id            = models.CharField(max_length=100, unique=True)  # our ID sent to PochPay
    tracking_reference  = models.CharField(max_length=100, unique=True)  # our disbursement ID
    collection_id       = models.CharField(max_length=100, blank=True)   # PochPay's collection ID
    request_id          = models.CharField(max_length=100, blank=True)   # PochPay batch ID
    mpesa_reference     = models.CharField(max_length=100, blank=True)   # M-Pesa's TXN reference
    fail_reason         = models.TextField(blank=True)

    # Links
    challenge           = models.ForeignKey(
                            'challenges.Challenge',
                            on_delete=models.SET_NULL,
                            null=True, blank=True,
                            related_name='payment_transactions'
                          )

    # Audit
    phone_number        = models.CharField(max_length=20)
    narration           = models.CharField(max_length=255)
    callback_received_at= models.DateTimeField(null=True, blank=True)
    created_at          = models.DateTimeField(auto_now_add=True)
    updated_at          = models.DateTimeField(auto_now=True)

    class Meta:
        indexes = [
            models.Index(fields=['user', '-created_at']),
            models.Index(fields=['order_id']),
            models.Index(fields=['tracking_reference']),
            models.Index(fields=['status', 'type']),
            models.Index(fields=['mpesa_reference']),
        ]
        ordering = ['-created_at']

    def __str__(self):
        return f"{self.user.username} | {self.type} | KES {self.amount_kes} | {self.status}"


class CallbackLog(models.Model):
    """
    Logs every raw callback received from PochPay.
    Essential for debugging payment issues and idempotency checks.
    Never delete these records.
    """
    type        = models.CharField(max_length=20)  # 'deposit' or 'payout'
    raw_payload = models.JSONField()
    order_id    = models.CharField(max_length=100, blank=True)
    processed   = models.BooleanField(default=False)
    created_at  = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        return f"Callback {self.type} | {self.order_id} | processed={self.processed}"


class WithdrawalRequest(models.Model):
    """
    User-initiated withdrawal request.
    Sits in 'pending_review' until an admin approves or rejects it.
    Balance is deducted immediately on creation and refunded on rejection/failure.

    This is SEPARATE from PaymentTransaction (which handles payouts).
    A WithdrawalRequest creates a PaymentTransaction when approved.
    """

    METHOD_CHOICES = [
        ('mpesa',   'M-Pesa Mobile'),
        ('bank',    'Bank Account'),
        ('paybill', 'Paybill / Till'),
    ]

    STATUS_CHOICES = [
        ('pending_review', 'Pending Admin Review'),
        ('approved',       'Approved'),
        ('processing',     'Processing'),
        ('completed',      'Completed'),
        ('rejected',       'Rejected'),
        ('failed',         'Failed'),
        ('cancelled',      'Cancelled'),
    ]

    id             = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user           = models.ForeignKey(
                       settings.AUTH_USER_MODEL, on_delete=models.PROTECT,
                       related_name='withdrawal_requests'
                     )
    status         = models.CharField(max_length=20, choices=STATUS_CHOICES,
                                      default='pending_review', db_index=True)
    amount_kes     = models.DecimalField(max_digits=12, decimal_places=2)
    method         = models.CharField(max_length=10, choices=METHOD_CHOICES)

    phone_number   = models.CharField(max_length=20, blank=True)
    bank_code      = models.CharField(max_length=10, blank=True)
    bank_name      = models.CharField(max_length=100, blank=True)
    account_number = models.CharField(max_length=50, blank=True)
    short_code     = models.CharField(max_length=20, blank=True)
    is_paybill     = models.BooleanField(default=True)

    tracking_reference = models.CharField(max_length=100, blank=True, unique=True, null=True)
    request_id         = models.CharField(max_length=100, blank=True)
    mpesa_reference    = models.CharField(max_length=100, blank=True)
    fail_reason        = models.TextField(blank=True)

    reviewed_by    = models.ForeignKey(
                       settings.AUTH_USER_MODEL, on_delete=models.SET_NULL,
                       null=True, blank=True, related_name='reviewed_withdrawals'
                     )
    reviewed_at    = models.DateTimeField(null=True, blank=True)
    rejection_reason = models.TextField(blank=True)

    narration      = models.CharField(max_length=255, blank=True)
    callback_received_at = models.DateTimeField(null=True, blank=True)
    created_at     = models.DateTimeField(auto_now_add=True)
    updated_at     = models.DateTimeField(auto_now=True)

    class Meta:
        indexes = [
            models.Index(fields=['user', '-created_at']),
            models.Index(fields=['status', '-created_at']),
            models.Index(fields=['tracking_reference']),
        ]
        ordering = ['-created_at']

    def __str__(self):
        return (f"{self.user.username} | {self.method} | "
                f"KES {self.amount_kes} | {self.status}")

    @property
    def destination_display(self) -> str:
        """Human-readable destination for admin display."""
        if self.method == 'mpesa':
            return f"M-Pesa: {self.phone_number}"
        if self.method == 'bank':
            return f"{self.bank_name}: {self.account_number}"
        if self.method == 'paybill':
            kind = 'Paybill' if self.is_paybill else 'Till'
            acc  = f' ({self.account_number})' if self.account_number else ''
            return f"{kind}: {self.short_code}{acc}"
        return 'Unknown'
