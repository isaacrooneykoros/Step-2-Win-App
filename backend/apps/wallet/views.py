from rest_framework import generics, status
from rest_framework.decorators import api_view, permission_classes, throttle_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from django.db import transaction
from django.db.models import Sum
from django.utils import timezone
from django.conf import settings
from decimal import Decimal
from datetime import timedelta
import uuid
from .models import WalletTransaction, Withdrawal
from .serializers import (
    TransactionSerializer, 
    WithdrawalSerializer,
    DepositSerializer,
    WalletSummarySerializer
)
from apps.users.views import WalletThrottle


@api_view(['GET'])
@permission_classes([IsAuthenticated])
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


@api_view(['POST'])
@permission_classes([IsAuthenticated])
@throttle_classes([WalletThrottle])
def deposit(request):
    """
    Process a deposit (simulated for demo purposes)
    """
    serializer = DepositSerializer(data=request.data)
    serializer.is_valid(raise_exception=True)
    
    amount = serializer.validated_data['amount']
    payment_method = serializer.validated_data.get('payment_method', 'card')
    reference_id = serializer.validated_data.get('reference_id')
    
    with transaction.atomic():
        user = request.user.__class__.objects.select_for_update().get(id=request.user.id)
        balance_before = user.wallet_balance
        user.wallet_balance += amount
        user.save()
        
        # Create transaction record
        trans = WalletTransaction.objects.create(
            user=user,
            type='deposit',
            amount=amount,
            balance_before=balance_before,
            balance_after=user.wallet_balance,
            description=f'Deposit via {payment_method}',
            reference_id=reference_id,
            metadata={
                'payment_method': payment_method,
                'status': 'completed'
            }
        )
    
    return Response({
        'status': 'Deposit successful',
        'balance': str(user.wallet_balance),
        'transaction_id': trans.id,  # type: ignore[attr-defined]
        'amount': str(amount)
    }, status=status.HTTP_201_CREATED)


@api_view(['POST'])
@permission_classes([IsAuthenticated])
@throttle_classes([WalletThrottle])
def withdraw(request):
    """
    Instantly initiate M-Pesa withdrawal to user's phone number.
    Includes automated security checks (rate limiting, velocity, amount caps).
    """
    serializer = WithdrawalSerializer(data=request.data)
    serializer.is_valid(raise_exception=True)
    
    amount = serializer.validated_data['amount']
    phone_number = serializer.validated_data['phone_number']

    from apps.payments import pochipay
    from apps.payments.models import PaymentTransaction

    user = request.user

    # ── Security Check 1: Amount Limits ────────────────────────────────────
    max_withdrawal = Decimal(str(getattr(settings, 'MAX_WITHDRAWAL_KES', 50000)))
    if amount > max_withdrawal:
        return Response(
            {'error': f'Maximum withdrawal is KES {max_withdrawal} per transaction'},
            status=status.HTTP_400_BAD_REQUEST
        )

    # ── Security Check 2: Daily Transaction Count ──────────────────────────
    max_per_day = getattr(settings, 'MAX_WITHDRAWALS_PER_DAY', 3)
    today_start = timezone.now().replace(hour=0, minute=0, second=0, microsecond=0)
    today_withdrawals = Withdrawal.objects.filter(
        user=user,
        created_at__gte=today_start
    ).count()
    
    if today_withdrawals >= max_per_day:
        return Response(
            {'error': f'Daily withdrawal limit reached ({max_per_day} per day). Try again tomorrow.'},
            status=status.HTTP_429_TOO_MANY_REQUESTS
        )

    # ── Security Check 3: Hourly Transaction Count ─────────────────────────
    max_per_hour = getattr(settings, 'MAX_WITHDRAWALS_PER_HOUR', 1)
    hour_ago = timezone.now() - timedelta(hours=1)
    hour_withdrawals = Withdrawal.objects.filter(
        user=user,
        created_at__gte=hour_ago
    ).count()
    
    if hour_withdrawals >= max_per_hour:
        return Response(
            {'error': 'Please wait before making another withdrawal. Limit: 1 per hour.'},
            status=status.HTTP_429_TOO_MANY_REQUESTS
        )

    # ── Security Check 4: Minimum Time Between Withdrawals ────────────────
    min_seconds = getattr(settings, 'MIN_SECONDS_BETWEEN_WITHDRAWALS', 300)
    last_withdrawal = Withdrawal.objects.filter(user=user).order_by('-created_at').first()
    
    if last_withdrawal:
        time_since_last = (timezone.now() - last_withdrawal.created_at).total_seconds()
        if time_since_last < min_seconds:
            wait_minutes = int((min_seconds - time_since_last) / 60)
            return Response(
                {'error': f'Please wait {wait_minutes} more minute(s) before withdrawing again.'},
                status=status.HTTP_429_TOO_MANY_REQUESTS
            )

    # ── Security Check 5: Daily Amount Limit ───────────────────────────────
    max_daily_amount = Decimal(str(getattr(settings, 'MAX_DAILY_WITHDRAWAL_AMOUNT_KES', 100000)))
    today_amount = Withdrawal.objects.filter(
        user=user,
        created_at__gte=today_start,
        status__in=['processing', 'completed']
    ).aggregate(total=Sum('amount'))['total'] or Decimal('0')
    
    if today_amount + amount > max_daily_amount:
        remaining = max_daily_amount - today_amount
        return Response(
            {'error': f'Daily withdrawal limit exceeded. Remaining today: KES {remaining}'},
            status=status.HTTP_400_BAD_REQUEST
        )

    # ── Security Check 6: Phone Number Ownership (Future: implement OTP) ──
    # TODO: Add phone verification via SMS OTP before first withdrawal
    # if not user.phone_verified:
    #     return Response({'error': 'Please verify your phone number first'}, status=400)

    # ── Balance Check ──────────────────────────────────────────────────────
    if user.available_balance < amount:
        return Response(
            {'error': f'Insufficient balance. Available: KES {user.available_balance}'},
            status=status.HTTP_400_BAD_REQUEST
        )

    try:
        # Deduct wallet first; callback will refund on payout failure
        balance_before = user.wallet_balance
        user.wallet_balance -= amount
        user.save()

        withdrawal = Withdrawal.objects.create(
            user=user,
            amount=amount,
            account_details=phone_number,
            status='processing',
        )

        tracking_reference = pochipay.generate_tracking_reference('WDR')
        request_id = f"WDR-{uuid.uuid4().hex[:16].upper()}"

        PaymentTransaction.objects.create(
            user=user,
            type='payout',
            status='pending',
            amount_kes=amount,
            order_id=str(withdrawal.reference_number),
            tracking_reference=tracking_reference,
            request_id=request_id,
            phone_number=phone_number,
            narration='Step2Win instant wallet withdrawal',
        )

        WalletTransaction.objects.create(
            user=user,
            type='withdrawal',
            amount=-amount,
            balance_before=balance_before,
            balance_after=user.wallet_balance,
            description=f'M-Pesa withdrawal #{withdrawal.reference_number} to {phone_number}',
            reference_id=str(withdrawal.reference_number),
            metadata={
                'withdrawal_id': withdrawal.id,  # type: ignore[attr-defined]
                'status': 'processing',
                'phone_number': phone_number,
                'tracking_reference': tracking_reference,
            }
        )

        # Send instant payout to M-Pesa
        pochipay.send_to_mobile(
            recipients=[{
                'amount': float(amount),
                'remarks': 'Step2Win wallet withdrawal',
                'trackingReference': tracking_reference,
                'phoneNumber': phone_number,
            }],
            request_id=request_id,
            title='Step2Win Wallet Withdrawal',
        )

    except Exception as exc:
        return Response(
            {'error': f'Withdrawal initiation failed: {exc}'},
            status=status.HTTP_502_BAD_GATEWAY
        )
    
    return Response({
        'status': 'Withdrawal initiated',
        'reference_number': str(withdrawal.reference_number),
        'amount': str(amount),
        'message': f'Money is being sent to {phone_number}. You should receive it shortly.'
    }, status=status.HTTP_201_CREATED)


class WithdrawalListView(generics.ListAPIView):
    """
    List all withdrawal requests for authenticated user
    """
    serializer_class = WithdrawalSerializer
    permission_classes = [IsAuthenticated]
    
    def get_queryset(self):
        return Withdrawal.objects.filter(user=self.request.user)


@api_view(['GET'])
@permission_classes([IsAuthenticated])
def withdrawal_detail(request, reference_number):
    """
    Get details of a specific withdrawal
    """
    try:
        withdrawal = Withdrawal.objects.get(
            reference_number=reference_number,
            user=request.user
        )
        serializer = WithdrawalSerializer(withdrawal)
        return Response(serializer.data)
    except Withdrawal.DoesNotExist:
        return Response(
            {'error': 'Withdrawal not found'}, 
            status=status.HTTP_404_NOT_FOUND
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
