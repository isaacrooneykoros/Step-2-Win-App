"""
Nightly recompute of the identity graph (idempotent, batched).

``recompute_linkage()`` runs every detector, upserts LinkEdge rows on their unique key
(user_a, user_b, edge_type), marks edges whose evidence is gone as inactive (only for
detectors that succeeded this run), then rebuilds clusters. Running it twice in a row
leaves the same rows; ``first_detected_at`` of an edge is kept across runs.
"""

from __future__ import annotations

import logging
import time
import tracemalloc
from datetime import date, timedelta

from django.conf import settings
from django.db import transaction
from django.utils import timezone

from .detectors import detect_all
from .graph import clusters as build_clusters
from .graph import pair_edges
from .models import (HouseholdMark, LinkageRun, LinkageSettings, LinkCluster,
                     LinkClusterMember, LinkEdge)

logger = logging.getLogger(__name__)

WRITE_BATCH = 500


def local_today() -> date:
    offset = int(getattr(settings, "RISK_ML_LOCAL_UTC_OFFSET_HOURS", 3))
    return (timezone.now() + timedelta(hours=offset)).date()


def active_households(user_ids=None) -> set:
    qs = HouseholdMark.objects.filter(revoked_at__isnull=True)
    if user_ids is not None:
        ids = list(user_ids)
        qs = qs.filter(user_a_id__in=ids) | qs.filter(user_b_id__in=ids)
    return {(a, b) for a, b in qs.values_list("user_a_id", "user_b_id")}


def _upsert_edges(edges, ok_types) -> dict:
    existing = {}
    for pk, a, b, etype, weight, strength, evidence, first, last, active in (
        LinkEdge.objects.values_list("pk", "user_a_id", "user_b_id", "edge_type", "weight", "strength",
                                     "evidence", "evidence_first_at", "evidence_last_at", "active")
        .iterator(chunk_size=5000)
    ):
        existing[(a, b, etype)] = (pk, weight, strength, evidence, first, last, active)
    now = timezone.now()
    to_create, to_update = [], []
    for key, row in edges.rows.items():
        cur = existing.pop(key, None)
        values = (row["weight"], row["strength"], row["evidence"], row["first"], row["last"], True)
        if cur is None:
            to_create.append(LinkEdge(user_a_id=key[0], user_b_id=key[1], edge_type=key[2],
                                      weight=row["weight"], strength=row["strength"], evidence=row["evidence"],
                                      evidence_first_at=row["first"], evidence_last_at=row["last"], active=True))
        elif tuple(cur[1:]) != values:
            to_update.append(LinkEdge(pk=cur[0], weight=row["weight"], strength=row["strength"],
                                      evidence=row["evidence"], evidence_first_at=row["first"],
                                      evidence_last_at=row["last"], active=True, updated_at=now))
    stale = [cur[0] for key, cur in existing.items() if cur[6] and key[2] in ok_types]
    with transaction.atomic():
        LinkEdge.objects.bulk_create(to_create, batch_size=WRITE_BATCH, ignore_conflicts=True)
        LinkEdge.objects.bulk_update(to_update, ["weight", "strength", "evidence", "evidence_first_at",
                                                 "evidence_last_at", "active", "updated_at"],
                                     batch_size=WRITE_BATCH)
        for i in range(0, len(stale), WRITE_BATCH):
            LinkEdge.objects.filter(pk__in=stale[i:i + WRITE_BATCH]).update(active=False, updated_at=now)
    return {"created": len(to_create), "updated": len(to_update), "deactivated": len(stale),
            "active": len(edges.rows)}


def rebuild_clusters(cfg=None) -> dict:
    """Connected components of linked pairs (households left out), written in place.
    Cheap (reads active edges only); also called right after a household decision."""
    cfg = cfg or LinkageSettings.load()
    rows = LinkEdge.objects.filter(active=True).values_list(
        "user_a_id", "user_b_id", "edge_type", "strength", "weight").iterator(chunk_size=5000)
    comps = build_clusters(pair_edges(rows), float(cfg.medium_link_threshold), active_households())
    wanted = {str(c["members"][0]): c for c in comps}
    member_of = {u: key for key, c in wanted.items() for u in c["members"]}
    with transaction.atomic():
        LinkCluster.objects.exclude(key__in=list(wanted)).delete()
        current = {c.key: c for c in LinkCluster.objects.all()}
        for key, c in wanted.items():
            obj = current.get(key)
            fields = {"size": len(c["members"]), "strong_pairs": c["strong_pairs"],
                      "medium_pairs": c["medium_pairs"], "max_pair_score": c["max_pair_score"]}
            if obj is None:
                current[key] = LinkCluster.objects.create(key=key, **fields)
            elif any(getattr(obj, f) != v for f, v in fields.items()):
                for f, v in fields.items():
                    setattr(obj, f, v)
                obj.save()
        existing = dict(LinkClusterMember.objects.values_list("user_id", "cluster__key"))
        drop = [u for u, key in existing.items() if member_of.get(u) != key]
        for i in range(0, len(drop), WRITE_BATCH):
            LinkClusterMember.objects.filter(user_id__in=drop[i:i + WRITE_BATCH]).delete()
        new = [LinkClusterMember(cluster=current[key], user_id=u) for u, key in member_of.items()
               if existing.get(u) != key]
        LinkClusterMember.objects.bulk_create(new, batch_size=WRITE_BATCH)
    return {"clusters": len(wanted), "accounts_in_clusters": len(member_of),
            "largest": max((len(c["members"]) for c in comps), default=0)}


def recompute_linkage(*, today: date | None = None, measure_memory: bool = False) -> dict:
    cfg = LinkageSettings.load()
    today = today or local_today()
    run = LinkageRun.objects.create()
    t0 = time.monotonic()
    if measure_memory:
        tracemalloc.start()
    try:
        edges, ok_types, det_stats = detect_all(cfg, today=today)
        stats = {"today": today.isoformat(), "detectors": det_stats, "edges": _upsert_edges(edges, ok_types)}
        del edges
        stats["clusters"] = rebuild_clusters(cfg)
        stats["seconds"] = round(time.monotonic() - t0, 2)
        if measure_memory:
            stats["peak_mb"] = round(tracemalloc.get_traced_memory()[1] / 1e6, 1)
        run.ok = True
        return stats
    except Exception as exc:
        stats = {"error": type(exc).__name__, "seconds": round(time.monotonic() - t0, 2)}
        raise
    finally:
        if measure_memory:
            tracemalloc.stop()
        run.stats = stats
        run.finished_at = timezone.now()
        run.save(update_fields=["stats", "finished_at", "ok"])
        logger.info("linkage recompute: %s", stats)


def delete_user_linkage(user_id) -> dict:
    """Account anonymisation: drop the account's edges, cluster membership and
    household marks (the evidence would identify the other accounts' relation to it)."""
    edges = (LinkEdge.objects.filter(user_a_id=user_id) | LinkEdge.objects.filter(user_b_id=user_id)).delete()[0]
    members = LinkClusterMember.objects.filter(user_id=user_id).delete()[0]
    marks = (HouseholdMark.objects.filter(user_a_id=user_id)
             | HouseholdMark.objects.filter(user_b_id=user_id)).delete()[0]
    return {"edges": edges, "memberships": members, "households": marks}
