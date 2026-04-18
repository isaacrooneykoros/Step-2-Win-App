from __future__ import annotations

from django.core.cache import cache


def acquire_lock(lock_key: str, *, ttl_seconds: int = 30) -> bool:
    return cache.add(lock_key, '1', timeout=max(1, int(ttl_seconds)))


def release_lock(lock_key: str) -> None:
    cache.delete(lock_key)
