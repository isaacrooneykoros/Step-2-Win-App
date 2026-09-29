"""
Consent purposes, versions and the current state per user.

Purposes
  terms          REQUIRED. Terms and Conditions + Privacy Policy + "I am 18 or older".
  health_data    REQUIRED. Processing of step / activity data (health data under the
                 Kenya Data Protection Act, s.44 "sensitive personal data") to count
                 steps, run challenges and check fair play.
  location_walks OPTIONAL. Precise location, only while a walk the user started is
                 running (Phase 1b "Start a walk"). Asked before the first walk.

Required consents can't be withdrawn in the app on their own: without them Step2Win
can't run the account, so "withdraw" means deleting the account (Settings > Delete
account). Optional ones can be withdrawn at any time.

Versions
  A consent is tied to the published Terms / Privacy Policy versions at that moment
  (apps.legal.LegalDocument.version; 0 while a document isn't published yet). A user
  must accept again when their accepted version is below
  PrivacySettings.min_terms_version / min_privacy_version, which rise automatically
  when staff publish a document with "notify users" switched on (signals.py).
"""

from __future__ import annotations

from dataclasses import dataclass

from django.db import transaction

from .models import Consent, PrivacySettings

# Bump when the in-app checkbox wording below changes materially.
TEXT_VERSION = "2026-09"

TERMS_TYPE = "terms_and_conditions"
PRIVACY_TYPE = "privacy_policy"


@dataclass(frozen=True)
class Purpose:
    key: str
    required: bool
    title: str
    description: str
    withdraw_effect: str
    # Which document versions the consent is tied to.
    documents: tuple[str, ...]


PURPOSES: dict[str, Purpose] = {
    Consent.PURPOSE_TERMS: Purpose(
        key=Consent.PURPOSE_TERMS,
        required=True,
        title="Terms, Privacy Policy and age",
        description="You agreed to the Terms and Conditions and the Privacy Policy, and "
        "confirmed you are 18 or older.",
        withdraw_effect="Needed to have a Step2Win account. To withdraw it, delete your account.",
        documents=("terms", "privacy"),
    ),
    Consent.PURPOSE_HEALTH: Purpose(
        key=Consent.PURPOSE_HEALTH,
        required=True,
        title="Activity and health data",
        description="Step2Win uses your step counts and the motion data your phone reports "
        "to count your steps, run challenges and keep them fair.",
        withdraw_effect="Step2Win can't count your steps without it. To withdraw it, delete your "
        "account: your step history is then deleted.",
        documents=("privacy",),
    ),
    Consent.PURPOSE_LOCATION: Purpose(
        key=Consent.PURPOSE_LOCATION,
        required=False,
        title="Location during walks you start",
        description="Your precise location is used only while a walk you started is running, "
        "to record its route. Never in the background, never shared with other users.",
        withdraw_effect="You won't be able to start walks with GPS, so walks won't count toward "
        "challenge money. Your synced steps still count for goals, streaks and XP. Routes you "
        "already recorded stay in your history (their raw GPS points are deleted after 30 days).",
        documents=("privacy",),
    ),
}

REQUIRED_PURPOSES = tuple(k for k, p in PURPOSES.items() if p.required)
OPTIONAL_PURPOSES = tuple(k for k, p in PURPOSES.items() if not p.required)
SOURCES = {key for key, _ in Consent.SOURCE_CHOICES}


class ConsentError(Exception):
    def __init__(self, code: str, message: str, status_code: int = 400):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


# ── Document versions ────────────────────────────────────────────────────────


def current_document_versions() -> dict[str, int]:
    """Published version of the Terms and the Privacy Policy (0 = not published yet)."""
    from apps.legal.models import LegalDocument

    rows = dict(
        LegalDocument.objects.filter(
            document_type__in=(TERMS_TYPE, PRIVACY_TYPE), status="published"
        ).values_list("document_type", "version")
    )
    return {"terms": int(rows.get(TERMS_TYPE) or 0), "privacy": int(rows.get(PRIVACY_TYPE) or 0)}


def document_info() -> dict:
    from apps.legal.models import LegalDocument

    out = {}
    for key, doc_type in (("terms", TERMS_TYPE), ("privacy", PRIVACY_TYPE)):
        doc = LegalDocument.objects.filter(document_type=doc_type, status="published").first()
        out[key] = (
            {"slug": doc.slug, "title": doc.title, "version": doc.version, "version_label": doc.version_label,
             "change_summary": doc.change_summary}
            if doc
            else {"slug": "terms-and-conditions" if key == "terms" else "privacy-policy", "title": None,
                  "version": 0, "version_label": None, "change_summary": ""}
        )
    return out


def version_string(purpose: str, versions: dict[str, int]) -> str:
    return ";".join(f"{d}={int(versions.get(d, 0))}" for d in PURPOSES[purpose].documents)


def minimum_versions(settings_obj: PrivacySettings | None = None) -> dict[str, int]:
    """Lowest accepted version per document. Never above the published version, so a
    minimum set too high by hand can't lock users in an endless "accept again" loop."""
    s = settings_obj or PrivacySettings.load()
    published = current_document_versions()
    return {
        "terms": min(int(s.min_terms_version), published["terms"]),
        "privacy": min(int(s.min_privacy_version), published["privacy"]),
    }


# ── State ────────────────────────────────────────────────────────────────────


def latest_records(user) -> dict[str, Consent]:
    """Latest Consent row per purpose for ``user``."""
    out: dict[str, Consent] = {}
    for row in Consent.objects.filter(user=user).order_by("-created_at", "-id"):
        out.setdefault(row.purpose, row)
    return out


def _is_current(purpose: str, record: Consent | None, minimum: dict[str, int]) -> bool:
    if record is None or not record.granted:
        return False
    accepted = record.document_versions or {}
    return all(int(accepted.get(d, 0) or 0) >= minimum.get(d, 0) for d in PURPOSES[purpose].documents)


def status_for(purpose: str, record: Consent | None, minimum: dict[str, int]) -> str:
    """granted | outdated (granted, but for an older policy version) | withdrawn | not_given."""
    if record is None:
        return "not_given"
    if not record.granted:
        return "withdrawn"
    return "granted" if _is_current(purpose, record, minimum) else "outdated"


def has_consent(user, purpose: str) -> bool:
    """True when ``user`` currently consents to ``purpose`` for the current minimum version.

    For other modules (e.g. the walk start endpoint: ``has_consent(user, "location_walks")``).
    """
    if purpose not in PURPOSES or not getattr(user, "is_authenticated", False):
        return False
    record = (
        Consent.objects.filter(user=user, purpose=purpose).order_by("-created_at", "-id").first()
    )
    return _is_current(purpose, record, minimum_versions())


def missing_required(user) -> list[str]:
    records = latest_records(user)
    minimum = minimum_versions()
    return [p for p in REQUIRED_PURPOSES if not _is_current(p, records.get(p), minimum)]


def overview(user) -> dict:
    records = latest_records(user)
    minimum = minimum_versions()
    purposes = []
    for key, p in PURPOSES.items():
        rec = records.get(key)
        purposes.append(
            {
                "purpose": key,
                "required": p.required,
                "title": p.title,
                "description": p.description,
                "withdraw_effect": p.withdraw_effect,
                "status": status_for(key, rec, minimum),
                "granted": bool(rec and rec.granted),
                "version": rec.version if rec else None,
                "updated_at": rec.created_at if rec else None,
                "source": rec.source if rec else None,
            }
        )
    missing = [p["purpose"] for p in purposes if p["required"] and p["status"] != "granted"]
    return {
        "purposes": purposes,
        "needs_consent": bool(missing),
        "missing": missing,
        "documents": document_info(),
        "text_version": TEXT_VERSION,
    }


# ── Recording ────────────────────────────────────────────────────────────────


def record(user, purpose: str, granted: bool, *, source: str = "api", app_version: str = "",
           versions: dict[str, int] | None = None) -> Consent:
    if purpose not in PURPOSES:
        raise ConsentError("unknown_purpose", f"Unknown consent purpose: {purpose}")
    if source not in SOURCES:
        source = "api"
    versions = versions if versions is not None else current_document_versions()
    doc_versions = {d: int(versions.get(d, 0)) for d in PURPOSES[purpose].documents}
    return Consent.objects.create(
        user=user,
        purpose=purpose,
        granted=bool(granted),
        version=version_string(purpose, versions),
        document_versions=doc_versions,
        text_version=TEXT_VERSION,
        source=source,
        app_version=str(app_version or "")[:32],
    )


def apply_changes(user, changes: dict, *, source: str = "settings", app_version: str = "") -> list[Consent]:
    """Record several decisions at once (one transaction). Refuses to withdraw a
    required purpose (that means deleting the account). Only writes a row when the
    decision differs from the current state, or re-confirms an outdated grant."""
    if not isinstance(changes, dict) or not changes:
        raise ConsentError("invalid", "Send at least one consent decision.")
    for purpose, value in changes.items():
        if purpose not in PURPOSES:
            raise ConsentError("unknown_purpose", f"Unknown consent purpose: {purpose}")
        if not isinstance(value, bool):
            raise ConsentError("invalid", f"{purpose} must be true or false.")
        if PURPOSES[purpose].required and value is False:
            raise ConsentError(
                "required_consent",
                "This consent is needed to have a Step2Win account. To withdraw it, delete your "
                "account from Settings.",
            )
    versions = current_document_versions()
    written: list[Consent] = []
    with transaction.atomic():
        records = latest_records(user)
        for purpose, value in changes.items():
            rec = records.get(purpose)
            if rec is not None and rec.granted == value:
                accepted = rec.document_versions or {}
                up_to_date = all(
                    int(accepted.get(d, 0) or 0) >= versions.get(d, 0) for d in PURPOSES[purpose].documents
                )
                if not value or up_to_date:
                    continue  # nothing new to record
            written.append(record(user, purpose, value, source=source, app_version=app_version, versions=versions))
    return written


def parse_decisions(data) -> dict[str, bool]:
    """Known purposes with a real boolean from ``data["consents"]`` (anything else ignored)."""
    raw = data.get("consents") if hasattr(data, "get") else None
    if not isinstance(raw, dict):
        return {}
    return {k: v for k, v in raw.items() if k in PURPOSES and isinstance(v, bool)}


def validate_registration_consents(data) -> dict[str, bool]:
    """The ``consents`` object sent with registration: required purposes must be true.

    Returns the decisions to record after the account exists. Raises ConsentError when a
    required box is missing. Clients that send a ``consents`` object (the current web app and
    app) are always checked. Only a registration with no ``consents`` at all (an older app
    build that has no checkboxes) is let through, and only while
    PrivacySettings.require_consent_at_registration is off; those users are asked to accept
    on first launch of an updated app.
    """
    decisions = parse_decisions(data)
    sent_consents = isinstance(data, dict) and data.get("consents") is not None
    if sent_consents or PrivacySettings.load().require_consent_at_registration:
        missing = [p for p in REQUIRED_PURPOSES if decisions.get(p) is not True]
        if missing:
            raise ConsentError(
                "consent_required",
                "Please tick the boxes to agree to the Terms and Privacy Policy, confirm you are "
                "18 or older, and allow Step2Win to process your activity data.",
            )
    return decisions


def record_registration_consents(user, decisions: dict[str, bool], *, source: str = "registration",
                                 app_version: str = "") -> list[Consent]:
    versions = current_document_versions()
    return [
        record(user, purpose, value, source=source, app_version=app_version, versions=versions)
        for purpose, value in decisions.items()
    ]
