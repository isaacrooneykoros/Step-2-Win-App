"""
Security Event Logger for Step2Win
────────────────────────────────────
Logs security-relevant events to Django's logging system.
Goes to both console and logs/security.log (rotating).
Configure Sentry DSN in .env to get alerts in production.
"""
import logging

security_logger = logging.getLogger('step2win.security')


def log_login_success(user, ip_address: str):
    security_logger.info(
        'LOGIN_SUCCESS user_id=%s username=%s ip=%s',
        user.id, user.username, ip_address,
    )


def log_login_failure(username: str, ip_address: str, reason: str = ''):
    security_logger.warning(
        'LOGIN_FAILURE username=%s ip=%s reason=%s',
        username, ip_address, reason,
    )


def log_suspicious_payment(user_id: int, amount: float, reason: str):
    security_logger.warning(
        'SUSPICIOUS_PAYMENT user_id=%s amount=%s reason=%s',
        user_id, amount, reason,
    )


def log_rate_limit_hit(endpoint: str, ip_address: str, user_id: int = None):
    security_logger.warning(
        'RATE_LIMIT_HIT endpoint=%s ip=%s user_id=%s',
        endpoint, ip_address, user_id,
    )


def log_unauthorized_access(user_id: int, resource: str, ip_address: str):
    security_logger.error(
        'UNAUTHORIZED_ACCESS user_id=%s resource=%s ip=%s',
        user_id, resource, ip_address,
    )
