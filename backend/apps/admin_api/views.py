import os
import uuid
import logging
from rest_framework import viewsets, status, permissions
from rest_framework.decorators import action, api_view, permission_classes
from rest_framework.response import Response
from django.utils import timezone
from django.db import transaction as db_transaction
from django.db.models import Sum
from django.contrib.auth import authenticate
from django.contrib.auth.password_validation import validate_password
from django.shortcuts import get_object_or_404
from rest_framework_simplejwt.tokens import RefreshToken
from rest_framework.permissions import AllowAny
from datetime import timedelta
from decimal import Decimal

logger = logging.getLogger(__name__)

from django.contrib.auth import get_user_model
from apps.users.models import UserXP
from apps.challenges.models import Challenge, Participant
from apps.wallet.models import WalletTransaction, Withdrawal
from apps.gamification.models import Badge, UserBadge, XPEvent
from apps.steps.models import HealthRecord
from apps.payments.models import WithdrawalRequest
from apps.payments import pochipay
from apps.payments.views import _notify_user

from apps.admin_api.serializers import (
    AdminUserSerializer,
    AdminChallengeSerializer,
    AdminTransactionSerializer,
    AdminWithdrawalSerializer,
    AdminBadgeSerializer,
    SupportTicketSerializer,
    SupportTicketMessageSerializer,
)

User = get_user_model()


def _admin_profile(user):
    return {
        'id': user.id,
        'username': user.username,
        'email': user.email,
        'is_staff': user.is_staff,
        'is_active': user.is_active,
    }


@api_view(['POST'])
@permission_classes([AllowAny])
def admin_login(request):
    """Authenticate admin user and return JWT tokens"""
    from apps.admin_api.models import AuditLog
    
    username = request.data.get('username', '').strip()
    password = request.data.get('password', '')

    if not username or not password:
        return Response(
            {'error': 'Username and password are required'},
            status=status.HTTP_400_BAD_REQUEST,
        )

    user = authenticate(username=username, password=password)
    if not user:
        return Response(
            {'error': 'Invalid credentials'},
            status=status.HTTP_401_UNAUTHORIZED,
        )

    if not user.is_active:
        return Response(
            {'error': 'Account is disabled'},
            status=status.HTTP_403_FORBIDDEN,
        )

    if not user.is_staff:
        return Response(
            {'error': 'Admin access required'},
            status=status.HTTP_403_FORBIDDEN,
        )

    # Log successful login
    AuditLog.log_action(
        admin=user,
        action='login',
        resource_type='auth',
        description=f"Admin {username} logged in",
        request=request
    )

    refresh = RefreshToken.for_user(user)
    return Response({
        'access': str(refresh.access_token),
        'refresh': str(refresh),
        'user': _admin_profile(user),
    })


@api_view(['POST'])
@permission_classes([AllowAny])
def admin_register(request):
    """Register a new admin account"""
    username = request.data.get('username', '').strip()
    email = request.data.get('email', '').strip()
    password = request.data.get('password', '')
    confirm_password = request.data.get('confirm_password', '')
    admin_code = request.data.get('admin_code', '').strip()

    required_code = os.getenv('ADMIN_REGISTRATION_CODE', 'STEP2WIN_ADMIN_2026')

    if not username or not email or not password or not confirm_password:
        return Response(
            {'error': 'Username, email, password and confirm_password are required'},
            status=status.HTTP_400_BAD_REQUEST,
        )

    if admin_code != required_code:
        return Response(
            {'error': 'Invalid admin registration code'},
            status=status.HTTP_403_FORBIDDEN,
        )

    # Only allow registration if no admin accounts exist (first admin only)
    if User.objects.filter(is_staff=True).exists():
        return Response(
            {'error': 'Admin registration is closed. Contact an existing admin to grant you access.'},
            status=status.HTTP_403_FORBIDDEN,
        )

    if password != confirm_password:
        return Response(
            {'error': 'Passwords do not match'},
            status=status.HTTP_400_BAD_REQUEST,
        )

    if User.objects.filter(username=username).exists():
        return Response(
            {'error': 'Username already taken'},
            status=status.HTTP_400_BAD_REQUEST,
        )

    if User.objects.filter(email=email).exists():
        return Response(
            {'error': 'Email already registered'},
            status=status.HTTP_400_BAD_REQUEST,
        )

    try:
        validate_password(password)
    except Exception as error:
        message = str(error)
        return Response({'error': message}, status=status.HTTP_400_BAD_REQUEST)

    user = User.objects.create_user(
        username=username,
        email=email,
        password=password,
        is_staff=True,
    )

    refresh = RefreshToken.for_user(user)
    return Response({
        'access': str(refresh.access_token),
        'refresh': str(refresh),
        'user': _admin_profile(user),
    }, status=status.HTTP_201_CREATED)


class IsAdminUser(permissions.BasePermission):
    """Custom permission to check if user is admin"""
    def has_permission(self, request, view):
        return request.user and request.user.is_staff


class AdminUserViewSet(viewsets.ModelViewSet):
    """
    Admin user management endpoint
    """
    queryset = User.objects.all()
    serializer_class = AdminUserSerializer
    permission_classes = [permissions.IsAuthenticated, IsAdminUser]
    search_fields = ['username', 'email']
    filterset_fields = ['is_active', 'is_staff']

    @action(detail=True, methods=['post'])
    def ban_user(self, request, pk=None):
        """Ban a specific user"""
        user = self.get_object()
        user.is_active = False
        user.save()
        return Response({'status': f'User {user.username} has been banned'})

    @action(detail=True, methods=['post'])
    def unban_user(self, request, pk=None):
        """Unban a specific user"""
        user = self.get_object()
        user.is_active = True
        user.save()
        return Response({'status': f'User {user.username} has been unbanned'})

    @action(detail=True, methods=['post'])
    def make_staff(self, request, pk=None):
        """Promote user to staff"""
        user = self.get_object()
        user.is_staff = True
        user.save()
        return Response({'status': f'User {user.username} is now staff'})

    @action(detail=True, methods=['post'])
    def remove_staff(self, request, pk=None):
        """Remove staff status from user"""
        user = self.get_object()
        user.is_staff = False
        user.save()
        return Response({'status': f'User {user.username} is no longer staff'})

    @action(detail=True, methods=['post'])
    def reset_password(self, request, pk=None):
        """Reset user password"""
        user = self.get_object()
        new_password = request.data.get('new_password', '')
        
        if not new_password:
            return Response(
                {'error': 'new_password is required'},
                status=status.HTTP_400_BAD_REQUEST
            )
        
        try:
            validate_password(new_password, user)
            user.set_password(new_password)
            user.save()
            return Response({'status': f'Password reset successful for {user.username}'})
        except Exception as e:
            return Response({'error': str(e)}, status=status.HTTP_400_BAD_REQUEST)

    @action(detail=True, methods=['patch'])
    def update_user(self, request, pk=None):
        """Update user details"""
        user = self.get_object()
        
        # Update allowed fields
        username = request.data.get('username')
        email = request.data.get('email')
        phone_number = request.data.get('phone_number')
        
        if username and username != user.username:
            if User.objects.filter(username=username).exists():
                return Response(
                    {'error': 'Username already exists'},
                    status=status.HTTP_400_BAD_REQUEST
                )
            user.username = username
        
        if email and email != user.email:
            if User.objects.filter(email=email).exists():
                return Response(
                    {'error': 'Email already exists'},
                    status=status.HTTP_400_BAD_REQUEST
                )
            user.email = email
        
        if phone_number is not None:
            user.phone_number = phone_number
        
        user.save()
        serializer = AdminUserSerializer(user)
        return Response(serializer.data)

    @action(detail=True, methods=['delete'])
    def delete_user(self, request, pk=None):
        """Delete user (hard delete)"""
        user = self.get_object()
        
        # Prevent deleting self
        if user.id == request.user.id:
            return Response(
                {'error': 'Cannot delete your own account'},
                status=status.HTTP_400_BAD_REQUEST
            )
        
        # Prevent deleting last admin
        if user.is_staff and User.objects.filter(is_staff=True).count() <= 1:
            return Response(
                {'error': 'Cannot delete the last admin account'},
                status=status.HTTP_400_BAD_REQUEST
            )
        
        username = user.username
        user.delete()
        return Response({'status': f'User {username} has been permanently deleted'})

    @action(detail=False, methods=['get'])
    def user_stats(self, request):
        """Get overall user statistics"""
        total_users = User.objects.count()
        active_users = User.objects.filter(is_active=True).count()
        banned_users = User.objects.filter(is_active=False).count()
        staff_users = User.objects.filter(is_staff=True).count()

        new_users_24h = User.objects.filter(
            created_at__gte=timezone.now() - timedelta(hours=24)
        ).count()

        return Response({
            'total_users': total_users,
            'active_users': active_users,
            'banned_users': banned_users,
            'staff_users': staff_users,
            'new_users_24h': new_users_24h,
        })

    @action(detail=False, methods=['get'])
    def top_earners(self, request):
        """Get top earning users"""
        limit = int(request.query_params.get('limit', 10))
        top_users = User.objects.order_by('-total_earned')[:limit]
        serializer = AdminUserSerializer(top_users, many=True)
        return Response(serializer.data)

    @action(detail=False, methods=['get'])
    def top_xp_users(self, request):
        """Get top XP users"""
        limit = int(request.query_params.get('limit', 10))
        top_xp = UserXP.objects.order_by('-total_xp')[:limit]
        users = [xp.user for xp in top_xp]
        serializer = AdminUserSerializer(users, many=True)
        return Response(serializer.data)


class AdminChallengeViewSet(viewsets.ModelViewSet):
    """
    Admin challenge management endpoint
    """
    queryset = Challenge.objects.all()
    serializer_class = AdminChallengeSerializer
    permission_classes = [permissions.IsAuthenticated, IsAdminUser]
    filterset_fields = ['status', 'creator']

    @action(detail=True, methods=['post'])
    def approve_challenge(self, request, pk=None):
        """Approve a pending challenge"""
        challenge = self.get_object()
        if challenge.status != 'pending':
            return Response(
                {'error': 'Challenge is not pending'},
                status=status.HTTP_400_BAD_REQUEST
            )
        challenge.status = 'active'
        challenge.save()
        return Response({'status': 'Challenge approved'})

    @action(detail=True, methods=['post'])
    def reject_challenge(self, request, pk=None):
        """Reject a pending challenge"""
        challenge = self.get_object()
        reason = request.data.get('reason', 'No reason provided')
        challenge.status = 'cancelled'
        challenge.save()
        return Response({'status': f'Challenge rejected (cancelled). Reason: {reason}'})

    @action(detail=True, methods=['post'])
    def cancel_challenge(self, request, pk=None):
        """Cancel an active challenge"""
        challenge = self.get_object()
        if challenge.status not in ['pending', 'active']:
            return Response(
                {'error': 'Can only cancel pending or active challenges'},
                status=status.HTTP_400_BAD_REQUEST
            )
        challenge.status = 'cancelled'
        challenge.save()
        return Response({'status': 'Challenge cancelled'})

    @action(detail=True, methods=['patch'])
    def update_challenge(self, request, pk=None):
        """Update challenge details"""
        challenge = self.get_object()
        
        # Update allowed fields
        name = request.data.get('name')
        milestone = request.data.get('milestone')
        max_participants = request.data.get('max_participants')
        end_date = request.data.get('end_date')
        
        if name:
            challenge.name = name
        
        if milestone is not None:
            challenge.milestone = int(milestone)
        
        if max_participants is not None:
            challenge.max_participants = int(max_participants)
        
        if end_date:
            challenge.end_date = end_date
        
        challenge.save()
        serializer = AdminChallengeSerializer(challenge)
        return Response(serializer.data)

    @action(detail=True, methods=['delete'])
    def delete_challenge(self, request, pk=None):
        """Delete challenge (hard delete)"""
        challenge = self.get_object()
        
        # Only allow deletion of cancelled or completed challenges
        if challenge.status in ['pending', 'active']:
            return Response(
                {'error': 'Cannot delete pending or active challenges. Cancel them first.'},
                status=status.HTTP_400_BAD_REQUEST
            )
        
        challenge_name = challenge.name
        challenge.delete()
        return Response({'status': f'Challenge {challenge_name} has been permanently deleted'})

    @action(detail=False, methods=['post'])
    def bulk_cancel(self, request):
        """Bulk cancel challenges"""
        challenge_ids = request.data.get('challenge_ids', [])
        
        if not challenge_ids:
            return Response(
                {'error': 'challenge_ids is required'},
                status=status.HTTP_400_BAD_REQUEST
            )
        
        challenges = Challenge.objects.filter(id__in=challenge_ids, status__in=['pending', 'active'])
        count = challenges.update(status='cancelled')
        
        return Response({'status': f'{count} challenge(s) cancelled'})

    @action(detail=False, methods=['post'])
    def bulk_delete(self, request):
        """Bulk delete challenges"""
        challenge_ids = request.data.get('challenge_ids', [])
        
        if not challenge_ids:
            return Response(
                {'error': 'challenge_ids is required'},
                status=status.HTTP_400_BAD_REQUEST
            )
        
        # Only delete cancelled or completed challenges
        challenges = Challenge.objects.filter(id__in=challenge_ids, status__in=['cancelled', 'completed'])
        count = challenges.count()
        challenges.delete()
        
        return Response({'status': f'{count} challenge(s) deleted'})

    @action(detail=False, methods=['get'])
    def challenge_stats(self, request):
        """Get challenge statistics"""
        total_challenges = Challenge.objects.count()
        live_challenges = Challenge.objects.filter(status='active').count()
        completed_challenges = Challenge.objects.filter(status='completed').count()
        total_entries = Participant.objects.count()
        total_prize_pool = Challenge.objects.aggregate(Sum('total_pool'))['total_pool__sum'] or Decimal('0.00')

        return Response({
            'total_challenges': total_challenges,
            'live_challenges': live_challenges,
            'completed_challenges': completed_challenges,
            'total_entries': total_entries,
            'total_prize_pool': str(total_prize_pool),
        })

    @action(detail=True, methods=['get'])
    def results(self, request, pk=None):
        """Get challenge results and leaderboard"""
        challenge = self.get_object()
        results = Participant.objects.filter(challenge=challenge).order_by('-steps', 'joined_at')
        
        data = {
            'challenge': AdminChallengeSerializer(challenge).data,
            'results': [{
                'position': index + 1,
                'user': r.user.username,
                'steps': r.steps,
                'qualified': r.qualified,
                'payout': str(r.payout),
                'joined_at': r.joined_at,
            } for index, r in enumerate(results)]
        }
        return Response(data)


class AdminTransactionViewSet(viewsets.ReadOnlyModelViewSet):
    """
    Admin transaction history endpoint
    """
    queryset = WalletTransaction.objects.all()
    serializer_class = AdminTransactionSerializer
    permission_classes = [permissions.IsAuthenticated, IsAdminUser]
    filterset_fields = ['user', 'type']

    @action(detail=False, methods=['get'])
    def transaction_stats(self, request):
        """Get transaction statistics"""
        transactions = WalletTransaction.objects.all()
        
        deposits = transactions.filter(type='deposit').aggregate(Sum('amount'))['amount__sum'] or Decimal('0.00')
        withdrawals = transactions.filter(type='withdrawal').aggregate(Sum('amount'))['amount__sum'] or Decimal('0.00')
        total_volume = deposits + withdrawals

        return Response({
            'total_volume': str(total_volume),
            'deposits': str(deposits),
            'withdrawals': str(withdrawals),
            'total_transactions': transactions.count(),
        })

    @action(detail=False, methods=['get'])
    def daily_volume(self, request):
        """Get daily transaction volume for last 30 days"""
        days = int(request.query_params.get('days', 30))
        
        daily_data = []
        for i in range(days):
            date = (timezone.now() - timedelta(days=i)).date()
            volume = WalletTransaction.objects.filter(
                created_at__date=date,
                type__in=['deposit', 'withdrawal']
            ).aggregate(Sum('amount'))['amount__sum'] or Decimal('0.00')
            
            daily_data.append({
                'date': date.isoformat(),
                'volume': str(volume),
            })

        return Response(daily_data)


class AdminWithdrawalViewSet(viewsets.ModelViewSet):
    """
    Admin withdrawal management endpoint
    """
    queryset = Withdrawal.objects.all()
    serializer_class = AdminWithdrawalSerializer
    permission_classes = [permissions.IsAuthenticated, IsAdminUser]
    filterset_fields = ['user', 'status']

    @action(detail=True, methods=['post'])
    def approve_withdrawal(self, request, pk=None):
        """Approve a withdrawal request"""
        withdrawal = self.get_object()
        if withdrawal.status != 'pending':
            return Response(
                {'error': 'Withdrawal is not pending'},
                status=status.HTTP_400_BAD_REQUEST
            )
        withdrawal.status = 'approved'
        withdrawal.processed_at = timezone.now()
        withdrawal.processed_by = request.user
        withdrawal.save()
        return Response({'status': 'Withdrawal approved'})

    @action(detail=True, methods=['post'])
    def reject_withdrawal(self, request, pk=None):
        """Reject a withdrawal request"""
        withdrawal = self.get_object()
        reason = request.data.get('reason', 'No reason provided')
        withdrawal.status = 'rejected'
        withdrawal.processed_at = timezone.now()
        withdrawal.processed_by = request.user
        withdrawal.rejection_reason = reason
        withdrawal.save()
        return Response({'status': f'Withdrawal rejected. Reason: {reason}'})

    @action(detail=False, methods=['get'])
    def withdrawal_stats(self, request):
        """Get withdrawal statistics"""
        withdrawals = Withdrawal.objects.all()
        
        total_pending = withdrawals.filter(status='pending').aggregate(Sum('amount'))['amount__sum'] or Decimal('0.00')
        total_approved = withdrawals.filter(status='approved').aggregate(Sum('amount'))['amount__sum'] or Decimal('0.00')
        total_rejected = withdrawals.filter(status='rejected').aggregate(Sum('amount'))['amount__sum'] or Decimal('0.00')

        return Response({
            'pending_count': withdrawals.filter(status='pending').count(),
            'pending_amount': str(total_pending),
            'approved_count': withdrawals.filter(status='approved').count(),
            'approved_amount': str(total_approved),
            'rejected_count': withdrawals.filter(status='rejected').count(),
            'rejected_amount': str(total_rejected),
            'total_withdrawals': withdrawals.count(),
        })


class AdminBadgeViewSet(viewsets.ModelViewSet):
    """
    Admin badge management endpoint
    """
    queryset = Badge.objects.all()
    serializer_class = AdminBadgeSerializer
    permission_classes = [permissions.IsAuthenticated, IsAdminUser]

    @action(detail=True, methods=['post'])
    def award_to_user(self, request, pk=None):
        """Award badge to a user"""
        badge = self.get_object()
        user_id = request.data.get('user_id')
        
        if not user_id:
            return Response(
                {'error': 'user_id is required'},
                status=status.HTTP_400_BAD_REQUEST
            )

        try:
            user = User.objects.get(id=user_id)
            user_badge, created = UserBadge.objects.get_or_create(
                user=user,
                badge=badge
            )
            return Response({
                'status': 'Badge awarded',
                'user': user.username,
                'badge': badge.name,
                'created': created,
            })
        except User.DoesNotExist:
            return Response(
                {'error': 'User not found'},
                status=status.HTTP_404_NOT_FOUND
            )

    @action(detail=False, methods=['get'])
    def badge_stats(self, request):
        """Get badge statistics"""
        badges = Badge.objects.all()
        
        stats = []
        for badge in badges:
            user_count = UserBadge.objects.filter(badge=badge).count()
            stats.append({
                'badge': badge.name,
                'icon': badge.icon,
                'users_earned': user_count,
            })

        return Response(stats)


class AdminDashboardViewSet(viewsets.ViewSet):
    """
    Main dashboard statistics endpoint
    """
    permission_classes = [permissions.IsAuthenticated, IsAdminUser]

    @action(detail=False, methods=['get'])
    def overview(self, request):
        """Get complete dashboard overview"""
        now = timezone.now()
        week_ago = now - timedelta(days=7)
        month_ago = now - timedelta(days=30)

        # User metrics
        total_users = User.objects.count()
        active_users_week = HealthRecord.objects.filter(
            date__gte=week_ago.date()
        ).values('user').distinct().count()
        
        new_users_week = User.objects.filter(
            created_at__gte=week_ago
        ).count()

        # Financial metrics
        week_deposits = WalletTransaction.objects.filter(
            type='deposit',
            created_at__gte=week_ago
        ).aggregate(Sum('amount'))['amount__sum'] or Decimal('0.00')
        
        week_withdrawals = WalletTransaction.objects.filter(
            type='withdrawal',
            created_at__gte=week_ago
        ).aggregate(Sum('amount'))['amount__sum'] or Decimal('0.00')

        pending_withdrawals = Withdrawal.objects.filter(
            status='pending'
        ).aggregate(Sum('amount'))['amount__sum'] or Decimal('0.00')

        # Challenge metrics
        live_challenges = Challenge.objects.filter(status='active').count()
        completed_challenges = Challenge.objects.filter(
            status='completed',
            end_date__gte=month_ago.date()
        ).count()

        # XP metrics
        total_xp_distributed = XPEvent.objects.filter(
            created_at__gte=week_ago
        ).aggregate(Sum('amount'))['amount__sum'] or 0

        return Response({
            'users': {
                'total': total_users,
                'active_week': active_users_week,
                'new_week': new_users_week,
            },
            'finance': {
                'week_deposits': str(week_deposits),
                'week_withdrawals': str(week_withdrawals),
                'pending_withdrawals': str(pending_withdrawals),
            },
            'challenges': {
                'live': live_challenges,
                'completed_month': completed_challenges,
            },
            'gamification': {
                'xp_distributed_week': total_xp_distributed,
            },
            'timestamp': now.isoformat(),
        })

    @action(detail=False, methods=['get'])
    def revenue_chart(self, request):
        """Get revenue data for chart"""
        days = int(request.query_params.get('days', 30))
        
        chart_data = []
        for i in range(days):
            date = (timezone.now() - timedelta(days=i)).date()
            
            deposits = WalletTransaction.objects.filter(
                type='deposit',
                created_at__date=date
            ).aggregate(Sum('amount'))['amount__sum'] or Decimal('0.00')
            
            withdrawals = WalletTransaction.objects.filter(
                type='withdrawal',
                created_at__date=date
            ).aggregate(Sum('amount'))['amount__sum'] or Decimal('0.00')
            
            revenue = (deposits - withdrawals) * Decimal('0.05')  # 5% commission
            
            chart_data.append({
                'date': date.isoformat(),
                'deposits': str(deposits),
                'withdrawals': str(withdrawals),
                'revenue': str(revenue),
            })

        return Response(chart_data)


@api_view(['GET'])
@permission_classes([permissions.IsAuthenticated, IsAdminUser])
def get_system_settings(request):
    """Get current system settings"""
    from apps.admin_api.models import SystemSettings
    from apps.admin_api.serializers import SystemSettingsSerializer
    
    settings = SystemSettings.load()
    serializer = SystemSettingsSerializer(settings)
    return Response(serializer.data)


@api_view(['POST'])
@permission_classes([permissions.IsAuthenticated, IsAdminUser])
def update_system_settings(request):
    """Update system settings"""
    from apps.admin_api.models import SystemSettings, AuditLog
    from apps.admin_api.serializers import SystemSettingsSerializer
    
    settings = SystemSettings.load()
    serializer = SystemSettingsSerializer(data=request.data, partial=True)
    
    if not serializer.is_valid():
        return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)
    
    # Capture changes for audit log
    changes = {}
    for key, value in serializer.validated_data.items():
        old_value = getattr(settings, key, None)
        if old_value != value:
            changes[key] = {
                'old': str(old_value) if old_value is not None else None,
                'new': str(value) if value is not None else None,
            }
    
    # Update settings
    for key, value in serializer.validated_data.items():
        setattr(settings, key, value)
    
    settings.updated_by = request.user
    settings.save()
    
    # Log the action
    AuditLog.log_action(
        admin=request.user,
        action='settings_change',
        resource_type='settings',
        description=f"Updated system settings: {', '.join(changes.keys())}",
        changes=changes,
        request=request
    )
    
    return Response(SystemSettingsSerializer(settings).data)


@api_view(['GET'])
@permission_classes([permissions.IsAuthenticated, IsAdminUser])
def get_audit_logs(request):
    """Get audit logs with filtering"""
    from apps.admin_api.models import AuditLog
    from apps.admin_api.serializers import AuditLogSerializer
    
    logs = AuditLog.objects.all()
    
    # Apply filters
    action = request.query_params.get('action')
    if action:
        logs = logs.filter(action=action)
    
    resource_type = request.query_params.get('resource_type')
    if resource_type:
        logs = logs.filter(resource_type=resource_type)
    
    admin_username = request.query_params.get('admin_username')
    if admin_username:
        logs = logs.filter(admin_username__icontains=admin_username)
    
    # Date filtering
    from_date = request.query_params.get('from_date')
    if from_date:
        logs = logs.filter(created_at__gte=from_date)
    
    to_date = request.query_params.get('to_date')
    if to_date:
        logs = logs.filter(created_at__lte=to_date)
    
    # Pagination
    limit = int(request.query_params.get('limit', 100))
    offset = int(request.query_params.get('offset', 0))
    
    total = logs.count()
    logs = logs[offset:offset + limit]
    
    serializer = AuditLogSerializer(logs, many=True)
    
    return Response({
        'total': total,
        'results': serializer.data,
    })


@api_view(['GET'])
@permission_classes([permissions.IsAuthenticated, IsAdminUser])
def get_support_tickets(request):
    """Get support tickets with filtering and pagination"""
    from apps.admin_api.models import SupportTicket

    tickets = SupportTicket.objects.select_related('user', 'assigned_to').all()

    status_filter = request.query_params.get('status')
    if status_filter:
        tickets = tickets.filter(status=status_filter)

    priority_filter = request.query_params.get('priority')
    if priority_filter:
        tickets = tickets.filter(priority=priority_filter)

    assigned_to = request.query_params.get('assigned_to')
    if assigned_to:
        if assigned_to == 'unassigned':
            tickets = tickets.filter(assigned_to__isnull=True)
        else:
            tickets = tickets.filter(assigned_to_id=assigned_to)

    query = request.query_params.get('q', '').strip()
    if query:
        from django.db.models import Q
        tickets = tickets.filter(
            Q(subject__icontains=query) |
            Q(message__icontains=query) |
            Q(user__username__icontains=query) |
            Q(user__email__icontains=query)
        )

    try:
        limit = max(1, min(100, int(request.query_params.get('limit', 20))))
        offset = max(0, int(request.query_params.get('offset', 0)))
    except ValueError:
        return Response({'error': 'Invalid pagination parameters'}, status=status.HTTP_400_BAD_REQUEST)

    total = tickets.count()
    paged = tickets[offset:offset + limit]
    serializer = SupportTicketSerializer(paged, many=True)

    return Response({
        'total': total,
        'results': serializer.data,
    })


@api_view(['GET'])
@permission_classes([permissions.IsAuthenticated, IsAdminUser])
def get_support_ticket_detail(request, ticket_id):
    """Get a support ticket and its conversation thread"""
    from apps.admin_api.models import SupportTicket

    try:
        ticket = SupportTicket.objects.select_related('user', 'assigned_to').get(id=ticket_id)
    except SupportTicket.DoesNotExist:
        return Response({'error': 'Support ticket not found'}, status=status.HTTP_404_NOT_FOUND)

    messages = ticket.messages.select_related('sender').all()

    return Response({
        'ticket': SupportTicketSerializer(ticket).data,
        'messages': SupportTicketMessageSerializer(messages, many=True).data,
    })


@api_view(['POST'])
@permission_classes([permissions.IsAuthenticated, IsAdminUser])
def reply_support_ticket(request, ticket_id):
    """Post an admin reply to a support ticket"""
    from apps.admin_api.models import SupportTicket, SupportTicketMessage, AuditLog
    from apps.admin_api.realtime import broadcast_support_message, broadcast_support_ticket

    try:
        ticket = SupportTicket.objects.get(id=ticket_id)
    except SupportTicket.DoesNotExist:
        return Response({'error': 'Support ticket not found'}, status=status.HTTP_404_NOT_FOUND)

    message_text = request.data.get('message', '').strip()
    if not message_text:
        return Response({'error': 'message is required'}, status=status.HTTP_400_BAD_REQUEST)

    reply = SupportTicketMessage.objects.create(
        ticket=ticket,
        sender=request.user,
        sender_username=request.user.username,
        is_admin=True,
        message=message_text,
    )

    changed_fields = []
    if ticket.status == 'open':
        ticket.status = 'in_progress'
        changed_fields.append('status')

    if ticket.assigned_to_id is None:
        ticket.assigned_to = request.user
        changed_fields.append('assigned_to')

    if changed_fields:
        ticket.save(update_fields=changed_fields + ['updated_at'])

    ticket.refresh_from_db()

    AuditLog.log_action(
        admin=request.user,
        action='update',
        resource_type='support',
        resource_id=ticket.id,
        resource_name=ticket.subject,
        description=f"Replied to support ticket #{ticket.id}",
        request=request,
    )

    broadcast_support_message(
        ticket.id,
        {
            'id': reply.id,
            'ticket': ticket.id,
            'sender': request.user.id,
            'sender_username': request.user.username,
            'is_admin': True,
            'message': reply.message,
            'created_at': reply.created_at.isoformat(),
        },
    )
    broadcast_support_ticket(
        ticket.id,
        {
            'id': ticket.id,
            'status': ticket.status,
            'priority': ticket.priority,
            'assigned_to': ticket.assigned_to_id,
            'updated_at': ticket.updated_at.isoformat(),
        },
    )

    return Response({
        'message': 'Reply sent successfully',
        'reply': SupportTicketMessageSerializer(reply).data,
    })


@api_view(['POST'])
@permission_classes([permissions.IsAuthenticated, IsAdminUser])
def update_support_ticket(request, ticket_id):
    """Update support ticket status, priority, assignment, and admin notes"""
    from apps.admin_api.models import SupportTicket, AuditLog
    from apps.admin_api.realtime import broadcast_support_ticket

    try:
        ticket = SupportTicket.objects.get(id=ticket_id)
    except SupportTicket.DoesNotExist:
        return Response({'error': 'Support ticket not found'}, status=status.HTTP_404_NOT_FOUND)

    updates = {}

    if 'status' in request.data:
        new_status = request.data.get('status')
        valid_statuses = {choice[0] for choice in SupportTicket.STATUS_CHOICES}
        if new_status not in valid_statuses:
            return Response({'error': 'Invalid status'}, status=status.HTTP_400_BAD_REQUEST)
        updates['status'] = new_status

    if 'priority' in request.data:
        new_priority = request.data.get('priority')
        valid_priorities = {choice[0] for choice in SupportTicket.PRIORITY_CHOICES}
        if new_priority not in valid_priorities:
            return Response({'error': 'Invalid priority'}, status=status.HTTP_400_BAD_REQUEST)
        updates['priority'] = new_priority

    if 'assigned_to' in request.data:
        assigned_to = request.data.get('assigned_to')
        if assigned_to in [None, '', 'null']:
            updates['assigned_to'] = None
        else:
            try:
                admin_user = User.objects.get(id=int(assigned_to), is_staff=True)
            except (ValueError, User.DoesNotExist):
                return Response({'error': 'Invalid admin assignee'}, status=status.HTTP_400_BAD_REQUEST)
            updates['assigned_to'] = admin_user

    if 'admin_notes' in request.data:
        updates['admin_notes'] = str(request.data.get('admin_notes') or '').strip()

    if not updates:
        return Response({'error': 'No valid fields to update'}, status=status.HTTP_400_BAD_REQUEST)

    previous = {
        'status': ticket.status,
        'priority': ticket.priority,
        'assigned_to': ticket.assigned_to.username if ticket.assigned_to else None,
        'admin_notes': ticket.admin_notes,
    }

    for field, value in updates.items():
        setattr(ticket, field, value)

    if updates.get('status') in ['resolved', 'closed']:
        ticket.resolved_at = timezone.now()
    elif updates.get('status') in ['open', 'in_progress']:
        ticket.resolved_at = None

    ticket.save()

    current = {
        'status': ticket.status,
        'priority': ticket.priority,
        'assigned_to': ticket.assigned_to.username if ticket.assigned_to else None,
        'admin_notes': ticket.admin_notes,
    }

    changed = {}
    for key in current:
        if previous[key] != current[key]:
            changed[key] = {'old': previous[key], 'new': current[key]}

    AuditLog.log_action(
        admin=request.user,
        action='update',
        resource_type='support',
        resource_id=ticket.id,
        resource_name=ticket.subject,
        description=f"Updated support ticket #{ticket.id}",
        changes=changed,
        request=request,
    )

    broadcast_support_ticket(
        ticket.id,
        {
            'id': ticket.id,
            'status': ticket.status,
            'priority': ticket.priority,
            'assigned_to': ticket.assigned_to_id,
            'admin_notes': ticket.admin_notes,
            'updated_at': ticket.updated_at.isoformat(),
        },
    )

    return Response({
        'message': 'Ticket updated successfully',
        'ticket': SupportTicketSerializer(ticket).data,
    })


@api_view(['GET'])
@permission_classes([permissions.IsAuthenticated, IsAdminUser])
def get_support_admins(request):
    """Get staff users eligible for support ticket assignment"""
    admins = User.objects.filter(is_staff=True, is_active=True).order_by('username').values('id', 'username', 'email')
    return Response({'results': list(admins)})


@api_view(['GET'])
@permission_classes([permissions.IsAuthenticated])
def get_revenue_report(request):
    """Get revenue breakdown by category and time period"""
    if not request.user.is_staff:
        return Response({'error': 'Unauthorized'}, status=status.HTTP_403_FORBIDDEN)
    
    from datetime import datetime, timedelta
    from django.db.models import Sum, Count, Q
    
    # Get time period (default: 30 days)
    period_days = int(request.query_params.get('days', 30))
    start_date = timezone.now() - timedelta(days=period_days)
    
    # Revenue from deposits (entry_fee transactions)
    deposits = WalletTransaction.objects.filter(
        type='entry_fee',
        created_at__gte=start_date
    ).aggregate(
        total=Sum('amount'),
        count=Count('id')
    )
    
    # Payouts (payout transactions)
    payouts = WalletTransaction.objects.filter(
        type='payout',
        created_at__gte=start_date
    ).aggregate(
        total=Sum('amount'),
        count=Count('id')
    )
    
    # Withdrawals processed
    withdrawals_data = Withdrawal.objects.filter(
        status='completed',
        processed_at__gte=start_date
    ).aggregate(
        total=Sum('amount'),
        count=Count('id')
    )
    
    # Platform fees collected
    from apps.admin_api.models import SystemSettings
    settings = SystemSettings.load()
    fee_percentage = settings.platform_fee_percentage
    
    total_deposits = deposits['total'] or Decimal('0')
    platform_fees = total_deposits * (fee_percentage / Decimal('100'))
    
    # Revenue by day for chart
    daily_revenue = []
    for i in range(period_days):
        day = start_date + timedelta(days=i)
        day_end = day + timedelta(days=1)
        
        day_deposits = WalletTransaction.objects.filter(
            type='entry_fee',
            created_at__gte=day,
            created_at__lt=day_end
        ).aggregate(total=Sum('amount'))['total'] or Decimal('0')
        
        day_fees = day_deposits * (fee_percentage / Decimal('100'))
        
        daily_revenue.append({
            'date': day.strftime('%Y-%m-%d'),
            'revenue': float(day_fees),
            'deposits': float(day_deposits),
        })
    
    return Response({
        'summary': {
            'total_deposits': float(total_deposits),
            'total_payouts': float(payouts['total'] or 0),
            'total_withdrawals': float(withdrawals_data['total'] or 0),
            'platform_fees': float(platform_fees),
            'net_revenue': float(platform_fees - (withdrawals_data['total'] or Decimal('0'))),
            'deposit_count': deposits['count'],
            'payout_count': payouts['count'],
            'withdrawal_count': withdrawals_data['count'],
        },
        'daily_data': daily_revenue,
    })


@api_view(['GET'])
@permission_classes([permissions.IsAuthenticated])
def get_user_retention(request):
    """Get user retention metrics and cohort analysis"""
    if not request.user.is_staff:
        return Response({'error': 'Unauthorized'}, status=status.HTTP_403_FORBIDDEN)
    
    from datetime import datetime, timedelta
    from django.db.models import Count, Q
    
    # Get time period (default: 90 days)
    period_days = int(request.query_params.get('days', 90))
    start_date = timezone.now() - timedelta(days=period_days)
    
    # New users by week
    weekly_signups = []
    weeks = period_days // 7
    
    for i in range(weeks):
        week_start = start_date + timedelta(weeks=i)
        week_end = week_start + timedelta(weeks=1)
        
        new_users = User.objects.filter(
            date_joined__gte=week_start,
            date_joined__lt=week_end
        ).count()
        
        # Active users in that cohort (users who have transactions/challenges after signup)
        active_users = User.objects.filter(
            date_joined__gte=week_start,
            date_joined__lt=week_end
        ).filter(
            Q(transactions__created_at__gte=week_end) | 
            Q(created_challenges__created_at__gte=week_end)
        ).distinct().count()
        
        retention_rate = (active_users / new_users * 100) if new_users > 0 else 0
        
        weekly_signups.append({
            'week_start': week_start.strftime('%Y-%m-%d'),
            'new_users': new_users,
            'active_users': active_users,
            'retention_rate': round(retention_rate, 2),
        })
    
    # Overall stats
    total_users = User.objects.filter(date_joined__gte=start_date).count()
    active_users = User.objects.filter(
        date_joined__gte=start_date,
        is_active=True
    ).filter(
        Q(transactions__created_at__gte=start_date) |
        Q(created_challenges__created_at__gte=start_date)
    ).distinct().count()
    
    return Response({
        'summary': {
            'total_users': total_users,
            'active_users': active_users,
            'overall_retention': round((active_users / total_users * 100) if total_users > 0 else 0, 2),
        },
        'weekly_data': weekly_signups,
    })


@api_view(['GET'])
@permission_classes([permissions.IsAuthenticated])
def get_challenge_analytics(request):
    """Get challenge success rates and analytics"""
    if not request.user.is_staff:
        return Response({'error': 'Unauthorized'}, status=status.HTTP_403_FORBIDDEN)
    
    from datetime import timedelta
    from django.db.models import Count, Avg, Sum
    
    # Get time period (default: 30 days)
    period_days = int(request.query_params.get('days', 30))
    start_date = timezone.now() - timedelta(days=period_days)
    
    challenges = Challenge.objects.filter(created_at__gte=start_date)
    
    # Status breakdown
    status_breakdown = challenges.values('status').annotate(count=Count('id'))
    status_dict = {item['status']: item['count'] for item in status_breakdown}
    
    # Success metrics
    completed_challenges = challenges.filter(status='completed').count()
    cancelled_challenges = challenges.filter(status='cancelled').count()
    total_challenges = challenges.count()
    
    completion_rate = (completed_challenges / total_challenges * 100) if total_challenges > 0 else 0
    
    # Average participants (count participants per challenge)
    challenges_with_count = challenges.annotate(participant_count=Count('participants'))
    avg_participants = challenges_with_count.aggregate(avg=Avg('participant_count'))['avg'] or 0
    
    # Total prize pool
    total_pool = challenges.aggregate(total=Sum('total_pool'))['total'] or Decimal('0')
    
    # Challenge creation trend (daily)
    daily_challenges = []
    for i in range(period_days):
        day = start_date + timedelta(days=i)
        day_end = day + timedelta(days=1)
        
        count = Challenge.objects.filter(
            created_at__gte=day,
            created_at__lt=day_end
        ).count()
        
        daily_challenges.append({
            'date': day.strftime('%Y-%m-%d'),
            'count': count,
        })
    
    # Participant engagement
    total_participants = Participant.objects.filter(
        challenge__created_at__gte=start_date
    ).count()
    
    # Winners
    winners_count = Participant.objects.filter(
        challenge__created_at__gte=start_date,
        payout__gt=0
    ).count()
    
    return Response({
        'summary': {
            'total_challenges': total_challenges,
            'completed': completed_challenges,
            'cancelled': cancelled_challenges,
            'active': status_dict.get('active', 0),
            'pending': status_dict.get('pending', 0),
            'completion_rate': round(completion_rate, 2),
            'avg_participants': round(avg_participants, 2),
            'total_prize_pool': float(total_pool),
            'total_participants': total_participants,
            'winners_count': winners_count,
        },
        'daily_data': daily_challenges,
        'status_breakdown': status_dict,
    })


@api_view(['GET'])
@permission_classes([permissions.IsAuthenticated])
def get_transaction_trends(request):
    """Get transaction volume trends over time"""
    if not request.user.is_staff:
        return Response({'error': 'Unauthorized'}, status=status.HTTP_403_FORBIDDEN)
    
    from datetime import timedelta
    from django.db.models import Sum, Count
    
    # Get time period (default: 30 days)
    period_days = int(request.query_params.get('days', 30))
    start_date = timezone.now() - timedelta(days=period_days)
    
    # Daily transaction data
    daily_data = []
    for i in range(period_days):
        day = start_date + timedelta(days=i)
        day_end = day + timedelta(days=1)
        
        day_txs = WalletTransaction.objects.filter(
            created_at__gte=day,
            created_at__lt=day_end
        )
        
        deposits = day_txs.filter(type='entry_fee').aggregate(
            total=Sum('amount'),
            count=Count('id')
        )
        
        payouts = day_txs.filter(type='payout').aggregate(
            total=Sum('amount'),
            count=Count('id')
        )
        
        daily_data.append({
            'date': day.strftime('%Y-%m-%d'),
            'deposit_amount': float(deposits['total'] or 0),
            'deposit_count': deposits['count'],
            'payout_amount': float(payouts['total'] or 0),
            'payout_count': payouts['count'],
            'total_volume': float((deposits['total'] or 0) + (payouts['total'] or 0)),
        })
    
    # Summary stats
    period_transactions = WalletTransaction.objects.filter(created_at__gte=start_date)
    
    total_volume = period_transactions.aggregate(total=Sum('amount'))['total'] or Decimal('0')
    total_count = period_transactions.count()
    
    deposits_total = period_transactions.filter(type='entry_fee').aggregate(
        total=Sum('amount')
    )['total'] or Decimal('0')
    
    payouts_total = period_transactions.filter(type='payout').aggregate(
        total=Sum('amount')
    )['total'] or Decimal('0')
    
    return Response({
        'summary': {
            'total_volume': float(total_volume),
            'total_transactions': total_count,
            'total_deposits': float(deposits_total),
            'total_payouts': float(payouts_total),
            'avg_transaction_value': float(total_volume / total_count) if total_count > 0 else 0,
        },
        'daily_data': daily_data,
    })


@api_view(['GET'])
@permission_classes([permissions.IsAuthenticated, IsAdminUser])
def fraud_overview(request):
    from apps.steps.models import FraudFlag, TrustScore

    today = timezone.now().date()
    return Response({
        'open_flags': FraudFlag.objects.filter(reviewed=False).count(),
        'critical_unread': FraudFlag.objects.filter(reviewed=False, severity='critical').count(),
        'high_unread': FraudFlag.objects.filter(reviewed=False, severity='high').count(),
        'restricted_users': TrustScore.objects.filter(score__lte=40, score__gt=20).count(),
        'suspended_users': TrustScore.objects.filter(score__lte=20, score__gt=0).count(),
        'banned_users': TrustScore.objects.filter(score=0).count(),
        'flags_today': FraudFlag.objects.filter(created_at__date=today).count(),
        'recent_flags': list(
            FraudFlag.objects.filter(reviewed=False)
            .select_related('user')
            .values(
                'id',
                'user__username',
                'user__email',
                'flag_type',
                'severity',
                'date',
                'details',
            )
            .order_by('-created_at')[:50]
        ),
    })


@api_view(['POST'])
@permission_classes([permissions.IsAuthenticated, IsAdminUser])
def action_flag(request, flag_id):
    from apps.steps.models import FraudFlag, TrustScore

    action = request.data.get('action')
    flag = get_object_or_404(FraudFlag, id=flag_id)
    flag.reviewed = True
    flag.actioned = action != 'dismiss'
    flag.save(update_fields=['reviewed', 'actioned'])

    trust, _ = TrustScore.objects.get_or_create(user=flag.user)

    if action == 'dismiss':
        trust.recover(10)
    elif action == 'warn':
        trust.deduct(5)
    elif action == 'restrict':
        trust.score = 35
        trust.save(update_fields=['score', 'updated_at'])
    elif action == 'suspend':
        trust.score = 10
        trust.save(update_fields=['score', 'updated_at'])
    elif action == 'ban':
        trust.score = 0
        trust.save(update_fields=['score', 'updated_at'])

    return Response({'status': f'Flag {action}ed'})


# ── Payment Management (PochPay) ──────────────────────────────────────────────

@api_view(['GET'])
@permission_classes([permissions.IsAuthenticated, IsAdminUser])
def payments_overview(request):
    """Admin dashboard financial overview."""
    from apps.payments.models import PaymentTransaction
    from apps.payments import pochipay
    from datetime import timedelta

    today      = timezone.now().date()
    last_7_days = today - timedelta(days=7)

    completed_deposits = PaymentTransaction.objects.filter(
        type='deposit', status='completed', created_at__date__gte=last_7_days
    )
    completed_payouts = PaymentTransaction.objects.filter(
        type='payout', status='completed', created_at__date__gte=last_7_days
    )
    pending_txns = PaymentTransaction.objects.filter(status='pending')

    # Get live platform balance from PochPay
    try:
        platform_balance = pochipay.get_platform_balance()
    except Exception:
        platform_balance = {'balance': 'Error fetching', 'currency': 'KES'}

    return Response({
        'platform_balance':    platform_balance,
        'deposits_7d_total':   completed_deposits.aggregate(t=Sum('amount_kes'))['t'] or 0,
        'deposits_7d_count':   completed_deposits.count(),
        'payouts_7d_total':    completed_payouts.aggregate(t=Sum('amount_kes'))['t'] or 0,
        'payouts_7d_count':    completed_payouts.count(),
        'pending_count':       pending_txns.count(),
        'pending_total':       pending_txns.aggregate(t=Sum('amount_kes'))['t'] or 0,
        'failed_today':        PaymentTransaction.objects.filter(
                                   status='failed', created_at__date=today
                               ).count(),
    })


@api_view(['POST'])
@permission_classes([permissions.IsAuthenticated, IsAdminUser])
def retry_payout(request, txn_id):
    """Admin retries a failed/pending payout using the narrationId from PochPay."""
    from apps.payments.models import PaymentTransaction
    from apps.payments import pochipay

    txn = get_object_or_404(PaymentTransaction, id=txn_id, type='payout')

    if txn.status == 'completed':
        return Response({'error': 'Transaction already completed'}, status=400)

    # Get narrationId from PochPay first
    status_data = pochipay.get_disbursement_status(txn.tracking_reference)
    narration_id = status_data.get('result', {}).get('narrationId')

    if not narration_id:
        return Response({'error': 'No narrationId available for retry'}, status=400)

    result = pochipay.retry_pending_disbursement(narration_id)
    return Response({'status': 'Retry initiated', 'result': result})


@api_view(['GET'])
@permission_classes([permissions.IsAuthenticated, IsAdminUser])
def withdrawal_queue(request):
    """
    Returns all pending withdrawals for admin review.
    Sorted oldest-first so admins process in order.
    """
    status_filter = request.query_params.get('status', 'pending_review')

    withdrawals = WithdrawalRequest.objects.filter(
        status=status_filter
    ).select_related('user').order_by('created_at')

    return Response([
        {
            'id': str(w.id),
            'user_id': w.user.id,
            'username': w.user.username,
            'email': w.user.email,
            'phone': w.user.phone_number,
            'amount_kes': str(w.amount_kes),
            'method': w.method,
            'destination': w.destination_display,
            'status': w.status,
            'created_at': w.created_at.isoformat(),
            'age_hours': round((timezone.now() - w.created_at).total_seconds() / 3600, 1),
        }
        for w in withdrawals
    ])


@api_view(['GET'])
@permission_classes([permissions.IsAuthenticated, IsAdminUser])
def withdrawal_stats(request):
    """Stats for the admin withdrawal dashboard."""
    from django.db.models import Sum

    today = timezone.now().date()

    return Response({
        'pending_count': WithdrawalRequest.objects.filter(status='pending_review').count(),
        'pending_total_kes': str(
            WithdrawalRequest.objects.filter(status='pending_review')
            .aggregate(t=Sum('amount_kes'))['t'] or 0
        ),
        'approved_today': WithdrawalRequest.objects.filter(
            status__in=['approved', 'processing', 'completed'],
            reviewed_at__date=today,
        ).count(),
        'completed_today': WithdrawalRequest.objects.filter(
            status='completed',
            callback_received_at__date=today,
        ).count(),
        'failed_today': WithdrawalRequest.objects.filter(
            status='failed',
            updated_at__date=today,
        ).count(),
        'total_paid_today': str(
            WithdrawalRequest.objects.filter(
                status='completed',
                callback_received_at__date=today,
            ).aggregate(t=Sum('amount_kes'))['t'] or 0
        ),
    })


@api_view(['POST'])
@permission_classes([permissions.IsAuthenticated, IsAdminUser])
def approve_withdrawal(request, withdrawal_id):
    """
    Admin approves a withdrawal. This immediately sends it to PochPay.
    """
    withdrawal = get_object_or_404(WithdrawalRequest, id=withdrawal_id)

    if withdrawal.status != 'pending_review':
        return Response(
            {'error': f'Cannot approve — status is: {withdrawal.status}'},
            status=400
        )

    tracking_ref = pochipay.generate_tracking_reference('WDR')
    request_id = f"WDR-{withdrawal.id}-{uuid.uuid4().hex[:6].upper()}"

    withdrawal.tracking_reference = tracking_ref
    withdrawal.request_id = request_id
    withdrawal.status = 'approved'
    withdrawal.reviewed_by = request.user
    withdrawal.reviewed_at = timezone.now()
    withdrawal.save(update_fields=[
        'tracking_reference', 'request_id', 'status',
        'reviewed_by', 'reviewed_at', 'updated_at'
    ])

    try:
        if withdrawal.method == 'mpesa':
            pochipay.send_withdrawal_to_mobile(
                tracking_reference=tracking_ref,
                request_id=request_id,
                phone_number=withdrawal.phone_number,
                amount=float(withdrawal.amount_kes),
                remarks=f'Step2Win withdrawal for {withdrawal.user.username}',
            )

        elif withdrawal.method == 'bank':
            pochipay.send_withdrawal_to_bank(
                tracking_reference=tracking_ref,
                request_id=request_id,
                bank_code=withdrawal.bank_code,
                account_number=withdrawal.account_number,
                amount=float(withdrawal.amount_kes),
                remarks=f'Step2Win bank withdrawal for {withdrawal.user.username}',
            )

        elif withdrawal.method == 'paybill':
            pochipay.send_withdrawal_to_paybill(
                tracking_reference=tracking_ref,
                request_id=request_id,
                short_code=withdrawal.short_code,
                account_number=withdrawal.account_number or None,
                is_paybill=withdrawal.is_paybill,
                amount=float(withdrawal.amount_kes),
                remarks='Step2Win paybill withdrawal',
            )

        withdrawal.status = 'processing'
        withdrawal.save(update_fields=['status', 'updated_at'])

        _notify_user(withdrawal.user, 'withdrawal_approved',
                     amount=withdrawal.amount_kes, method=withdrawal.method)

        logger.info(
            f'Withdrawal approved and sent | id={withdrawal_id} | '
            f'admin={request.user.username} | KES {withdrawal.amount_kes}'
        )
        return Response({
            'message': 'Withdrawal approved and sent to PochPay.',
            'tracking_reference': tracking_ref,
            'status': 'processing',
        })

    except Exception as e:
        logger.error(f'PochPay call failed after approval | id={withdrawal_id}: {e}')

        with db_transaction.atomic():
            locked_user = withdrawal.user.__class__.objects.select_for_update().get(id=withdrawal.user.id)
            locked_user.wallet_balance = locked_user.wallet_balance + withdrawal.amount_kes
            locked_user.save(update_fields=['wallet_balance', 'updated_at'])

            withdrawal.status = 'failed'
            withdrawal.fail_reason = f'PochPay error: {str(e)}'
            withdrawal.save(update_fields=['status', 'fail_reason', 'updated_at'])

        return Response({'error': 'Disbursement failed. Balance refunded to user.'}, status=502)


@api_view(['POST'])
@permission_classes([permissions.IsAuthenticated, IsAdminUser])
def reject_withdrawal(request, withdrawal_id):
    """
    Admin rejects a withdrawal request.
    Balance is immediately refunded to the user.
    """
    withdrawal = get_object_or_404(WithdrawalRequest, id=withdrawal_id)
    reason = request.data.get('reason', 'Rejected by admin')

    if withdrawal.status != 'pending_review':
        return Response(
            {'error': f'Cannot reject — status is: {withdrawal.status}'},
            status=400
        )

    with db_transaction.atomic():
        locked_user = withdrawal.user.__class__.objects.select_for_update().get(id=withdrawal.user.id)
        locked_user.wallet_balance = locked_user.wallet_balance + withdrawal.amount_kes
        locked_user.save(update_fields=['wallet_balance', 'updated_at'])

        withdrawal.status = 'rejected'
        withdrawal.rejection_reason = reason
        withdrawal.reviewed_by = request.user
        withdrawal.reviewed_at = timezone.now()
        withdrawal.save(update_fields=[
            'status', 'rejection_reason', 'reviewed_by', 'reviewed_at', 'updated_at'
        ])

    _notify_user(withdrawal.user, 'withdrawal_rejected',
                 amount=withdrawal.amount_kes, reason=reason)

    logger.info(
        f'Withdrawal rejected | id={withdrawal_id} | '
        f'admin={request.user.username} | reason={reason}'
    )
    return Response({'message': f'Withdrawal rejected. KES {withdrawal.amount_kes} refunded.'})


@api_view(['POST'])
@permission_classes([permissions.IsAuthenticated, IsAdminUser])
def retry_failed_withdrawal(request, withdrawal_id):
    """
    Admin retries a failed withdrawal using PochPay narrationId.
    First fetches the current status from PochPay to get narrationId.
    """
    withdrawal = get_object_or_404(WithdrawalRequest, id=withdrawal_id)

    if not withdrawal.tracking_reference:
        return Response({'error': 'No tracking reference — cannot retry'}, status=400)

    try:
        status_data = pochipay.get_disbursement_status(withdrawal.tracking_reference)
        narration_id = status_data.get('result', {}).get('narrationId')

        if not narration_id:
            return Response(
                {'error': 'narrationId not available — transaction may not be retryable'},
                status=400
            )

        result = pochipay.retry_pending_disbursement(narration_id)

        withdrawal.status = 'processing'
        withdrawal.save(update_fields=['status', 'updated_at'])

        return Response({'message': 'Retry initiated', 'result': result})

    except Exception as e:
        logger.error(f'Withdrawal retry failed | id={withdrawal_id}: {e}')
        return Response({'error': str(e)}, status=502)
