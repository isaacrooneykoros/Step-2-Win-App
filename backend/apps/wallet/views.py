from rest_framework import generics, status
from rest_framework.decorators import api_view, permission_classes, throttle_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework import serializers
from drf_spectacular.utils import extend_schema, inline_serializer
from django.db.models import Sum
from decimal import Decimal
from .models import WalletTransaction
from apps.payments.models import WithdrawalRequest
from .serializers import (
    TransactionSerializer, 
    DepositSerializer,
    WalletSummarySerializer
)
from apps.core.throttles import DashboardReadRateThrottle, DepositRateThrottle, WithdrawalRateThrottle
from apps.core.idempotency import acquire_idempotency_slot
from apps.payments.serializers import WithdrawalRequestInputSerializer
from apps.payments.services import (
    PaymentsServiceError,
    initiate_deposit as initiate_deposit_service,
    request_withdrawal as create_withdrawal_request,
)


class WithdrawalRequestDisplaySerializer(serializers.Serializer):
    id = serializers.CharField()
    status = serializers.CharField()
    amount_kes = serializers.CharField()
    method = serializers.CharField()
    destination = serializers.SerializerMethodField()
    mpesa_ref = serializers.SerializerMethodField()
    fail_reason = serializers.SerializerMethodField()
    created_at = serializers.CharField()
    updated_at = serializers.CharField()

    def get_destination(self, obj) -> str:
        return obj.destination_display

    def get_mpesa_ref(self, obj) -> str:
        return obj.mpesa_reference

    def get_fail_reason(self, obj) -> str:
        return obj.fail_reason or obj.rejection_reason


@extend_schema(responses={200: WalletSummarySerializer})
@api_view(['GET'])
@permission_classes([IsAuthenticated])
@throttle_classes([DashboardReadRateThrottle])
def wallet_summary(request):
    """
    Get comprehensive wallet summary
    """
    user = request.user
    
    # Calculate totals
    transactions = WalletTransaction.objects.filter(user=user)
    total_deposited = transactions.filter(
        type='deposit'
    ).aggregate(Sum('amount'))['amount__sum'] or Decimal('0.00')
    
    total_withdrawn = abs(transactions.filter(
        type='withdrawal'
    ).aggregate(Sum('amount'))['amount__sum'] or Decimal('0.00'))
    
    total_earned = transactions.filter(
        type='payout'
    ).aggregate(Sum('amount'))['amount__sum'] or Decimal('0.00')
    
    data = {
        'balance': user.wallet_balance,
        'locked_balance': user.locked_balance,
        'available_balance': user.available_balance,
        'total_deposited': total_deposited,
        'total_withdrawn': total_withdrawn,
        'total_earned': total_earned,
    }
    
    serializer = WalletSummarySerializer(data)
    return Response(serializer.data)


class TransactionListView(generics.ListAPIView):
    """
    List all transactions for authenticated user
    """
    serializer_class = TransactionSerializer
    permission_classes = [IsAuthenticated]
    
    def get_queryset(self):
        queryset = WalletTransaction.objects.filter(user=self.request.user)
        
        # Filter by transaction type
        trans_type = self.request.query_params.get('type')  # type: ignore[attr-defined]
        if trans_type:
            queryset = queryset.filter(type=trans_type)
        
        # Filter by date range
        start_date = self.request.query_params.get('start_date')  # type: ignore[attr-defined]
        end_date = self.request.query_params.get('end_date')  # type: ignore[attr-defined]
        if start_date:
            queryset = queryset.filter(created_at__gte=start_date)
        if end_date:
            queryset = queryset.filter(created_at__lte=end_date)
        
        return queryset


@extend_schema(
    request=DepositSerializer,
    responses={
        201: inline_serializer(
            name='DepositInitiationResponse',
            fields={
                'message': serializers.CharField(),
                'order_id': serializers.CharField(),
                'amount_kes': serializers.CharField(),
                'status': serializers.CharField(),
            },
        )
    },
)
@api_view(['POST'])
@permission_classes([IsAuthenticated])
@throttle_classes([DepositRateThrottle])
def deposit(request):
    """
    Initiate a production deposit using the payment lifecycle.

    The actual wallet credit happens in the deposit callback after the
    gateway confirms the payment.
    """
    serializer = DepositSerializer(data=request.data)
    serializer.is_valid(raise_exception=True)

    idem_key = request.headers.get('X-Idempotency-Key')
    if not acquire_idempotency_slot(
        scope='wallet_deposit',
        user_id=request.user.id,
        idempotency_key=idem_key,
        ttl_seconds=180,
    ):
        return Response({'error': 'Duplicate request'}, status=status.HTTP_409_CONFLICT)
    
    amount = serializer.validated_data['amount']
    try:
        trans = initiate_deposit_service(request.user, amount, request.user.phone_number)
    except PaymentsServiceError as exc:
        return Response({'error': exc.message}, status=exc.status_code)
    
    return Response({
        'message': 'M-Pesa STK Push sent. Check your phone to complete payment.',
        'order_id': trans.order_id,
        'amount_kes': str(trans.amount_kes),
        'status': trans.status,
    }, status=status.HTTP_201_CREATED)


@extend_schema(
    request=WithdrawalRequestInputSerializer,
    responses={
        201: inline_serializer(
            name='WithdrawalInitiateResponse',
            fields={
                'message': serializers.CharField(),
                'withdrawal_id': serializers.CharField(),
                'amount_kes': serializers.CharField(),
                'method': serializers.CharField(),
                'status': serializers.CharField(),
                'destination': serializers.CharField(),
            },
        )
    },
)
@api_view(['POST'])
@permission_classes([IsAuthenticated])
@throttle_classes([WithdrawalRateThrottle])
def withdraw(request):
    """
    Instantly initiate M-Pesa withdrawal to user's phone number.
    Includes automated security checks (rate limiting, velocity, amount caps).
    """
    try:
        idem_key = request.headers.get('X-Idempotency-Key')
        if not acquire_idempotency_slot(
            scope='wallet_withdrawal',
            user_id=request.user.id,
            idempotency_key=idem_key,
            ttl_seconds=180,
        ):
            return Response({'error': 'Duplicate request'}, status=status.HTTP_409_CONFLICT)

        serializer = WithdrawalRequestInputSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        withdrawal = create_withdrawal_request(request.user, serializer.validated_data)
    except PaymentsServiceError as exc:
        return Response({'error': exc.message}, status=exc.status_code)
    
    return Response({
        'status': withdrawal.status,
        'withdrawal_id': str(withdrawal.id),
        'amount_kes': str(withdrawal.amount_kes),
        'method': withdrawal.method,
        'destination': withdrawal.destination_display,
        'message': 'Withdrawal request submitted and is pending review.'
    }, status=status.HTTP_201_CREATED)


class WithdrawalListView(generics.ListAPIView):
    """
    List all withdrawal requests for authenticated user
    """
    serializer_class = WithdrawalRequestDisplaySerializer
    permission_classes = [IsAuthenticated]
    
    def get_queryset(self):
        return WithdrawalRequest.objects.filter(user=self.request.user)


@extend_schema(responses={200: WithdrawalRequestDisplaySerializer})
@api_view(['GET'])
@permission_classes([IsAuthenticated])
def withdrawal_detail(request, withdrawal_id):
    """
    Get details of a specific withdrawal
    """
    try:
        withdrawal = WithdrawalRequest.objects.get(
            id=withdrawal_id,
            user=request.user
        )
        return Response({
            'id': str(withdrawal.id),
            'status': withdrawal.status,
            'amount_kes': str(withdrawal.amount_kes),
            'method': withdrawal.method,
            'destination': withdrawal.destination_display,
            'mpesa_ref': withdrawal.mpesa_reference,
            'fail_reason': withdrawal.fail_reason or withdrawal.rejection_reason,
            'created_at': withdrawal.created_at.isoformat(),
            'updated_at': withdrawal.updated_at.isoformat(),
        })
    except WithdrawalRequest.DoesNotExist:
        return Response(
            {'error': 'Withdrawal not found'}, 
            status=status.HTTP_404_NOT_FOUND
        )


@extend_schema(
    responses={
        200: inline_serializer(
            name='TransactionStatsResponse',
            fields={
                'total_transactions': serializers.IntegerField(),
                'by_type': serializers.DictField(),
                'latest_transaction': TransactionSerializer(allow_null=True),
            },
        )
    }
)
@api_view(['GET'])
@permission_classes([IsAuthenticated])
def transaction_stats(request):
    """
    Get transaction statistics for the user
    """
    user = request.user
    transactions = WalletTransaction.objects.filter(user=user)
    
    # Count by type
    stats_by_type = {}
    for choice in WalletTransaction.TYPE_CHOICES:
        type_code = choice[0]
        count = transactions.filter(type=type_code).count()
        total = transactions.filter(type=type_code).aggregate(
            Sum('amount')
        )['amount__sum'] or Decimal('0.00')
        stats_by_type[type_code] = {
            'count': count,
            'total': str(total)
        }
    
    return Response({
        'total_transactions': transactions.count(),
        'by_type': stats_by_type,
        'latest_transaction': TransactionSerializer(
            transactions.first()
        ).data if transactions.exists() else None
    })
