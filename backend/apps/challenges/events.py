"""
Helper functions for automated event messages in private challenges
"""
from channels.layers import get_channel_layer
from asgiref.sync import async_to_sync
import logging

logger = logging.getLogger(__name__)


def send_challenge_event(challenge, event_type, message, metadata=None):
    """
    Send an automated event message to a private challenge chat
    
    Args:
        challenge: Challenge instance
        event_type: Event type identifier (e.g. 'milestone_reached', 'elimination')
        message: Human-readable message text
        metadata: Optional dict with additional event data
    """
    if not challenge.is_private:
        return
    
    from .models import ChallengeMessage
    from .serializers import ChallengeMessageSerializer
    
    # Create system message
    msg = ChallengeMessage.objects.create(
        challenge=challenge,
        user=None,
        message=message,
        is_system=True,
        event_type=event_type
    )
    
    # Broadcast via WebSocket
    try:
        channel_layer = get_channel_layer()
        if channel_layer:
            async_to_sync(channel_layer.group_send)(
                f'challenge_{challenge.id}',
                {
                    'type': 'chat_message',
                    'message': ChallengeMessageSerializer(msg).data
                }
            )
    except Exception as e:
        logger.warning(f'WebSocket broadcast failed for challenge {challenge.id}: {e}')
    
    logger.info(f'Challenge {challenge.id} event: {event_type} - {message}')


def notify_milestone_reached(participant):
    """
    Notify when a participant reaches a milestone (e.g., 50% progress, 100% qualified)
    """
    challenge = participant.challenge
    progress = participant.progress_percentage
    
    if progress >= 100 and participant.qualified:
        message = f"🏃 {participant.user.username} just qualified with {participant.steps:,} steps!"
        send_challenge_event(challenge, 'qualification', message)
    elif progress >= 50 and progress < 60:
        message = f"💪 {participant.user.username} is halfway there!"
        send_challenge_event(challenge, 'milestone_50', message)


def notify_big_day(participant, steps, date):
    """
    Notify when a participant has an exceptional single day
    """
    if steps >= 20000:
        message = f"🔥 {participant.user.username} crushed {steps:,} steps on {date}!"
        send_challenge_event(participant.challenge, 'big_day', message)


def notify_challenge_ending_soon(challenge, hours_remaining):
    """
    Notify participants that the challenge is ending soon
    """
    if hours_remaining == 24:
        message = "⏰ Challenge ends in 24 hours — time to step it up!"
        send_challenge_event(challenge, 'ending_soon', message)
    elif hours_remaining == 1:
        message = "🏁 Final hour! Give it your all!"
        send_challenge_event(challenge, 'final_hour', message)


def notify_new_participant(challenge, username):
    """
    Notify when a new participant joins
    """
    message = f"👋 {username} just joined the challenge!"
    send_challenge_event(challenge, 'new_participant', message)


def notify_participant_left(challenge, username):
    """
    Notify when a participant leaves
    """
    message = f"👋 {username} has left the challenge"
    send_challenge_event(challenge, 'participant_left', message)
