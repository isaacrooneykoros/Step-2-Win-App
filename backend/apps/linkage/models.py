"""
Account linkage (anti-cheat Phase 2a): the identity graph between accounts.

- LinkEdge: one kind of evidence linking two accounts (user_a.id < user_b.id), with a
  strength class (strong / medium / weak), a weight and privacy-minimised evidence
  (masked identifiers, keyed hashes, counts and dates; never raw phone numbers, IPs or
  coordinates). Recomputed nightly; ``active=False`` when the evidence is no longer seen.
- LinkCluster / LinkClusterMember: connected components of the accounts whose pair
  evidence is strong enough to count as "linked" (see graph.py), rebuilt nightly and
  after a household decision. Pairs marked as a known household are left out.
- HouseholdMark: staff decision that two accounts are a real household (a family sharing
  a phone or an M-Pesa number). Suppresses linkage holds for that pair only.
- LinkageSettings: admin-adjustable policy switches (singleton, pk=1).
- LinkageRun: one nightly (or manual) recompute and its statistics.
"""

from django.conf import settings
from django.db import models

STRENGTH_STRONG = "strong"
STRENGTH_MEDIUM = "medium"
STRENGTH_WEAK = "weak"
STRENGTH_CHOICES = [
    (STRENGTH_STRONG, "Strong"),
    (STRENGTH_MEDIUM, "Medium"),
    (STRENGTH_WEAK, "Weak"),
]


class LinkEdge(models.Model):
    TYPE_SHARED_DEVICE = "shared_device"
    TYPE_SHARED_PAYOUT_ACCOUNT = "shared_payout_account"
    TYPE_SHARED_DEPOSIT_NUMBER = "shared_deposit_number"
    TYPE_PHONE_SEQUENCE = "phone_sequence"
    TYPE_SHARED_NETWORK = "shared_network"
    TYPE_CO_LOCATION = "co_location"
    TYPE_TWIN_CURVES = "twin_curves"
    TYPE_JOINT_CHALLENGES = "joint_challenges"
    TYPE_HANDOVER = "handover"
    TYPE_CHOICES = [
        (TYPE_SHARED_DEVICE, "Same phone"),
        (TYPE_SHARED_PAYOUT_ACCOUNT, "Same payout number or account"),
        (TYPE_SHARED_DEPOSIT_NUMBER, "Same deposit number"),
        (TYPE_PHONE_SEQUENCE, "Near-sequential phone numbers"),
        (TYPE_SHARED_NETWORK, "Same home network"),
        (TYPE_CO_LOCATION, "Walked at the same place and time"),
        (TYPE_TWIN_CURVES, "Near-identical hourly steps"),
        (TYPE_JOINT_CHALLENGES, "Join and qualify in the same challenges"),
        (TYPE_HANDOVER, "Steps alternate between the accounts"),
    ]

    user_a = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE,
                               related_name="linkage_edges_a")
    user_b = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE,
                               related_name="linkage_edges_b")
    edge_type = models.CharField(max_length=32, choices=TYPE_CHOICES)
    strength = models.CharField(max_length=8, choices=STRENGTH_CHOICES)
    weight = models.FloatField()
    evidence = models.JSONField(default=dict)
    # When the evidence itself happened (e.g. the second account's first use of the
    # device), not when we computed it. May be null when the source has no timestamp.
    evidence_first_at = models.DateTimeField(null=True, blank=True)
    evidence_last_at = models.DateTimeField(null=True, blank=True)
    active = models.BooleanField(default=True, db_index=True)
    first_detected_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        unique_together = [("user_a", "user_b", "edge_type")]
        indexes = [
            models.Index(fields=["user_a", "active"], name="linkage_edge_a_idx"),
            models.Index(fields=["user_b", "active"], name="linkage_edge_b_idx"),
            models.Index(fields=["edge_type", "active"], name="linkage_edge_type_idx"),
        ]
        ordering = ["user_a_id", "user_b_id", "edge_type"]

    def __str__(self):
        return f"{self.user_a_id}-{self.user_b_id} {self.edge_type} {self.weight:.2f}"


class LinkCluster(models.Model):
    # Stable key: the smallest member user id (clusters merge/split between runs; the
    # key keeps the admin view and hold details referring to the same group when possible).
    key = models.CharField(max_length=32, unique=True)
    size = models.IntegerField(default=0)
    strong_pairs = models.IntegerField(default=0)
    medium_pairs = models.IntegerField(default=0)
    max_pair_score = models.FloatField(default=0.0)
    first_seen_at = models.DateTimeField(auto_now_add=True)
    computed_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-size", "key"]

    def __str__(self):
        return f"cluster {self.key} ({self.size} accounts)"


class LinkClusterMember(models.Model):
    cluster = models.ForeignKey(LinkCluster, on_delete=models.CASCADE, related_name="members")
    user = models.OneToOneField(settings.AUTH_USER_MODEL, on_delete=models.CASCADE,
                                related_name="linkage_membership")
    joined_at = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        return f"{self.user_id} in {self.cluster_id}"


class HouseholdMark(models.Model):
    user_a = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE,
                               related_name="household_marks_a")
    user_b = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE,
                               related_name="household_marks_b")
    note = models.TextField()
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL,
                                   null=True, blank=True, related_name="household_marks_created")
    created_at = models.DateTimeField(auto_now_add=True)
    revoked_at = models.DateTimeField(null=True, blank=True)
    revoked_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL,
                                   null=True, blank=True, related_name="household_marks_revoked")
    revoke_note = models.TextField(blank=True, default="")

    class Meta:
        unique_together = [("user_a", "user_b")]
        ordering = ["-created_at"]

    @property
    def is_active(self):
        return self.revoked_at is None

    def __str__(self):
        return f"household {self.user_a_id}-{self.user_b_id}{'' if self.is_active else ' (revoked)'}"


class LinkageSettings(models.Model):
    """Policy switches (admin-adjustable). Defaults are conservative: links only ever
    HOLD a payout for review; nothing here bans, suspends or changes steps."""

    holds_enabled = models.BooleanField(default=True)
    # Several accounts of one cluster in the same paid challenge: hold every winner but
    # the first-registered account.
    same_challenge_hold = models.BooleanField(default=True)
    # A strong link (same phone / same payout number) to an account that already
    # received a payout: hold the new payout.
    strong_link_paid_hold = models.BooleanField(default=True)
    paid_lookback_days = models.IntegerField(default=180)
    # Behavioural detectors (co-location, twin curves, handover) look back this far.
    behaviour_lookback_days = models.IntegerField(default=14)
    # Medium evidence links two accounts only when it adds up to this AND comes from at
    # least two different kinds of evidence. Weak evidence never links.
    medium_link_threshold = models.FloatField(default=1.0)
    # A network (/24) or place-and-time seen with more accounts than this is a public
    # place (mobile carrier NAT, campus Wi-Fi, a group walk): ignored.
    network_max_accounts = models.IntegerField(default=6)
    colocation_max_accounts = models.IntegerField(default=8)
    updated_at = models.DateTimeField(auto_now=True)
    updated_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL,
                                   null=True, blank=True, related_name="+")

    EDITABLE = ("holds_enabled", "same_challenge_hold", "strong_link_paid_hold",
                "paid_lookback_days", "behaviour_lookback_days", "medium_link_threshold",
                "network_max_accounts", "colocation_max_accounts")
    BOUNDS = {
        "paid_lookback_days": (7, 730),
        "behaviour_lookback_days": (3, 60),
        "medium_link_threshold": (0.5, 3.0),
        "network_max_accounts": (2, 50),
        "colocation_max_accounts": (2, 50),
    }

    @classmethod
    def load(cls):
        obj, _ = cls.objects.get_or_create(pk=1)
        return obj

    def as_dict(self):
        return {f: getattr(self, f) for f in self.EDITABLE}


class LinkageRun(models.Model):
    started_at = models.DateTimeField(auto_now_add=True)
    finished_at = models.DateTimeField(null=True, blank=True)
    ok = models.BooleanField(default=False)
    stats = models.JSONField(default=dict)

    class Meta:
        ordering = ["-started_at"]
