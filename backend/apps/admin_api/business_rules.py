"""
Business switches and limits that staff change in the console (Settings), with the
server configuration (env / settings.py) kept as the fallback and the hard limit.

Precedence, for every rule below:

1. The console value (a SystemSettings column) when it is set.
2. Otherwise the server value from settings.py / the environment (the old switch).
3. Numbers are then clamped to the server's hard limits, so a console value can make
   a rule stricter but never looser than the deployment allows:
   - "cap" rules (largest deposit, largest withdrawal, daily totals, requests per
     day/hour, share of wallet that can be locked, raw GPS retention): the server
     value is a CEILING; the effective value is min(console, server).
   - "floor" rules (smallest deposit, gap between withdrawals): the server value is a
     FLOOR; the effective value is max(console, server).
   - trust score for paid challenges: at least PAID_CHALLENGE_TRUST_FLOOR.
   - everything else (booleans, dates, monitoring thresholds): console value if set,
     else the server value, inside a sanity range.

A blank console value (NULL) means "use the server value". If the settings table
cannot be read (migrations, a database blip), every reader falls back to the server
value, so the app keeps working with the deployment's configuration.

Readers: challenges/payout_policy.py, steps/evidence.py, steps/integrity.py,
payments (serializers, services), challenges/views.py (paid-challenge eligibility and
locked balance), risk_ml/training.py, payments/tasks.py + steps/tasks.py + the ops
dashboard (monitoring thresholds), steps/walks.py via privacy settings.
"""

from __future__ import annotations

import logging
from datetime import date
from decimal import Decimal

from django.conf import settings as django_settings

logger = logging.getLogger(__name__)


def _console():
    """The cached SystemSettings row, or None when it can't be read."""
    try:
        from apps.admin_api.platform import current_settings

        return current_settings()
    except Exception:  # noqa: BLE001 - never break a request over a settings read
        logger.debug("SystemSettings unavailable; using server values", exc_info=True)
        return None


def _server(name, default=None):
    return getattr(django_settings, name, default)


def _as_bool(value) -> bool:
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on"}
    return bool(value)


def _stored(field):
    s = _console()
    return None if s is None else getattr(s, field, None)


# ── Rule table ───────────────────────────────────────────────────────────────
# field -> (server setting, kind, bound)
#   kind:  bool | date | int | decimal | float
#   bound: "cap" (server is a ceiling), "floor" (server is a floor), None
#   range: (lo, hi) sanity range for console input
RULES: dict[str, dict] = {
    # Challenges
    "rank_payouts_enabled": {"server": "RANK_PAYOUTS_ENABLED", "kind": "bool", "server_default": False},
    "paid_challenge_min_trust_score": {
        "server": "MIN_TRUST_SCORE_FOR_PAID_CHALLENGE", "kind": "int", "range": (0, 100), "server_default": 60,
    },
    "paid_challenge_min_joined": {
        "server": "MIN_CHALLENGES_JOINED_TO_CREATE_PAID_CHALLENGE", "kind": "int", "range": (0, 50), "server_default": 1,
    },
    "max_locked_balance_percent": {
        "server": "MAX_LOCKED_BALANCE_PERCENT", "kind": "int", "bound": "cap", "range": (10, 100), "server_default": 80,
    },
    # Anti-cheat & verification
    "step_money_requires_evidence": {"server": "STEP_MONEY_REQUIRES_EVIDENCE", "kind": "bool", "server_default": False},
    "step_evidence_cutover_date": {"server": "STEP_EVIDENCE_CUTOVER_DATE", "kind": "date", "server_default": None},
    "play_integrity_accept_basic": {"server": "PLAY_INTEGRITY_ACCEPT_BASIC", "kind": "bool", "server_default": False},
    "risk_ml_hold_threshold": {"server": "RISK_ML_HOLD_THRESHOLD", "kind": "float", "range": (0.05, 0.99), "server_default": 0.8},
    # Money
    "min_deposit_kes": {"server": "MIN_DEPOSIT_KES", "kind": "decimal", "bound": "floor", "range": (1, 1_000_000), "server_default": 10},
    "max_deposit_kes": {"server": "MAX_DEPOSIT_KES", "kind": "decimal", "bound": "cap", "range": (1, 1_000_000), "server_default": 100_000},
    "max_withdrawal_kes": {"server": "MAX_WITHDRAWAL_KES", "kind": "decimal", "bound": "cap", "range": (1, 1_000_000), "server_default": 70_000},
    "max_daily_withdrawal_kes": {
        "server": "MAX_DAILY_WITHDRAWAL_AMOUNT_KES", "kind": "decimal", "bound": "cap", "range": (1, 10_000_000), "server_default": 100_000,
    },
    "max_withdrawals_per_day": {"server": "MAX_WITHDRAWALS_PER_DAY", "kind": "int", "bound": "cap", "range": (1, 100), "server_default": 3},
    "max_withdrawals_per_hour": {"server": "MAX_WITHDRAWALS_PER_HOUR", "kind": "int", "bound": "cap", "range": (1, 100), "server_default": 1},
    "min_seconds_between_withdrawals": {
        "server": "MIN_SECONDS_BETWEEN_WITHDRAWALS", "kind": "int", "bound": "floor", "range": (0, 86_400), "server_default": 300,
    },
    # Monitoring thresholds (Ops monitoring alerts)
    "recon_max_stuck_processing": {"server": "RECON_MAX_STUCK_PROCESSING", "kind": "int", "range": (0, 10_000), "server_default": 10},
    "recon_max_unprocessed_callbacks": {"server": "RECON_MAX_UNPROCESSED_CALLBACKS", "kind": "int", "range": (0, 10_000), "server_default": 5},
    "recon_max_negative_balance_users": {"server": "RECON_MAX_NEGATIVE_BALANCE_USERS", "kind": "int", "range": (0, 10_000), "server_default": 0},
    "recon_max_callback_failure_rate_pct": {"server": "RECON_MAX_CALLBACK_FAILURE_RATE_PCT", "kind": "float", "range": (0, 100), "server_default": 5.0},
    "drift_lookback_hours": {"server": "ANTICHEAT_DRIFT_LOOKBACK_HOURS", "kind": "int", "range": (1, 24 * 14), "server_default": 24},
    "drift_min_samples": {"server": "ANTICHEAT_DRIFT_MIN_SAMPLES", "kind": "int", "range": (1, 100_000), "server_default": 50},
    "drift_per_sample_alert_pct": {"server": "ANTICHEAT_DRIFT_PER_SAMPLE_ALERT_PCT", "kind": "float", "range": (0, 1000), "server_default": 35.0},
    "drift_max_avg_abs_delta_pct": {"server": "ANTICHEAT_DRIFT_MAX_AVG_ABS_DELTA_PCT", "kind": "float", "range": (0, 1000), "server_default": 20.0},
    "drift_max_high_drift_ratio_pct": {"server": "ANTICHEAT_DRIFT_MAX_HIGH_DRIFT_RATIO_PCT", "kind": "float", "range": (0, 100), "server_default": 25.0},
    "drift_max_review_mismatch_ratio_pct": {
        "server": "ANTICHEAT_DRIFT_MAX_REVIEW_MISMATCH_RATIO_PCT", "kind": "float", "range": (0, 100), "server_default": 10.0,
    },
}


def _convert(kind, value):
    if value is None:
        return None
    if kind == "bool":
        return _as_bool(value)
    if kind == "date":
        if isinstance(value, date):
            return value
        raw = str(value or "").strip()
        if not raw:
            return None
        try:
            return date.fromisoformat(raw)
        except ValueError:
            return None
    if kind == "int":
        return int(value)
    if kind == "decimal":
        return Decimal(str(value))
    if kind == "float":
        return float(value)
    return value


def server_value(field: str):
    """The deployment's value (env / settings.py) for a rule."""
    rule = RULES[field]
    try:
        return _convert(rule["kind"], _server(rule["server"], rule["server_default"]))
    except (TypeError, ValueError, ArithmeticError):
        return _convert(rule["kind"], rule["server_default"])


def _trust_floor() -> int:
    try:
        return max(0, min(100, int(_server("PAID_CHALLENGE_TRUST_FLOOR", 40))))
    except (TypeError, ValueError):
        return 40


def effective(field: str):
    """Console value if set, else the server value, then the server's hard limits."""
    rule = RULES[field]
    server = server_value(field)
    try:
        stored = _convert(rule["kind"], _stored(field))
    except (TypeError, ValueError, ArithmeticError):
        stored = None
    value = server if stored is None else stored
    if value is None or rule["kind"] in ("bool", "date"):
        return value
    bound = rule.get("bound")
    if server is not None and bound == "cap":
        value = min(value, server)
    elif server is not None and bound == "floor":
        value = max(value, server)
    if field == "paid_challenge_min_trust_score":
        value = max(value, _trust_floor())
    return value


def source(field: str) -> str:
    """'console' when a console value is in force, else 'server'."""
    return "server" if _stored(field) is None else "console"


def describe() -> dict:
    """Per rule: effective value, where it came from, the server value and its role."""
    out = {}
    for field, rule in RULES.items():
        server = server_value(field)
        out[field] = {
            "value": _jsonable(effective(field)),
            "source": source(field),
            "server_value": _jsonable(server),
            "server_setting": rule["server"],
            "bound": rule.get("bound"),
            "range": list(rule["range"]) if rule.get("range") else None,
        }
    out["paid_challenge_min_trust_score"]["floor"] = _trust_floor()
    return out


def _jsonable(v):
    if isinstance(v, Decimal):
        return str(v)
    if isinstance(v, date):
        return v.isoformat()
    return v


def validate_console_value(field: str, value):
    """Check a console value against the sanity range and the server's hard limits.

    Returns (clean_value, error_message). None clears the console value.
    """
    if value is None or value == "":
        return None, None
    rule = RULES[field]
    try:
        clean = _convert(rule["kind"], value)
    except (TypeError, ValueError, ArithmeticError):
        return None, "Enter a valid value."
    if clean is None:
        return None, "Enter a valid date (YYYY-MM-DD)." if rule["kind"] == "date" else "Enter a valid value."
    if rule["kind"] in ("bool", "date"):
        return clean, None
    lo, hi = rule.get("range", (None, None))
    if lo is not None and clean < lo:
        return None, f"Must be at least {lo}."
    if hi is not None and clean > hi:
        return None, f"Must be at most {hi}."
    server = server_value(field)
    bound = rule.get("bound")
    if bound == "cap" and server is not None and clean > server:
        return None, f"The server allows at most {_fmt(server)} ({rule['server']}). Ask a developer to raise it."
    if bound == "floor" and server is not None and clean < server:
        return None, f"The server requires at least {_fmt(server)} ({rule['server']})."
    if field == "paid_challenge_min_trust_score" and clean < _trust_floor():
        return None, f"Must be at least {_trust_floor()} (PAID_CHALLENGE_TRUST_FLOOR)."
    return clean, None


def _fmt(v):
    if isinstance(v, Decimal):
        return f"{v:,.0f}" if v == v.to_integral_value() else f"{v:,.2f}"
    return f"{v:,}" if isinstance(v, int) else str(v)


# ── Named readers used across the codebase ───────────────────────────────────


def rank_payouts_enabled() -> bool:
    return bool(effective("rank_payouts_enabled"))


def money_requires_evidence() -> bool:
    return bool(effective("step_money_requires_evidence"))


def evidence_cutover_date():
    return effective("step_evidence_cutover_date")


def play_integrity_accept_basic() -> bool:
    return bool(effective("play_integrity_accept_basic"))


def risk_ml_hold_threshold() -> float:
    return float(effective("risk_ml_hold_threshold"))


def deposit_limits() -> tuple[Decimal, Decimal]:
    lo = effective("min_deposit_kes")
    hi = effective("max_deposit_kes")
    if lo > hi:  # a floor above the ceiling: trust the server pair
        return server_value("min_deposit_kes"), server_value("max_deposit_kes")
    return lo, hi


def withdrawal_limits() -> dict:
    from apps.admin_api.platform import minimum_withdrawal_kes

    return {
        "min_kes": minimum_withdrawal_kes(),
        "max_kes": effective("max_withdrawal_kes"),
        "max_daily_kes": effective("max_daily_withdrawal_kes"),
        "max_per_day": effective("max_withdrawals_per_day"),
        "max_per_hour": effective("max_withdrawals_per_hour"),
        "min_seconds_between": effective("min_seconds_between_withdrawals"),
    }


def paid_challenge_rules() -> dict:
    return {
        "min_trust_score": effective("paid_challenge_min_trust_score"),
        "min_joined_to_create": effective("paid_challenge_min_joined"),
        "max_locked_percent": Decimal(str(effective("max_locked_balance_percent"))),
    }


def reconciliation_thresholds():
    from apps.payments.reconciliation import ReconciliationThresholds

    return ReconciliationThresholds(
        max_stuck_processing=effective("recon_max_stuck_processing"),
        max_unprocessed_callbacks=effective("recon_max_unprocessed_callbacks"),
        max_negative_balance_users=effective("recon_max_negative_balance_users"),
        max_callback_failure_rate_pct=effective("recon_max_callback_failure_rate_pct"),
    )


def drift_thresholds():
    from apps.steps.drift_monitor import AntiCheatDriftThresholds

    return AntiCheatDriftThresholds(
        lookback_hours=effective("drift_lookback_hours"),
        min_samples=effective("drift_min_samples"),
        per_sample_alert_pct=effective("drift_per_sample_alert_pct"),
        max_avg_abs_delta_pct=effective("drift_max_avg_abs_delta_pct"),
        max_high_drift_ratio_pct=effective("drift_max_high_drift_ratio_pct"),
        max_review_mismatch_ratio_pct=effective("drift_max_review_mismatch_ratio_pct"),
    )
