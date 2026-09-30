from rest_framework import serializers

from .models import WalletTransaction, Withdrawal


class TransactionSerializer(serializers.ModelSerializer):
    """
    Serializer for wallet transactions
    """

    user_username = serializers.CharField(source="user.username", read_only=True)
    type_display = serializers.CharField(source="get_type_display", read_only=True)

    class Meta:
        model = WalletTransaction
        fields = [
            "id",
            "user",
            "user_username",
            "type",
            "type_display",
            "amount",
            "balance_before",
            "balance_after",
            "description",
            "reference_id",
            "metadata",
            "created_at",
        ]
        read_only_fields = [
            "id",
            "user",
            "balance_before",
            "balance_after",
            "created_at",
        ]


class WithdrawalSerializer(serializers.ModelSerializer):
    """
    Serializer for withdrawal requests
    """

    status_display = serializers.CharField(source="get_status_display", read_only=True)
    phone_number = serializers.CharField(
        write_only=True,
        required=True,
        help_text="M-Pesa phone number (e.g., 0712345678 or 254712345678)",
    )

    class Meta:
        model = Withdrawal
        fields = [
            "id",
            "amount",
            "phone_number",
            "status",
            "status_display",
            "reference_number",
            "created_at",
            "processed_at",
        ]
        read_only_fields = [
            "id",
            "status",
            "reference_number",
            "created_at",
            "processed_at",
        ]

    def validate_amount(self, value):
        if value < 10:
            raise serializers.ValidationError("Minimum withdrawal amount is KES 10.00")
        if value > 100000:
            raise serializers.ValidationError(
                "Maximum withdrawal amount is KES 100,000.00"
            )
        return value

    def validate(self, attrs):
        phone_number = attrs.get("phone_number")

        from apps.payments import intasend

        try:
            formatted = intasend.format_phone(phone_number)
        except ValueError as exc:
            raise serializers.ValidationError({"phone_number": str(exc)})

        attrs["phone_number"] = formatted
        attrs["account_details"] = formatted
        return attrs


class DepositSerializer(serializers.Serializer):
    """
    Serializer for deposit requests
    """

    amount = serializers.DecimalField(max_digits=10, decimal_places=2)
    payment_method = serializers.ChoiceField(
        choices=["card", "bank", "paypal"], default="card"
    )
    reference_id = serializers.CharField(required=False, allow_blank=True)

    def validate_amount(self, value):
        if value <= 0:
            raise serializers.ValidationError("Amount must be positive")
        # Deposit limits (Settings > Money, inside the server's hard limits).
        from apps.admin_api.business_rules import deposit_limits

        lo, hi = deposit_limits()
        if value < lo:
            raise serializers.ValidationError(f"Minimum deposit is KES {lo:,.0f}")
        if value > hi:
            raise serializers.ValidationError(f"Maximum deposit is KES {hi:,.0f}")
        return value


class WalletSummarySerializer(serializers.Serializer):
    """
    Serializer for wallet summary data
    """

    balance = serializers.DecimalField(max_digits=10, decimal_places=2)
    locked_balance = serializers.DecimalField(max_digits=10, decimal_places=2)
    available_balance = serializers.DecimalField(max_digits=10, decimal_places=2)
    total_deposited = serializers.DecimalField(max_digits=10, decimal_places=2)
    total_withdrawn = serializers.DecimalField(max_digits=10, decimal_places=2)
    total_earned = serializers.DecimalField(max_digits=10, decimal_places=2)
    # Challenge payouts held for review (not in the balance yet).
    payouts_under_review = serializers.ListField(
        child=serializers.DictField(), required=False
    )
    under_review_total = serializers.DecimalField(
        max_digits=10, decimal_places=2, required=False
    )
