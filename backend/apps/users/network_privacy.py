"""
Login IP minimisation (Kenya Data Protection Act).

- ``DeviceSession.ip_address`` (the full address) is kept only while the session is
  active: it is cleared when the session ends (logout, revoke, password reset, account
  deletion), when the refresh token has expired, and in any case after 90 days.
- ``DeviceSession.network_hash`` keeps only a keyed hash (HMAC-SHA256) of the network
  (/24 for IPv4, /48 for IPv6) of a PUBLIC address, for account linkage
  (apps/linkage). It is also deleted after 90 days. Private/reserved addresses (a proxy
  or load balancer) get no hash.
- Key: ``settings.NETWORK_HASH_SECRET`` (env NETWORK_HASH_SECRET); when unset it is
  derived from SECRET_KEY. Changing the key only means networks from before the change
  no longer match newer ones (links on this weak evidence restart); nothing breaks.
- Screens show a masked address ("41.90.x.x"), never the full one.
"""

from __future__ import annotations

import hashlib
import hmac
import ipaddress
import logging
from datetime import timedelta

from django.conf import settings
from django.utils import timezone

logger = logging.getLogger(__name__)

RETENTION_DAYS = 90
HASH_CHARS = 32
BATCH = 1000


def _key() -> bytes:
    secret = (getattr(settings, "NETWORK_HASH_SECRET", "") or "").strip()
    if not secret:
        secret = str(getattr(settings, "SECRET_KEY", "") or "")
    # Domain-separated so the key is never the raw SECRET_KEY.
    return hmac.new(b"step2win-network-hash-v1", secret.encode(), hashlib.sha256).digest()


def network_prefix(ip) -> str | None:
    """IPv4 /24 or IPv6 /48 of a public address; None for private/reserved or invalid."""
    if not ip:
        return None
    try:
        addr = ipaddress.ip_address(str(ip).strip())
    except ValueError:
        return None
    if not addr.is_global:
        return None
    bits = 24 if addr.version == 4 else 48
    return str(ipaddress.ip_network(f"{addr}/{bits}", strict=False))


def network_hash(ip) -> str:
    prefix = network_prefix(ip)
    if not prefix:
        return ""
    return hmac.new(_key(), prefix.encode(), hashlib.sha256).hexdigest()[:HASH_CHARS]


def masked_ip(ip) -> str | None:
    """Display form: first two IPv4 octets / first two IPv6 groups."""
    if not ip:
        return None
    try:
        addr = ipaddress.ip_address(str(ip).strip())
    except ValueError:
        return "hidden"
    if addr.version == 4:
        a, b, _, _ = str(addr).split(".")
        return f"{a}.{b}.x.x"
    groups = addr.exploded.split(":")
    return f"{groups[0]}:{groups[1]}:…"


def purge_ip_data(now=None) -> dict:
    """Retention (scheduled nightly, idempotent):
    1. ended sessions (inactive) and expired ones (no refresh within the refresh-token
       lifetime): hash the network if missing, then clear the full IP;
    2. rows older than 90 days: clear the IP and the network hash."""
    from apps.users.models import DeviceSession

    now = now or timezone.now()
    lifetime = (getattr(settings, "SIMPLE_JWT", {}) or {}).get("REFRESH_TOKEN_LIFETIME") or timedelta(days=7)
    cutoff_old = now - timedelta(days=RETENTION_DAYS)
    ended = (DeviceSession.objects.filter(ip_address__isnull=False)
             .filter(is_active=False) | DeviceSession.objects.filter(
                 ip_address__isnull=False, last_active_at__lt=now - lifetime))
    hashed = cleared = 0
    missing = list(ended.filter(network_hash="").values_list("pk", "ip_address")[:100_000])
    for i in range(0, len(missing), BATCH):
        for pk, ip in missing[i:i + BATCH]:
            h = network_hash(ip)
            if h:
                DeviceSession.objects.filter(pk=pk).update(network_hash=h)
                hashed += 1
    cleared = ended.update(ip_address=None)
    expired_hashes = (DeviceSession.objects.filter(last_active_at__lt=cutoff_old)
                      .exclude(network_hash="", ip_address__isnull=True)
                      .update(network_hash="", ip_address=None))
    result = {"hashed": hashed, "ips_cleared": cleared, "old_rows_scrubbed": expired_hashes}
    logger.info("IP retention: %s", result)
    return result
