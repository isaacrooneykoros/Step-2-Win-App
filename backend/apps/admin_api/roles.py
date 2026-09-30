"""Staff roles and permissions for the admin console.

Every admin endpoint declares the permission it needs; the server enforces it (403)
and the console hides what the signed-in staff member cannot do
(GET /api/admin/me/permissions/).

Roles (a staff member can hold several):

    owner     superuser. Implies every permission, including the owner-only ones.
    finance   money: ledgers, deposits, withdrawals, wallet adjustments, payout reviews.
    support   tickets, and the user edits support needs (details, passwords, sign-out).
    trust     anti-cheat, moderation, linkage, risk model, step corrections, bans.
    content   challenges, badges, XP, legal documents, announcements.
    settings  system / privacy / social / linkage settings, scheduled jobs.

Every role includes ``console.view`` (read-only console: dashboard, users, steps,
challenges, audit log, analytics, ops).

Permission map (role -> permissions) is ROLE_PERMISSIONS below. Owner-only
permissions start with ``owner.``: staff management, AntiCheatPolicy activation,
ML model activation, finance controls (two-person threshold) and account deletion.

Staff without a StaffProfile row ("legacy staff": accounts that were staff before
roles existed, or made staff outside the console) hold DEFAULT_LEGACY_ROLES = every
role except owner, so existing accounts keep working. Migration
0012_staff_roles_and_money_controls writes an explicit profile for every existing
non-superuser staff account; staff invited through the console always get the
roles chosen for them.

Usage in views::

    @permission_classes([HasStaffPermission("finance.withdrawals")])
    # GET needs console.view, writes need settings.system:
    @permission_classes([HasStaffPermission("console.view", write="settings.system")])

    class MyViewSet(viewsets.ModelViewSet):
        permission_classes = [StaffActionPermission]
        staff_perms = {"list": "console.view", "ban_user": "users.ban", "*": "console.view"}
"""

from __future__ import annotations

from rest_framework import permissions

OWNER = "owner"
ROLE_CHOICES = [
    (OWNER, "Owner"),
    ("finance", "Finance"),
    ("support", "Support"),
    ("trust", "Trust & safety"),
    ("content", "Content"),
    ("settings", "Settings"),
]
ROLES = [r for r, _ in ROLE_CHOICES]
ROLE_LABELS = dict(ROLE_CHOICES)
ROLE_DESCRIPTIONS = {
    OWNER: "Everything, including staff management, finance controls and model/policy activation.",
    "finance": "Ledgers, deposits, withdrawals, wallet adjustments and payout reviews.",
    "support": "Support tickets and the account fixes support needs (details, passwords, sign-out, unlock).",
    "trust": "Anti-cheat flags, moderation, linkage, risk scores, bans, device resets and step corrections.",
    "content": "Challenges (incl. platform challenges), badges, XP, legal documents and announcements.",
    "settings": "System, privacy, social and linkage settings; scheduled jobs.",
}

# Permission -> short description (shown on the Staff & roles page).
PERMISSIONS: dict[str, str] = {
    "console.view": "Open the console and read users, steps, challenges, audit log, analytics and ops",
    "users.edit": "Edit user details and daily goal, reset passwords, sign users out, unlock sign-in, message users",
    "users.ban": "Ban and unban accounts",
    "users.export": "Export user lists to CSV",
    "users.devices": "Reset a user's step-tracking device binding",
    "users.xp": "Adjust XP and award or revoke badges",
    "steps.correct": "Set or void a user's steps for a day (with recompute)",
    "finance.view": "Read ledgers, deposits, withdrawals and finance reports",
    "finance.withdrawals": "Approve, reject, re-check and resolve withdrawals",
    "finance.deposits": "Verify and resolve deposits with IntaSend",
    "finance.adjust": "Request wallet adjustments and reversals",
    "finance.approve_adjustment": "Approve other staff's wallet corrections above the threshold",
    "finance.payout_review": "Release or forfeit held challenge payouts",
    "support.view": "Read support tickets",
    "support.reply": "Reply to, assign and update tickets; manage tags and saved replies",
    "trust.view": "Read anti-cheat flags, cases, linkage and risk scores",
    "trust.act": "Decide flags and sessions, moderate users, mark households, label risk days",
    "challenges.manage": "Approve, reject, cancel, feature, edit and archive challenges",
    "challenges.platform": "Create platform (sponsored) challenges",
    "challenges.disqualify": "Remove a participant from a live challenge (refund or forfeit)",
    "content.badges": "Create, edit and retire badges",
    "content.legal": "Edit and publish legal documents",
    "content.announcements": "Manage announcements and help articles",
    "settings.system": "Change system, privacy, social and linkage settings; run scheduled jobs",
    "owner.staff": "Invite staff, change roles, remove staff access",
    "owner.delete_users": "Delete (anonymise) user accounts",
    "owner.finance_controls": "Change the two-person approval threshold",
    "owner.anticheat_policy": "Create and activate anti-cheat policy versions",
    "owner.risk_models": "Activate risk model versions",
}

ROLE_PERMISSIONS: dict[str, frozenset[str]] = {
    "finance": frozenset(
        {
            "console.view",
            "finance.view",
            "finance.withdrawals",
            "finance.deposits",
            "finance.adjust",
            "finance.approve_adjustment",
            "finance.payout_review",
            "challenges.disqualify",
        }
    ),
    "support": frozenset(
        {
            "console.view",
            "support.view",
            "support.reply",
            "users.edit",
            "users.export",
            "finance.view",
        }
    ),
    "trust": frozenset(
        {
            "console.view",
            "trust.view",
            "trust.act",
            "users.ban",
            "users.devices",
            "steps.correct",
            "challenges.disqualify",
            "support.view",
        }
    ),
    "content": frozenset(
        {
            "console.view",
            "challenges.manage",
            "challenges.platform",
            "content.badges",
            "content.legal",
            "content.announcements",
            "users.xp",
        }
    ),
    "settings": frozenset({"console.view", "settings.system"}),
}
ROLE_PERMISSIONS[OWNER] = frozenset(PERMISSIONS)

DEFAULT_LEGACY_ROLES = [r for r in ROLES if r != OWNER]


def clean_roles(raw) -> list[str]:
    """Known roles only, in catalogue order, no duplicates."""
    wanted = {str(r).strip().lower() for r in (raw or []) if str(r).strip()}
    return [r for r in ROLES if r in wanted]


def _profile(user):
    try:
        return user.staff_profile
    except Exception:  # RelatedObjectDoesNotExist
        return None


def roles_for(user) -> list[str]:
    """Roles a user holds. Superusers are owners (every role)."""
    if not user or not getattr(user, "is_authenticated", False) or not user.is_active or not user.is_staff:
        return []
    if user.is_superuser:
        return list(ROLES)
    profile = _profile(user)
    if profile is None:
        return list(DEFAULT_LEGACY_ROLES)
    return clean_roles(profile.roles)


def permissions_for(user) -> set[str]:
    perms: set[str] = set()
    for role in roles_for(user):
        perms |= ROLE_PERMISSIONS.get(role, frozenset())
    return perms


def has_perm(user, perm: str) -> bool:
    if not user or not getattr(user, "is_authenticated", False):
        return False
    if not user.is_active or not user.is_staff:
        return False
    if user.is_superuser:
        return True
    return perm in permissions_for(user)


def is_owner(user) -> bool:
    return bool(user and getattr(user, "is_authenticated", False) and user.is_active and user.is_staff and user.is_superuser)


class HasStaffPermission(permissions.BasePermission):
    """DRF permission for one staff permission (optionally another for writes).

    Instances are callable so they can sit in ``permission_classes`` directly:
    DRF instantiates each entry with ``entry()``, which returns the instance.
    """

    message = "Your staff role does not allow this action."

    def __init__(self, perm: str = "console.view", *, write: str | None = None):
        if perm not in PERMISSIONS or (write is not None and write not in PERMISSIONS):
            raise ValueError(f"Unknown staff permission: {perm!r} / {write!r}")
        self.perm = perm
        self.write = write

    def __call__(self):
        return self

    def required(self, request) -> str:
        if self.write and request.method not in permissions.SAFE_METHODS:
            return self.write
        return self.perm

    def has_permission(self, request, view):
        return has_perm(request.user, self.required(request))


class StaffActionPermission(permissions.BasePermission):
    """Per-action permissions for viewsets: ``view.staff_perms[action]`` (``"*"`` = default)."""

    message = "Your staff role does not allow this action."

    def has_permission(self, request, view):
        mapping = getattr(view, "staff_perms", {}) or {}
        action = getattr(view, "action", None)
        perm = mapping.get(action) or mapping.get("*") or "console.view"
        return has_perm(request.user, perm)


# Shorthand used across the admin views.
def staff(perm: str = "console.view", *, write: str | None = None) -> list:
    return [permissions.IsAuthenticated, HasStaffPermission(perm, write=write)]


def permissions_payload(user) -> dict:
    """Body of GET /api/admin/me/permissions/."""
    roles = roles_for(user)
    perms = sorted(permissions_for(user)) if not user.is_superuser else sorted(PERMISSIONS)
    profile = _profile(user)
    return {
        "user_id": user.id,
        "username": user.username,
        "is_owner": is_owner(user),
        "is_superuser": bool(user.is_superuser),
        "roles": roles,
        "legacy_roles": bool(user.is_staff and not user.is_superuser and profile is None),
        "permissions": perms,
    }


def catalog() -> dict:
    return {
        "roles": [
            {
                "value": r,
                "label": ROLE_LABELS[r],
                "description": ROLE_DESCRIPTIONS[r],
                "permissions": sorted(ROLE_PERMISSIONS[r]),
            }
            for r in ROLES
        ],
        "permissions": [{"value": k, "description": v} for k, v in PERMISSIONS.items()],
    }
