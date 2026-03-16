"""
Input Sanitization Utilities for Step2Win
─────────────────────────────────────────
All user-facing text input passes through these before being saved.
Prevents XSS, HTML injection, and display of injected markup.

Django's ORM already prevents SQL injection for database queries —
these sanitizers handle the text layer (displayed content).
"""

import bleach
import re
from django.core.exceptions import ValidationError


def sanitize_text(value: str, max_length: int = None) -> str:
    """
    Strips ALL HTML tags from plain text fields.
    Use for: usernames, challenge names, narrations, descriptions.
    """
    if not value:
        return value

    cleaned = bleach.clean(str(value), tags=[], attributes={}, strip=True)
    cleaned = re.sub(r'\s+', ' ', cleaned).strip()

    if max_length and len(cleaned) > max_length:
        raise ValidationError(f'Value exceeds maximum length of {max_length} characters.')

    return cleaned


def sanitize_chat_message(value: str) -> str:
    """
    Sanitizes group chat messages.
    Strips HTML but preserves emoji and unicode characters.
    Max 1000 characters as per business rules.
    """
    if not value:
        raise ValidationError('Message cannot be empty.')

    cleaned = bleach.clean(str(value), tags=[], attributes={}, strip=True).strip()

    if len(cleaned) == 0:
        raise ValidationError('Message cannot be empty.')

    if len(cleaned) > 1000:
        raise ValidationError('Message cannot exceed 1000 characters.')

    return cleaned


def sanitize_phone_number(value: str) -> str:
    """
    Validates and normalizes Kenyan phone numbers.
    Accepts: 0712345678, +254712345678, 254712345678
    Returns: 254712345678 format
    """
    if not value:
        raise ValidationError('Phone number is required.')

    digits = re.sub(r'\D', '', str(value))

    if digits.startswith('0') and len(digits) == 10:
        digits = '254' + digits[1:]
    elif digits.startswith('254') and len(digits) == 12:
        pass
    elif digits.startswith('7') and len(digits) == 9:
        digits = '254' + digits
    else:
        raise ValidationError(
            'Invalid phone number. Use format: 0712345678 or +254712345678'
        )

    if not re.match(r'^254[71]\d{8}$', digits):
        raise ValidationError('Invalid Kenyan phone number.')

    return digits


def sanitize_amount(value, min_amount=None, max_amount=None) -> float:
    """
    Validates a monetary amount.
    Rejects negative values, non-numeric strings, and over-precise decimals.
    """
    try:
        amount = float(value)
    except (TypeError, ValueError):
        raise ValidationError('Amount must be a valid number.')

    if amount <= 0:
        raise ValidationError('Amount must be greater than zero.')

    if min_amount is not None and amount < min_amount:
        raise ValidationError(f'Minimum amount is KSh {min_amount}.')

    if max_amount is not None and amount > max_amount:
        raise ValidationError(f'Maximum amount is KSh {max_amount}.')

    if round(amount, 2) != amount:
        raise ValidationError('Amount cannot have more than 2 decimal places.')

    return round(amount, 2)


def sanitize_username(value: str) -> str:
    """
    Validates a username.
    Only allows letters, numbers, underscores, and hyphens.
    """
    if not value:
        raise ValidationError('Username is required.')

    cleaned = str(value).strip()

    if len(cleaned) < 3:
        raise ValidationError('Username must be at least 3 characters.')

    if len(cleaned) > 30:
        raise ValidationError('Username cannot exceed 30 characters.')

    if not re.match(r'^[a-zA-Z0-9_-]+$', cleaned):
        raise ValidationError(
            'Username can only contain letters, numbers, underscores, and hyphens.'
        )

    return cleaned
