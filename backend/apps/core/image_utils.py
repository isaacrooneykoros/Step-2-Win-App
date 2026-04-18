from __future__ import annotations

import os
from io import BytesIO

from django.core.files.uploadedfile import SimpleUploadedFile
from PIL import Image, UnidentifiedImageError
from rest_framework import serializers


def _register_heif_support() -> None:
    try:
        from pillow_heif import register_heif_opener

        register_heif_opener()
    except Exception:
        # HEIC/HEIF support remains unavailable if optional dependency is missing.
        pass


def validate_and_normalize_profile_picture(uploaded_file, max_mb: int = 10):
    max_bytes = max_mb * 1024 * 1024
    if uploaded_file.size > max_bytes:
        raise serializers.ValidationError(f'Profile picture must be less than {max_mb}MB')

    _register_heif_support()

    original_name = getattr(uploaded_file, 'name', 'profile_picture')
    original_base, original_ext = os.path.splitext(original_name)

    try:
        uploaded_file.seek(0)
        image = Image.open(uploaded_file)
        image.load()
    except (UnidentifiedImageError, OSError, ValueError):
        raise serializers.ValidationError('Uploaded file is not a valid image')

    image_format = (image.format or '').upper()
    allowed_formats = {'JPEG', 'PNG', 'WEBP', 'HEIC', 'HEIF'}
    if image_format not in allowed_formats:
        raise serializers.ValidationError('Only JPEG, PNG, WebP, HEIC, and HEIF images are allowed')

    if image_format in {'HEIC', 'HEIF'}:
        converted = image.convert('RGB')
        buffer = BytesIO()
        converted.save(buffer, format='JPEG', quality=90, optimize=True)
        buffer.seek(0)
        return SimpleUploadedFile(
            name=f'{original_base or "profile_picture"}.jpg',
            content=buffer.read(),
            content_type='image/jpeg',
        )

    uploaded_file.seek(0)
    if not original_ext:
        fallback_ext = {
            'JPEG': '.jpg',
            'PNG': '.png',
            'WEBP': '.webp',
        }.get(image_format)
        if fallback_ext:
            uploaded_file.name = f'{original_base or "profile_picture"}{fallback_ext}'

    return uploaded_file
