"""Ops alert when the linked-account check breaks (settlement then pays as if there
were no link; the other hold rules still apply). Same webhook as the other ops alerts
(settings.OPS_ALERT_WEBHOOK_URL); never raises."""

import logging

from django.conf import settings

logger = logging.getLogger("apps.linkage.alerts")


def ops_alert(payload: dict) -> None:
    logger.error("OPS ALERT linkage: %s", payload)
    webhook = (getattr(settings, "OPS_ALERT_WEBHOOK_URL", "") or "").strip()
    if not webhook:
        return
    try:
        import requests

        requests.post(webhook, json={"source": "linkage", **payload}, timeout=4)
    except Exception as exc:  # an alert must never break settlement
        logger.warning("Could not send linkage ops alert: %s", exc)
