from decimal import Decimal

from django.conf import settings
from rest_framework import serializers


class InitiateDepositSerializer(serializers.Serializer):
    amount = serializers.DecimalField(max_digits=12, decimal_places=2)
    phone_number = serializers.CharField()

    def validate_amount(self, value):
        min_deposit = Decimal(str(settings.MIN_DEPOSIT_KES))
        max_deposit = Decimal(str(settings.MAX_DEPOSIT_KES))
        if value < min_deposit:
            raise serializers.ValidationError(f'Minimum deposit is KES {min_deposit}')
        if value > max_deposit:
            raise serializers.ValidationError(f'Maximum deposit is KES {max_deposit}')
        return value


class WithdrawalRequestInputSerializer(serializers.Serializer):
    method = serializers.ChoiceField(choices=['mpesa', 'bank', 'paybill'])
    amount = serializers.DecimalField(max_digits=12, decimal_places=2)
    phone_number = serializers.CharField(required=False, allow_blank=False)
    bank_code = serializers.CharField(required=False, allow_blank=False)
    account_number = serializers.CharField(required=False, allow_blank=False)
    short_code = serializers.CharField(required=False, allow_blank=False)
    is_paybill = serializers.BooleanField(required=False, default=True)

    def validate_amount(self, value):
        min_withdrawal = Decimal(str(settings.MIN_WITHDRAWAL_KES))
        max_withdrawal = Decimal(str(settings.MAX_WITHDRAWAL_KES))
        if value < min_withdrawal:
            raise serializers.ValidationError(f'Minimum withdrawal is KES {min_withdrawal}')
        if value > max_withdrawal:
            raise serializers.ValidationError(f'Maximum single withdrawal is KES {max_withdrawal}')
        return value

    def validate(self, attrs):
        method = attrs.get('method')
        if method == 'mpesa' and not attrs.get('phone_number'):
            raise serializers.ValidationError({'phone_number': 'phone_number is required for M-Pesa'})
        if method == 'bank' and (not attrs.get('bank_code') or not attrs.get('account_number')):
            raise serializers.ValidationError('bank_code and account_number are required for bank withdrawals')
        if method == 'paybill' and not attrs.get('short_code'):
            raise serializers.ValidationError('short_code is required for paybill/till')
        return attrs