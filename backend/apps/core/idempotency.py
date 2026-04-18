from __future__ import annotations

from datetime import date

from django.core.cache import cache


def _cache_key(scope: str, user_id: int, idem_key: str) -> str:
    return f"step2win:idempotency:{scope}:{user_id}:{idem_key.strip()}"


def _metric_key(scope: str, day: date | None = None) -> str:
    d = day or date.today()
    return f"step2win:idempotency:duplicate_count:{scope}:{d.isoformat()}"


def _increment_duplicate_metric(scope: str) -> None:
    key = _metric_key(scope)
    # Keep 7 days so dashboards can show recent trends without DB writes.
    ttl_seconds = 7 * 24 * 60 * 60
    try:
        cache.incr(key)
    except Exception:
        cache.set(key, int(cache.get(key, 0) or 0) + 1, timeout=ttl_seconds)
    else:
        cache.touch(key, ttl_seconds)


def get_duplicate_rejection_count(scope: str, *, day: date | None = None) -> int:
    return int(cache.get(_metric_key(scope, day), 0) or 0)


def acquire_idempotency_slot(*, scope: str, user_id: int, idempotency_key: str | None, ttl_seconds: int = 180) -> bool:
    """
    Returns True when the key is fresh and acquires a short-lived slot.
    Returns False for duplicates.
    """
    if not idempotency_key:
        return True

    normalized = idempotency_key.strip()
    if not normalized:
        return True

    key = _cache_key(scope, user_id, normalized)
    acquired = cache.add(key, '1', timeout=max(1, int(ttl_seconds)))
    if not acquired:
        _increment_duplicate_metric(scope)
    return acquired
