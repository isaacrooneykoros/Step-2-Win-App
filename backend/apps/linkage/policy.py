"""
Linkage payout policies (called from apps/challenges/payout_holds.hold_reasons).

Links only ever HOLD a payout for staff review. They never ban, suspend, change steps
or standings, and the customer sees the same neutral "being reviewed" message as for
any other hold.

1. same_challenge: several accounts of one cluster are in the same PAID challenge ->
   every winner of that group except the first-registered account is held.
2. strong_link_paid: the winner has a STRONG link (same phone, same payout number or
   account) to another account that already received a payout (last
   ``paid_lookback_days``, other challenges) -> held.
Weak links never hold. Pairs marked as a known household are ignored by both rules.

The group is built from the nightly clusters PLUS strong links computed live for this
challenge's participants, so an account created or re-bound since the last nightly run
is still caught.
"""

from __future__ import annotations

from datetime import timedelta

from django.contrib.auth import get_user_model
from django.db.models import Q
from django.utils import timezone

from .detectors import live_strong_edges
from .graph import UnionFind
from .models import STRENGTH_STRONG, LinkageSettings, LinkClusterMember, LinkEdge
from .store import active_households

MAX_LISTED = 20


def _cluster_keys(user_ids) -> dict:
    return dict(LinkClusterMember.objects.filter(user_id__in=list(user_ids))
                .values_list("user_id", "cluster__key"))


def _strong_neighbours(user_id, live=None) -> dict:
    """{other user id: set of strong edge types} from stored active edges and live edges."""
    out: dict = {}
    for a, b, etype in (LinkEdge.objects.filter(Q(user_a_id=user_id) | Q(user_b_id=user_id),
                                                active=True, strength=STRENGTH_STRONG)
                        .values_list("user_a_id", "user_b_id", "edge_type")):
        out.setdefault(b if a == user_id else a, set()).add(etype)
    live = live if live is not None else live_strong_edges([user_id])
    for (a, b, etype) in live.touching([user_id]):
        out.setdefault(b if a == user_id else a, set()).add(etype)
    return out


def linked_group(user_id, candidate_ids, live=None) -> set:
    """The accounts among ``candidate_ids`` in the same linkage group as ``user_id``
    (nightly clusters + live strong links, households excluded)."""
    ids = set(candidate_ids) | {user_id}
    live = live if live is not None else live_strong_edges(ids)
    households = active_households(ids | {u for k in live.rows for u in k[:2]})
    uf = UnionFind()
    for u in ids:
        uf.find(u)
    for a, b, _ in live.rows:
        if (a, b) not in households:
            uf.union(a, b)
    nodes = {n for n in uf.parent if isinstance(n, int)}
    for u, key in _cluster_keys(nodes).items():
        uf.union(u, f"cluster:{key}")
    root = uf.find(user_id)
    return {u for u in ids if uf.find(u) == root}


def _people(ids) -> list[dict]:
    User = get_user_model()
    rows = User.objects.filter(pk__in=list(ids)).order_by("date_joined", "pk").values(
        "pk", "username", "date_joined")[:MAX_LISTED]
    return [{"user_id": r["pk"], "username": r["username"],
             "joined": r["date_joined"].isoformat() if r["date_joined"] else None} for r in rows]


def linked_account_reasons(challenge, participant, user, amount) -> list[dict]:
    """Detail dicts for the "linked_accounts" hold reason (empty list = no hold)."""
    from apps.challenges.models import Participant
    from apps.wallet.models import WalletTransaction

    cfg = LinkageSettings.load()
    if not cfg.holds_enabled:
        return []
    rules = []
    detail: dict = {}
    # Settlement calls this once per winner with the same challenge object: compute the
    # participants' live strong links once per settlement.
    cached = getattr(challenge, "_linkage_live", None)
    if cached is None:
        participant_ids = set(Participant.objects.filter(challenge_id=challenge.id)
                              .values_list("user_id", flat=True))
        cached = (participant_ids, live_strong_edges(participant_ids))
        try:
            challenge._linkage_live = cached
        except AttributeError:
            pass
    participant_ids, live = cached
    if user.id not in participant_ids:
        participant_ids = participant_ids | {user.id}
        live = live_strong_edges(participant_ids)

    if cfg.same_challenge_hold and challenge.entry_fee and challenge.entry_fee > 0:
        group = linked_group(user.id, participant_ids, live=live)
        if len(group) >= 2:
            people = _people(group)
            first = people[0]["user_id"] if people else None
            if first is not None and first != user.id:
                rules.append("same_challenge")
                detail["linked_in_challenge"] = [dict(p, first_registered=(p["user_id"] == first))
                                                 for p in people]

    if cfg.strong_link_paid_hold:
        neighbours = _strong_neighbours(user.id, live=live)
        households = active_households([user.id])
        neighbours = {u: t for u, t in neighbours.items()
                      if (min(u, user.id), max(u, user.id)) not in households}
        if neighbours:
            since = timezone.now() - timedelta(days=int(cfg.paid_lookback_days))
            paid = set()
            for uid, meta in (WalletTransaction.objects.filter(user_id__in=list(neighbours), type="payout",
                                                               created_at__gte=since)
                              .values_list("user_id", "metadata")):
                if (meta or {}).get("challenge_id") != challenge.id:
                    paid.add(uid)
            if paid:
                rules.append("strong_link_paid")
                names = {p["user_id"]: p["username"] for p in _people(paid)}
                detail["strong_links_paid"] = [
                    {"user_id": u, "username": names.get(u), "edge_types": sorted(neighbours[u])}
                    for u in sorted(paid)[:MAX_LISTED]]

    if not rules:
        return []
    key = _cluster_keys([user.id]).get(user.id)
    detail = {"rules": rules, "cluster": key, **detail}
    return [detail]


def forfeit_excluded_user_ids(user_id) -> set:
    """Accounts linked to ``user_id`` (its cluster and strong links, households
    excluded): they must not receive a share of this account's forfeited payout."""
    live = live_strong_edges([user_id])
    households = active_households([user_id])
    out = {u for u in _strong_neighbours(user_id, live=live)
           if (min(u, user_id), max(u, user_id)) not in households}
    key = _cluster_keys([user_id]).get(user_id)
    if key:
        out |= set(LinkClusterMember.objects.filter(cluster__key=key).values_list("user_id", flat=True))
    out.discard(user_id)
    return out
