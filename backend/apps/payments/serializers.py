from decimal import Decimal

from rest_framework import serializers


def _fmt_kes(value: Decimal) -> str:
    return f"{value:,.0f}" if value == value.to_integral_value() else f"{value:,.2f}"


class InitiateDepositSerializer(serializers.Serializer):
    amount = serializers.DecimalField(max_digits=12, decimal_places=2)
    phone_number = serializers.CharField()

    def validate_amount(self, value):
        # Console limits (Settings > Money), inside the server's hard limits.
        from apps.admin_api.business_rules import deposit_limits

        min_deposit, max_deposit = deposit_limits()
        if value < min_deposit:
            raise serializers.ValidationError(f"Minimum deposit is KES {_fmt_kes(min_deposit)}")
        if value > max_deposit:
            raise serializers.ValidationError(f"Maximum deposit is KES {_fmt_kes(max_deposit)}")
        return value


class WithdrawalRequestInputSerializer(serializers.Serializer):
    method = serializers.ChoiceField(choices=["mpesa", "bank", "paybill"])
    amount = serializers.DecimalField(max_digits=12, decimal_places=2)
    phone_number = serializers.CharField(required=False, allow_blank=False)
    bank_code = serializers.CharField(required=False, allow_blank=False)
    account_number = serializers.CharField(required=False, allow_blank=False)
    short_code = serializers.CharField(required=False, allow_blank=False)
    is_paybill = serializers.BooleanField(required=False, default=True)

    def validate_amount(self, value):
        from apps.admin_api.business_rules import withdrawal_limits

        limits = withdrawal_limits()
        min_withdrawal = Decimal(str(limits["min_kes"]))
        max_withdrawal = Decimal(str(limits["max_kes"]))
        if value < min_withdrawal:
            raise serializers.ValidationError(
                f"Minimum withdrawal is KES {_fmt_kes(min_withdrawal)}"
            )
        if value > max_withdrawal:
            raise serializers.ValidationError(
                f"Maximum single withdrawal is KES {_fmt_kes(max_withdrawal)}"
            )
        return value

    def validate(self, attrs):
        method = attrs.get("method")
        if method == "mpesa" and not attrs.get("phone_number"):
            raise serializers.ValidationError(
                {"phone_number": "phone_number is required for M-Pesa"}
            )
        if method == "bank" and (
            not attrs.get("bank_code") or not attrs.get("account_number")
        ):
            raise serializers.ValidationError(
                "bank_code and account_number are required for bank withdrawals"
            )
        if method == "paybill" and not attrs.get("short_code"):
            raise serializers.ValidationError("short_code is required for paybill/till")
        return attrs
