import sys

filepath = 'backend/apps/challenges/views.py'
with open(filepath, 'r') as f:
    content = f.read()

old_block = """    elif request.method == 'POST':
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
        )"""

new_block = """    elif request.method == 'POST':
        from .models import ChallengeMessage
        raw_content = request.data.get('content', '').strip() or request.data.get('message', '').strip()
        try:
            content = sanitize_chat_message(raw_content)
        except DjangoValidationError as e:
            return Response({'error': e.message if hasattr(e, 'message') else str(e)}, status=status.HTTP_400_BAD_REQUEST)

        message = ChallengeMessage.objects.create(
            challenge=challenge,
            user=request.user,
            message=content,
            is_system=False
        )"""

if old_block in content:
    content = content.replace(old_block, new_block)
    with open(filepath, 'w') as f:
        f.write(content)
else:
    print("Block not found!")
    sys.exit(1)
