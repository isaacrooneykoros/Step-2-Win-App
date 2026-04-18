from django.conf import settings


def build_absolute_media_url(media_path: str | None, request=None) -> str | None:
    if not media_path:
        return None

    if media_path.startswith('http://') or media_path.startswith('https://'):
        return media_path

    configured_base = (getattr(settings, 'MEDIA_BASE_URL', '') or '').strip().rstrip('/')
    if configured_base:
        path = media_path if media_path.startswith('/') else f'/{media_path}'
        return f'{configured_base}{path}'

    if request is not None:
        return request.build_absolute_uri(media_path)

    return media_path
