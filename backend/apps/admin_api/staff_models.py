"""Models for staff roles, staff invites and money controls (admin console part A).

Imported at the bottom of apps/admin_api/models.py so Django registers them in the
admin_api app. See apps/admin_api/roles.py for the permission map and
apps/admin_api/money.py for how wallet corrections are applied.
"""

import hashlib
import secrets
from decimal import Decimal

from django.conf import settings
from django.db import models
from django.utils import timezone


class StaffProfile(models.Model):
    """The console roles a staff account holds (see apps/admin_api/roles.py).

    Superusers are owners regardless of this row. A staff account without a row
    keeps the legacy default (every role except owner)."""

    user = models.OneToOneField(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="staff_profile"
    )
    roles = models.JSONField(default=list, blank=True)
    updated_at = models.DateTimeField(auto_now=True)
    updated_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="+",
    )

    def __str__(self):
        return f"{self.user} roles={self.roles}"


def _hash_code(code: str) -> str:
    return hashlib.sha256(code.strip().upper().encode("utf-8")).hexdigest()


class StaffInvite(models.Model):
    """One-time code that lets a new person create a staff account with set roles.

    Only the SHA-256 of the code is stored; the owner sees the code once when the
    invite is created and shares it through a trusted channel."""

    email = models.EmailField()
    roles = models.JSONField(default=list)
    code_hash = models.CharField(max_length=64, unique=True)
    code_hint = models.CharField(max_length=8, blank=True)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, related_name="+"
    )
    created_at = models.DateTimeField(auto_now_add=True)
    expires_at = models.DateTimeField()
    accepted_at = models.DateTimeField(null=True, blank=True)
    accepted_user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="+",
    )
    revoked_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-created_at"]

    @staticmethod
    def new_code() -> str:
        alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
        raw = "".join(secrets.choice(alphabet) for _ in range(16))
        return "-".join(raw[i : i + 4] for i in range(0, 16, 4))

    @staticmethod
    def hash_code(code: str) -> str:
        return _hash_code(code.replace("-", "").replace(" ", "") if code else "")

    @property
    def status(self) -> str:
        if self.accepted_at:
            return "accepted"
        if self.revoked_at:
            return "revoked"
        if self.expires_at <= timezone.now():
            return "expired"
        return "pending"

    def __str__(self):
        return f"Invite {self.email} ({self.status})"


class ConsoleControls(models.Model):
    """Owner-level money controls (singleton)."""

    # Wallet adjustments / reversals at or above this amount (absolute KES) need a
    # second finance/owner approver; below it they apply immediately.
    adjustment_approval_threshold_kes = models.DecimalField(
        max_digits=12, decimal_places=2, default=Decimal("5000.00")
    )
    updated_at = models.DateTimeField(auto_now=True)
    updated_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name="+"
    )

    def save(self, *args, **kwargs):
        self.pk = 1
        super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        pass

    @classmethod
    def load(cls):
        obj, _ = cls.objects.get_or_create(pk=1)
        return obj


class WalletCorrection(models.Model):
    """A staff request to correct a wallet: an adjustment (+/-) or the reversal of one
    ledger row. The ledger is never edited: applying a correction writes a new
    WalletTransaction (type adjustment / reversal). Requests at or above the
    ConsoleControls threshold wait for a second finance/owner approver."""

    KIND_ADJUSTMENT = "adjustment"
    KIND_REVERSAL = "reversal"
    KIND_CHOICES = [(KIND_ADJUSTMENT, "Adjustment"), (KIND_REVERSAL, "Reversal")]

    STATUS_PENDING = "pending"
    STATUS_APPLIED = "applied"
    STATUS_REJECTED = "rejected"
    STATUS_FAILED = "failed"
    STATUS_CHOICES = [
        (STATUS_PENDING, "Waiting for approval"),
        (STATUS_APPLIED, "Applied"),
        (STATUS_REJECTED, "Rejected"),
        (STATUS_FAILED, "Failed"),
    ]

    kind = models.CharField(max_length=12, choices=KIND_CHOICES)
    status = models.CharField(max_length=10, choices=STATUS_CHOICES, default=STATUS_PENDING, db_index=True)
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="wallet_corrections"
    )
    # Signed: positive credits the wallet, negative debits it.
    amount = models.DecimalField(max_digits=10, decimal_places=2)
    reason = models.TextField()
    reference = models.CharField(max_length=100, blank=True)
    idempotency_key = models.CharField(max_length=100, unique=True)
    target_transaction = models.ForeignKey(
        "wallet.WalletTransaction",
        on_delete=models.PROTECT,
        null=True,
        blank=True,
        related_name="correction_requests",
    )
    requested_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, related_name="+"
    )
    requested_at = models.DateTimeField(auto_now_add=True)
    needs_second_approval = models.BooleanField(default=False)
    decided_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name="+"
    )
    decided_at = models.DateTimeField(null=True, blank=True)
    decision_note = models.TextField(blank=True)
    applied_transaction = models.OneToOneField(
        "wallet.WalletTransaction",
        on_delete=models.PROTECT,
        null=True,
        blank=True,
        related_name="correction",
    )
    error = models.CharField(max_length=255, blank=True)

    class Meta:
        ordering = ["-requested_at"]
        indexes = [models.Index(fields=["user", "-requested_at"], name="adm_wcorr_user_idx")]

    def __str__(self):
        return f"{self.kind} {self.amount} for user {self.user_id} ({self.status})"
