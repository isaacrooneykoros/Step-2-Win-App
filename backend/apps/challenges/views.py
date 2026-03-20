from rest_framework import generics, status
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated, IsAdminUser
from rest_framework.response import Response
from rest_framework import serializers
from drf_spectacular.utils import extend_schema, inline_serializer
from django.db import transaction, models
from django.db.models import Count, Q, F
from datetime import date, timedelta
from decimal import Decimal
from .models import Challenge, Participant
from .services import finalize_expired_challenges
from .serializers import (
    ChallengeSerializer,
    ChallengeDetailSerializer,
    ParticipantSerializer,
    CreateChallengeSerializer,
    JoinChallengeSerializer,
    ChallengeMessageSerializer,
    LobbyCardSerializer,
    SpectatorLeaderboardSerializer
)


class ChallengeListView(generics.ListAPIView):
    """
    List all available challenges
    """
    serializer_class = ChallengeSerializer
    permission_classes = [IsAuthenticated]
    
    def get_queryset(self):
        finalize_expired_challenges()
        queryset = Challenge.objects.annotate(
            participant_count=Count('participants')
        )
        
        # Filter by status
        status_filter = self.request.query_params.get('status')
        if status_filter:
            queryset = queryset.filter(status=status_filter)
        else:
            # Default: show active and pending challenges
            queryset = queryset.filter(status__in=['pending', 'active'])
        
        # Filter by milestone
        milestone_filter = self.request.query_params.get('milestone')
        if milestone_filter:
            queryset = queryset.filter(milestone=milestone_filter)
        
        # Filter by visibility and participant status
        show_full = self.request.query_params.get('show_full') == 'true'
        
        # Public challenges: show to all users
        # Private challenges: only show if user is a participant
        # Full challenges: hide unless show_full=true OR challenge is public
        
        if not show_full:
            # Exclude full non-public challenges
            queryset = queryset.exclude(
                Q(participant_count__gte=models.F('max_participants')) & 
                Q(is_private=True)
            )
        
        # Exclude private challenges unless user is a participant
        queryset = queryset.exclude(
            Q(is_private=True) & ~Q(participants__user=self.request.user)
        )
        
        return queryset.order_by('-created_at')


@extend_schema(
    request=CreateChallengeSerializer,
    responses={201: ChallengeDetailSerializer, 400: inline_serializer(name='CreateChallengeBadRequest', fields={'error': serializers.CharField(required=False), 'errors': serializers.DictField(required=False)})},
)
@api_view(['POST'])
@permission_classes([IsAuthenticated])
def create_challenge(request):
    """
    Create a new challenge and automatically join as creator
    """
    import logging
    logger = logging.getLogger(__name__)
    
    logger.info(f"Create challenge request data: {request.data}")
    
    serializer = CreateChallengeSerializer(data=request.data)
    if not serializer.is_valid():
        logger.error(f"Validation errors: {serializer.errors}")
        return Response(
            {'errors': serializer.errors},
            status=status.HTTP_400_BAD_REQUEST
        )
    
    entry_fee = serializer.validated_data['entry_fee']
    
    # Check if user has enough balance
    if request.user.wallet_balance < entry_fee:
        logger.warning(f"Insufficient balance: {request.user.wallet_balance} < {entry_fee}")
        return Response(
            {'error': 'Insufficient balance to create challenge'},
            status=status.HTTP_400_BAD_REQUEST
        )
    
    with transaction.atomic():
        # Create challenge
        challenge = serializer.save(creator=request.user)
        
        # Deduct entry fee and lock it
        user = request.user.__class__.objects.select_for_update().get(id=request.user.id)
        user.wallet_balance -= entry_fee
        user.locked_balance += entry_fee
        user.save()
        
        # Add creator as first participant
        Participant.objects.create(
            challenge=challenge,
            user=user
        )
        
        # Update pool
        challenge.total_pool = entry_fee
        challenge.save()
        
        # Create wallet transaction
        from apps.wallet.models import WalletTransaction
        WalletTransaction.objects.create(
            user=user,
            type='challenge_entry',
            amount=-entry_fee,
            balance_before=user.wallet_balance + entry_fee,
            balance_after=user.wallet_balance,
            description=f'Created challenge: {challenge.name}',
            metadata={'challenge_id': challenge.id}
        )
        
        from .serializers import ChallengeDetailSerializer
        result_serializer = ChallengeDetailSerializer(challenge, context={'request': request})
        return Response(result_serializer.data, status=status.HTTP_201_CREATED)


@extend_schema(
    request=JoinChallengeSerializer,
    responses={
        200: inline_serializer(
            name='JoinChallengeResponse',
            fields={
                'status': serializers.CharField(),
                'challenge': ChallengeDetailSerializer(),
            },
        )
    },
)
@api_view(['POST'])
@permission_classes([IsAuthenticated])
def join_challenge(request):
    """
    Join a challenge using invite code
    """
    serializer = JoinChallengeSerializer(data=request.data)
    serializer.is_valid(raise_exception=True)
    
    invite_code = serializer.validated_data['invite_code']
    
    try:
        with transaction.atomic():
            challenge = Challenge.objects.select_for_update().get(
                invite_code=invite_code,
                status='active'
            )
            
            # Check if challenge is full
            if challenge.participants.count() >= challenge.max_participants:
                return Response(
                    {'error': 'Challenge is full'},
                    status=status.HTTP_400_BAD_REQUEST
                )
            
            # Check if already joined
            if Participant.objects.filter(challenge=challenge, user=request.user).exists():
                return Response(
                    {'error': 'Already joined this challenge'},
                    status=status.HTTP_400_BAD_REQUEST
                )
            
            # Check balance
            user = request.user.__class__.objects.select_for_update().get(id=request.user.id)
            if user.wallet_balance < challenge.entry_fee:
                return Response(
                    {'error': f'Insufficient balance. Required: ${challenge.entry_fee}'},
                    status=status.HTTP_400_BAD_REQUEST
                )
            
            # Deduct entry fee and lock it
            user.wallet_balance -= challenge.entry_fee
            user.locked_balance += challenge.entry_fee
            user.save()
            
            # Update pool
            challenge.total_pool += challenge.entry_fee
            challenge.save()
            
            # Add participant
            participant = Participant.objects.create(
                challenge=challenge,
                user=user
            )

            request.user.__class__.objects.filter(id=request.user.id).update(
                challenges_joined=F('challenges_joined') + 1
            )
            
            # Create wallet transaction
            from apps.wallet.models import WalletTransaction
            WalletTransaction.objects.create(
                user=user,
                type='challenge_entry',
                amount=-challenge.entry_fee,
                balance_before=user.wallet_balance + challenge.entry_fee,
                balance_after=user.wallet_balance,
                description=f'Joined challenge: {challenge.name}',
                metadata={'challenge_id': challenge.id}
            )
            
            # Sync user's steps for this challenge
            from apps.steps.models import HealthRecord
            from django.db.models import Sum
            total_steps = HealthRecord.objects.filter(
                user=user,
                date__gte=challenge.start_date,
                date__lte=challenge.end_date,
                is_suspicious=False
            ).aggregate(total=Sum('steps'))['total'] or 0
            
            participant.steps = total_steps
            participant.qualified = total_steps >= challenge.milestone
            participant.save()
            
            # Notify chat if private challenge
            if challenge.is_private:
                from .events import notify_new_participant
                notify_new_participant(challenge, user.username)
    
    except Challenge.DoesNotExist:
        return Response(
            {'error': 'Invalid invite code or challenge not active'},
            status=status.HTTP_404_NOT_FOUND
        )
    
    return Response({
        'status': 'Successfully joined challenge',
        'challenge': ChallengeDetailSerializer(challenge, context={'request': request}).data
    })


class MyChallengesView(generics.ListAPIView):
    """
    List challenges user is participating in
    """
    serializer_class = ChallengeDetailSerializer
    permission_classes = [IsAuthenticated]
    
    def get_queryset(self):
        finalize_expired_challenges()
        # Don't annotate current_participants as it's already a property on the model
        return Challenge.objects.filter(
            participants__user=self.request.user
        ).order_by('-created_at')


class ChallengeDetailView(generics.RetrieveAPIView):
    """
    Get detailed challenge information
    """
    serializer_class = ChallengeDetailSerializer
    permission_classes = [IsAuthenticated]
    # Don't annotate current_participants as it's already a property on the model
    queryset = Challenge.objects.all()

    def get_queryset(self):
        finalize_expired_challenges()
        return super().get_queryset()
    
    def get_serializer_context(self):
        context = super().get_serializer_context()
        context['request'] = self.request
        return context


@extend_schema(responses={200: ParticipantSerializer(many=True)})
@api_view(['GET'])
@permission_classes([IsAuthenticated])
def leaderboard(request, pk):
    """
    Get challenge leaderboard
    """
    try:
        challenge = Challenge.objects.get(pk=pk)
    except Challenge.DoesNotExist:
        return Response(
            {'error': 'Challenge not found'},
            status=status.HTTP_404_NOT_FOUND
        )
    
    # Check if user is a participant
    if not challenge.participants.filter(user=request.user).exists():
        return Response(
            {'error': 'You are not a participant in this challenge'},
            status=status.HTTP_403_FORBIDDEN
        )
    
    participants = challenge.participants.select_related('user').order_by('-steps', 'joined_at')
    
    # Add rank
    leaderboard_data = []
    for idx, participant in enumerate(participants, 1):
        data = ParticipantSerializer(participant).data
        data['rank'] = idx
        leaderboard_data.append(data)
    
    return Response(leaderboard_data)


@extend_schema(
    responses={
        200: inline_serializer(
            name='ChallengeStatsResponse',
            fields={
                'challenge_id': serializers.IntegerField(),
                'challenge_name': serializers.CharField(),
                'status': serializers.CharField(),
                'total_participants': serializers.IntegerField(),
                'qualified_count': serializers.IntegerField(),
                'qualification_rate': serializers.CharField(),
                'total_pool': serializers.CharField(),
                'platform_fee': serializers.CharField(),
                'net_pool': serializers.CharField(),
                'entry_fee': serializers.CharField(),
                'average_steps': serializers.IntegerField(),
                'top_performer': serializers.DictField(),
                'milestone': serializers.IntegerField(),
                'days_remaining': serializers.IntegerField(),
                'start_date': serializers.DateField(),
                'end_date': serializers.DateField(),
            },
        )
    }
)
@api_view(['GET'])
@permission_classes([IsAuthenticated])
def challenge_stats(request, pk):
    """
    Get comprehensive challenge statistics
    """
    try:
        challenge = Challenge.objects.get(pk=pk)
    except Challenge.DoesNotExist:
        return Response(
            {'error': 'Challenge not found'},
            status=status.HTTP_404_NOT_FOUND
        )
    
    participants = challenge.participants.all()
    qualified = participants.filter(qualified=True)
    
    # Calculate average steps
    avg_steps = participants.aggregate(models.Avg('steps'))['steps__avg'] or 0
    
    # Get top performer
    top_performer = participants.order_by('-steps').first()
    
    return Response({
        'challenge_id': challenge.id,
        'challenge_name': challenge.name,
        'status': challenge.status,
        'total_participants': participants.count(),
        'qualified_count': qualified.count(),
        'qualification_rate': f"{(qualified.count() / participants.count() * 100) if participants.count() > 0 else 0:.1f}%",
        'total_pool': str(challenge.total_pool),
        'platform_fee': str(challenge.platform_fee),
        'net_pool': str(challenge.net_pool),
        'entry_fee': str(challenge.entry_fee),
        'average_steps': int(avg_steps),
        'top_performer': {
            'username': top_performer.user.username if top_performer else None,
            'steps': top_performer.steps if top_performer else 0
        },
        'milestone': challenge.milestone,
        'days_remaining': challenge.days_remaining,
        'start_date': str(challenge.start_date),
        'end_date': str(challenge.end_date),
    })


@extend_schema(
    request=None,
    responses={
        200: inline_serializer(
            name='LeaveChallengeResponse',
            fields={'status': serializers.CharField()},
        )
    }
)
@api_view(['POST'])
@permission_classes([IsAuthenticated])
def leave_challenge(request, pk):
    """
    Leave a challenge (only before it becomes active or if it's still in the first day)
    """
    try:
        challenge = Challenge.objects.get(pk=pk)
        participant = Participant.objects.get(challenge=challenge, user=request.user)
    except (Challenge.DoesNotExist, Participant.DoesNotExist):
        return Response(
            {'error': 'Challenge or participation not found'},
            status=status.HTTP_404_NOT_FOUND
        )
    
    # Check if can leave
    from datetime import date
    if challenge.status == 'active' and date.today() > challenge.start_date:
        return Response(
            {'error': 'Cannot leave an active challenge after it has started'},
            status=status.HTTP_400_BAD_REQUEST
        )
    
    if challenge.status == 'completed':
        return Response(
            {'error': 'Cannot leave a completed challenge'},
            status=status.HTTP_400_BAD_REQUEST
        )
    
    with transaction.atomic():
        # Refund entry fee
        user = request.user.__class__.objects.select_for_update().get(id=request.user.id)
        user.wallet_balance += challenge.entry_fee
        user.locked_balance -= challenge.entry_fee
        user.save()
        
        # Update pool
        challenge.total_pool -= challenge.entry_fee
        challenge.save()
        
        # Remove participant
        participant.delete()
        
        # Notify chat if private challenge
        if challenge.is_private:
            from .events import notify_participant_left
            notify_participant_left(challenge, user.username)
        
        # Create refund transaction
        from apps.wallet.models import WalletTransaction
        WalletTransaction.objects.create(
            user=user,
            type='refund',
            amount=challenge.entry_fee,
            balance_before=user.wallet_balance - challenge.entry_fee,
            balance_after=user.wallet_balance,
            description=f'Left challenge: {challenge.name}',
            metadata={'challenge_id': challenge.id}
        )
    
    return Response({'status': 'Successfully left challenge'})


@extend_schema(
    request=None,
    responses={201: ChallengeDetailSerializer, 400: inline_serializer(name='RematchBadRequest', fields={'error': serializers.CharField()})},
)
@api_view(['POST'])
@permission_classes([IsAuthenticated])
def rematch_challenge(request, pk):
    """
    Create a rematch from an existing completed challenge.
    """
    try:
        source = Challenge.objects.get(pk=pk)
    except Challenge.DoesNotExist:
        return Response(
            {'error': 'Challenge not found'},
            status=status.HTTP_404_NOT_FOUND
        )

    if source.status != 'completed':
        return Response(
            {'error': 'Rematch is only available after challenge completion'},
            status=status.HTTP_400_BAD_REQUEST
        )

    if not source.participants.filter(user=request.user).exists():
        return Response(
            {'error': 'Only participants can start a rematch'},
            status=status.HTTP_403_FORBIDDEN
        )

    entry_fee = source.entry_fee
    if request.user.wallet_balance < entry_fee:
        return Response(
            {'error': 'Insufficient balance to start rematch'},
            status=status.HTTP_400_BAD_REQUEST
        )

    duration_days = max(1, (source.end_date - source.start_date).days)

    with transaction.atomic():
        user = request.user.__class__.objects.select_for_update().get(id=request.user.id)

        challenge = Challenge.objects.create(
            name=source.name,
            description=source.description,
            creator=user,
            milestone=source.milestone,
            entry_fee=source.entry_fee,
            max_participants=source.max_participants,
            status='active',
            start_date=date.today(),
            end_date=date.today() + timedelta(days=duration_days),
            is_public=source.is_public,
            is_private=source.is_private,
            win_condition=source.win_condition,
            theme_emoji=source.theme_emoji,
        )

        user.wallet_balance -= challenge.entry_fee
        user.locked_balance += challenge.entry_fee
        user.save()

        Participant.objects.create(
            challenge=challenge,
            user=user
        )

        challenge.total_pool = challenge.entry_fee
        challenge.save(update_fields=['total_pool'])

        from apps.wallet.models import WalletTransaction
        WalletTransaction.objects.create(
            user=user,
            type='challenge_entry',
            amount=-challenge.entry_fee,
            balance_before=user.wallet_balance + challenge.entry_fee,
            balance_after=user.wallet_balance,
            description=f'Rematch started: {challenge.name}',
            metadata={'challenge_id': challenge.id, 'rematch_of': source.id}
        )

    result_serializer = ChallengeDetailSerializer(challenge, context={'request': request})
    return Response({
        'status': 'Rematch created successfully',
        'challenge': result_serializer.data,
        'rematch_of': source.id,
    }, status=status.HTTP_201_CREATED)


@extend_schema(
    request=inline_serializer(name='ChallengeChatSendRequest', fields={'content': serializers.CharField()}),
    responses={200: inline_serializer(name='ChallengeChatResponse', fields={'messages': serializers.ListField(), 'count': serializers.IntegerField()}), 201: inline_serializer(name='ChallengeChatSentResponse', fields={'id': serializers.IntegerField(), 'sender': serializers.CharField(), 'content': serializers.CharField(), 'created_at': serializers.CharField()})},
)
@api_view(['GET', 'POST'])
@permission_classes([IsAuthenticated])
def challenge_chat(request, pk):
    """
    GET: Retrieve chat messages for a private challenge (last 100)
    POST: Send a new message to the challenge chat
    """
    try:
        challenge = Challenge.objects.get(pk=pk)
    except Challenge.DoesNotExist:
        return Response(
            {'error': 'Challenge not found'},
            status=status.HTTP_404_NOT_FOUND
        )
    
    if not challenge.is_private:
        return Response(
            {'error': 'Chat is only available for private challenges'},
            status=status.HTTP_400_BAD_REQUEST
        )
    
    # Check if user is a participant
    if not challenge.participants.filter(user=request.user).exists():
        return Response(
            {'error': 'Only participants can access the chat'},
            status=status.HTTP_403_FORBIDDEN
        )
    
    if request.method == 'GET':
        from .models import ChallengeMessage
        messages = (
            ChallengeMessage.objects
            .filter(challenge=challenge)
            .select_related('user')
            .order_by('-created_at')[:100]
        )
        
        # Transform to new format with initials and is_mine
        data = [
            {
                'id': m.id,
                'sender': m.user.username if m.user else 'Step2Win',
                'content': m.message,
                'is_system': m.is_system,
                'is_mine': m.user_id == request.user.id if m.user else False,
                'created_at': m.created_at.isoformat(),
                'initials': m.user.username[:2].upper() if m.user else '🏆',
            }
            for m in reversed(list(messages))
        ]
        
        return Response({'messages': data, 'count': len(data)})
    
    elif request.method == 'POST':
        from .models import ChallengeMessage
        content = request.data.get('content', '').strip()
        if not content:
            content = request.data.get('message', '').strip()  # Fallback for old format
        
        if not content:
            return Response(
                {'error': 'Message cannot be empty'},
                status=status.HTTP_400_BAD_REQUEST
            )
        
        if len(content) > 1000:
            return Response(
                {'error': 'Message too long (max 1000 chars)'},
                status=status.HTTP_400_BAD_REQUEST
            )
        
        message = ChallengeMessage.objects.create(
            challenge=challenge,
            user=request.user,
            message=content,
            is_system=False
        )
        
        # Broadcast via WebSocket if available
        try:
            from channels.layers import get_channel_layer
            from asgiref.sync import async_to_sync
            
            channel_layer = get_channel_layer()
            if channel_layer:
                async_to_sync(channel_layer.group_send)(
                    f'challenge_{challenge.id}_chat',
                    {
                        'type': 'chat_message',
                        'id': message.id,
                        'sender': request.user.username,
                        'initials': request.user.username[:2].upper(),
                        'content': content,
                        'created_at': message.created_at.isoformat(),
                        'is_system': False,
                    }
                )
        except Exception as e:
            import logging
            logging.getLogger(__name__).warning(f'WebSocket broadcast failed: {e}')
        
        return Response({
            'id': message.id,
            'sender': request.user.username,
            'content': content,
            'is_system': False,
            'is_mine': True,
            'created_at': message.created_at.isoformat(),
            'initials': request.user.username[:2].upper(),
        }, status=status.HTTP_201_CREATED)


@extend_schema(
    responses={200: inline_serializer(name='ChallengeSocialStatsResponse', fields={'most_consistent': serializers.DictField(allow_null=True), 'biggest_single_day': serializers.DictField(allow_null=True), 'most_improved': serializers.DictField(allow_null=True)})},
)
@api_view(['GET'])
@permission_classes([IsAuthenticated])
def challenge_social_stats(request, pk):
    """
    Get social achievement badges for a private challenge
    """
    try:
        challenge = Challenge.objects.get(pk=pk)
    except Challenge.DoesNotExist:
        return Response(
            {'error': 'Challenge not found'},
            status=status.HTTP_404_NOT_FOUND
        )
    
    if not challenge.is_private:
        return Response(
            {'error': 'Social stats are only available for private challenges'},
            status=status.HTTP_400_BAD_REQUEST
        )
    
    # Check if user is a participant
    if not challenge.participants.filter(user=request.user).exists():
        return Response(
            {'error': 'Only participants can view social stats'},
            status=status.HTTP_403_FORBIDDEN
        )
    
    from apps.steps.models import HealthRecord
    from django.db.models import Count, Max, Sum
    
    participants = challenge.participants.select_related('user').all()
    
    # Most consistent: most days with steps recorded
    most_consistent = None
    max_days = 0
    for p in participants:
        days_active = HealthRecord.objects.filter(
            user=p.user,
            date__gte=challenge.start_date,
            date__lte=challenge.end_date,
            steps__gt=0
        ).count()
        if days_active > max_days:
            max_days = days_active
            most_consistent = p
    
    # Biggest single day: highest steps in one day
    biggest_day_record = HealthRecord.objects.filter(
        user__in=[p.user for p in participants],
        date__gte=challenge.start_date,
        date__lte=challenge.end_date
    ).order_by('-steps').first()
    
    biggest_single_day = None
    biggest_day_steps = 0
    biggest_day_date = None
    if biggest_day_record:
        biggest_single_day = participants.filter(user=biggest_day_record.user).first()
        biggest_day_steps = biggest_day_record.steps
        biggest_day_date = biggest_day_record.date
    
    # Night walker: most steps after 9 PM (if we had hourly data)
    # For now, we'll skip this as we don't have hourly breakdown
    
    # Most improved: best percentage improvement (comparing early vs late period)
    most_improved = None
    best_improvement = 0
    duration = (challenge.end_date - challenge.start_date).days
    if duration >= 4:
        midpoint = challenge.start_date + timedelta(days=duration // 2)
        for p in participants:
            early_steps = HealthRecord.objects.filter(
                user=p.user,
                date__gte=challenge.start_date,
                date__lt=midpoint
            ).aggregate(total=Sum('steps'))['total'] or 0
            
            late_steps = HealthRecord.objects.filter(
                user=p.user,
                date__gte=midpoint,
                date__lte=challenge.end_date
            ).aggregate(total=Sum('steps'))['total'] or 0
            
            if early_steps > 0:
                improvement = ((late_steps - early_steps) / early_steps) * 100
                if improvement > best_improvement:
                    best_improvement = improvement
                    most_improved = p
    
    return Response({
        'most_consistent': {
            'username': most_consistent.user.username if most_consistent else None,
            'days_active': max_days
        } if most_consistent else None,
        'biggest_single_day': {
            'username': biggest_single_day.user.username if biggest_single_day else None,
            'steps': biggest_day_steps,
            'date': str(biggest_day_date) if biggest_day_date else None
        } if biggest_single_day else None,
        'most_improved': {
            'username': most_improved.user.username if most_improved else None,
            'improvement_percent': round(best_improvement, 1)
        } if most_improved else None,
    })


@extend_schema(
    operation_id='challenges_public_lobby',
    responses={
        200: inline_serializer(
            name='PublicLobbyResponse',
            fields={
                'challenges': LobbyCardSerializer(many=True),
                'total_count': serializers.IntegerField(),
                'filters': serializers.DictField(child=serializers.IntegerField()),
            },
        )
    }
)
@api_view(['GET'])
@permission_classes([IsAuthenticated])
def public_lobby(request):
    """
    Returns all public challenges available to join or watch.

    Query params:
      filter:    all (default) | joinable | active | ending_soon
      milestone: 50000 | 70000 | 90000
      min_fee:   minimum entry fee in KES
      max_fee:   maximum entry fee in KES
      sort:      featured (default) | pool | ending | newest | filling
    """
    from django.utils import timezone
    from datetime import timedelta

    qs = Challenge.objects.filter(
        is_public=True,
        is_private=False,
        status__in=['pending', 'active'],
    ).prefetch_related('participants')

    filter_param = request.query_params.get('filter', 'all')
    if filter_param == 'joinable':
        qs = qs.filter(status__in=['pending', 'active'])
    elif filter_param == 'active':
        qs = qs.filter(status='active')
    elif filter_param == 'ending_soon':
        soon = timezone.now().date() + timedelta(days=2)
        qs = qs.filter(status='active', end_date__lte=soon)

    milestone = request.query_params.get('milestone')
    if milestone:
        try:
            qs = qs.filter(milestone=int(milestone))
        except ValueError:
            pass

    min_fee = request.query_params.get('min_fee')
    max_fee = request.query_params.get('max_fee')
    if min_fee:
        qs = qs.filter(entry_fee__gte=min_fee)
    if max_fee:
        qs = qs.filter(entry_fee__lte=max_fee)

    sort = request.query_params.get('sort', 'featured')
    if sort == 'pool':
        qs = qs.order_by('-total_pool')
    elif sort == 'ending':
        qs = qs.order_by('end_date')
    elif sort == 'newest':
        qs = qs.order_by('-created_at')
    elif sort == 'filling':
        qs = qs.annotate(participant_count=Count('participants')).order_by('-participant_count', '-total_pool')
    else:
        qs = qs.order_by('-is_featured', '-is_platform_challenge', '-total_pool')

    Challenge.objects.filter(
        is_featured=True,
        featured_until__isnull=False,
        featured_until__lt=timezone.now()
    ).update(is_featured=False, featured_until=None)

    challenges = list(qs)
    serializer = LobbyCardSerializer(challenges, many=True, context={'request': request})

    base_qs = Challenge.objects.filter(is_public=True, is_private=False, status__in=['pending', 'active'])

    return Response({
        'challenges': serializer.data,
        'total_count': len(challenges),
        'filters': {
            'active': base_qs.filter(status='active').count(),
            'joinable': base_qs.filter(status='active').count(),
            'ending_soon': base_qs.filter(
                status='active',
                end_date__lte=timezone.now().date() + timedelta(days=2)
            ).count(),
        }
    })


@extend_schema(
    operation_id='challenges_lobby_card_detail',
    responses={
        200: LobbyCardSerializer,
        404: inline_serializer(name='LobbyCardNotFound', fields={'error': serializers.CharField()}),
    },
)
@api_view(['GET'])
@permission_classes([IsAuthenticated])
def challenge_lobby_card(request, pk):
    """
    Returns full detail for a single public challenge card.
    Also increments view_count for popularity tracking.
    """
    try:
        challenge = Challenge.objects.prefetch_related('participants__user').get(
            pk=pk, is_public=True, is_private=False
        )
    except Challenge.DoesNotExist:
        return Response({'error': 'Challenge not found'}, status=404)

    Challenge.objects.filter(pk=pk).update(view_count=F('view_count') + 1)

    serializer = LobbyCardSerializer(challenge, context={'request': request})
    return Response(serializer.data)


@extend_schema(
    responses={200: inline_serializer(name='SpectatorLeaderboardResponse', fields={'challenge': serializers.DictField(), 'leaderboard': serializers.ListField(), 'qualified_count': serializers.IntegerField(), 'total_participants': serializers.IntegerField(), 'user_is_participant': serializers.BooleanField()})}
)
@api_view(['GET'])
@permission_classes([IsAuthenticated])
def spectator_leaderboard(request, pk):
    """
    Public leaderboard for any public challenge.
    Viewable by users who are NOT participants — spectator mode.
    Ranked by steps descending.
    """
    try:
        challenge = Challenge.objects.get(pk=pk, is_public=True, is_private=False)
    except Challenge.DoesNotExist:
        return Response({'error': 'Challenge not found or not public'}, status=404)

    if challenge.status == 'pending':
        return Response({
            'message': 'Challenge has not started yet.',
            'starts_on': str(challenge.start_date),
            'participants': [],
            'total_pool': str(challenge.total_pool),
            'participant_count': challenge.participants.count(),
        })

    participants = list(
        challenge.participants
        .select_related('user')
        .order_by('-steps')
    )

    for i, participant in enumerate(participants):
        participant._rank = i + 1

    qualified = [participant for participant in participants if participant.steps >= challenge.milestone]

    serializer = SpectatorLeaderboardSerializer(participants, many=True)

    return Response({
        'challenge': {
            'id': challenge.id,
            'name': challenge.name,
            'milestone': challenge.milestone,
            'status': challenge.status,
            'end_date': str(challenge.end_date),
            'total_pool': str(challenge.total_pool),
            'entry_fee': str(challenge.entry_fee),
            'theme': challenge.theme,
        },
        'leaderboard': serializer.data,
        'qualified_count': len(qualified),
        'total_participants': len(participants),
        'user_is_participant': challenge.participants.filter(
            user=request.user
        ).exists(),
    })


@extend_schema(
    request=inline_serializer(name='FeatureChallengeRequest', fields={'hours': serializers.IntegerField(required=False)}),
    responses={200: inline_serializer(name='FeatureChallengeResponse', fields={'message': serializers.CharField(), 'featured_until': serializers.CharField()})},
)
@api_view(['POST'])
@permission_classes([IsAdminUser])
def feature_challenge(request, pk):
    """
    Admin marks a challenge as featured.
    Request body: { "hours": 24 }  — how long to feature it for
    """
    from django.utils import timezone
    from datetime import timedelta

    try:
        challenge = Challenge.objects.get(pk=pk)
    except Challenge.DoesNotExist:
        return Response({'error': 'Not found'}, status=404)

    hours = request.data.get('hours', 24)
    challenge.is_featured = True
    challenge.featured_until = timezone.now() + timedelta(hours=int(hours))
    challenge.save(update_fields=['is_featured', 'featured_until'])

    return Response({
        'message': f'Challenge featured for {hours} hours.',
        'featured_until': challenge.featured_until.isoformat(),
    })


@extend_schema(
    responses={200: inline_serializer(name='ChallengeResultsResponse', fields={'challenge': serializers.DictField(), 'results': serializers.ListField(), 'total_participants': serializers.IntegerField(), 'qualified_count': serializers.IntegerField()})}
)
@api_view(['GET'])
@permission_classes([IsAuthenticated])
def challenge_results(request, pk):
    """
    Returns full results for a completed challenge.
    Shows payouts, ranks, tie explanations, and tiebreaker details.
    Available to all participants + spectators of public challenges.
    """
    from .models import ChallengeResult
    from django.db import models

    try:
        challenge = Challenge.objects.get(pk=pk)
    except Challenge.DoesNotExist:
        return Response({'error': 'Challenge not found'}, status=404)

    if challenge.status != 'completed':
        return Response({'error': 'Challenge not yet completed'}, status=400)

    results = (
        ChallengeResult.objects.filter(challenge=challenge)
        .select_related('user', 'participant')
        .order_by('final_rank', '-final_steps')
    )

    net_pool = challenge.total_pool * Decimal('0.95')
    is_refund = results.filter(payout_method='refund').exists()

    # Find the viewing user's own result
    my_result = results.filter(user=request.user).first()

    def _serialize_result(r):
        if r is None:
            return None
        return {
            'username':          r.user.username,
            'final_steps':       r.final_steps,
            'final_rank':        r.final_rank,
            'qualified':         r.qualified,
            'payout_kes':        str(r.payout_kes),
            'payout_method':     r.payout_method,
            'tied_with_count':   r.tied_with_count,
            'tiebreaker_level':  r.tiebreaker_level,
            'tiebreaker_label':  r.tiebreaker_label,
            'gps_verified_pct':  round(r.gps_verified_pct, 1),
            'milestone_reached_at': (
                r.milestone_reached_at.isoformat()
                if r.milestone_reached_at else None
            ),
        }

    return Response({
        'challenge': {
            'id':               challenge.id,
            'name':             challenge.name,
            'payout_structure': challenge.payout_structure,
            'milestone':        challenge.milestone,
            'total_pool':       str(challenge.total_pool),
            'net_pool':         str(net_pool),
            'entry_fee':        str(challenge.entry_fee),
            'start_date':       str(challenge.start_date),
            'end_date':         str(challenge.end_date),
        },
        'summary': {
            'total_participants': results.count(),
            'qualified_count':    results.filter(qualified=True).count(),
            'is_refund':          is_refund,
            'total_paid_out':     str(results.aggregate(
                                      t=models.Sum('payout_kes')
                                  )['t'] or 0),
        },
        'my_result': _serialize_result(my_result),
        'leaderboard': [
            _serialize_result(r) for r in results
        ],
    })


@extend_schema(
    responses={200: inline_serializer(name='MyRecentResultsResponse', fields={'has_results': serializers.BooleanField(), 'challenge': serializers.DictField(required=False), 'my_result': serializers.DictField(required=False), 'leaderboard': serializers.ListField(required=False), 'message': serializers.CharField(required=False)})}
)
@api_view(['GET'])
@permission_classes([IsAuthenticated])
def my_recent_results(request):
    """
    Returns the user's most recent completed challenge result.
    Used by the "My Results" quick action on the home screen.
    Returns the single most recent result with full detail.
    """
    from .models import ChallengeResult

    result = (
        ChallengeResult.objects.filter(user=request.user)
        .select_related('challenge', 'participant')
        .order_by('-finalized_at')
        .first()
    )

    if not result:
        return Response({
            'has_results': False,
            'message': 'No completed challenges yet.',
        })

    all_results = (
        ChallengeResult.objects.filter(challenge=result.challenge)
        .select_related('user')
        .order_by('final_rank', '-final_steps')
    )

    net_pool = result.challenge.total_pool * Decimal('0.95')

    return Response({
        'has_results': True,
        'challenge': {
            'id': result.challenge.id,
            'name': result.challenge.name,
            'payout_structure': result.challenge.payout_structure,
            'milestone': result.challenge.milestone,
            'total_pool': str(result.challenge.total_pool),
            'net_pool': str(net_pool),
            'entry_fee': str(result.challenge.entry_fee),
            'end_date': str(result.challenge.end_date),
        },
        'my_result': {
            'final_steps': result.final_steps,
            'final_rank': result.final_rank,
            'qualified': result.qualified,
            'payout_kes': str(result.payout_kes),
            'payout_method': result.payout_method,
            'tied_with_count': result.tied_with_count,
            'tiebreaker_label': result.tiebreaker_label,
            'finalized_at': result.finalized_at.isoformat() if result.finalized_at else None,
        },
        'leaderboard': [
            {
                'username': r.user.username,
                'final_steps': r.final_steps,
                'final_rank': r.final_rank,
                'qualified': r.qualified,
                'payout_kes': str(r.payout_kes),
                'payout_method': r.payout_method,
                'tied_with_count': r.tied_with_count,
            }
            for r in all_results
        ],
        'summary': {
            'total_participants': all_results.count(),
            'qualified_count': all_results.filter(qualified=True).count(),
            'is_refund': all_results.filter(payout_method='refund').exists(),
        },
    })

