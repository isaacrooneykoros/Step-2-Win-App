"""
Pair classification and clustering (pure Python, no database access).

A pair of accounts is **linked** (counts for clusters and holds) when:
  - it has at least one STRONG edge (same phone, same payout number/account), or
  - its MEDIUM edges add up to ``medium_threshold`` (default 1.0) AND come from at
    least two different kinds of evidence (e.g. walked together + twin step curves).
WEAK edges (near-sequential numbers, same home network) never link a pair; they are
shown to reviewers as context only.

Clusters are the connected components of linked pairs, leaving out pairs staff marked
as a known household.
"""

from __future__ import annotations

from collections import defaultdict

from .models import STRENGTH_MEDIUM, STRENGTH_STRONG, STRENGTH_WEAK


def summarize_pair(edges, medium_threshold: float = 1.0) -> dict:
    """``edges``: iterable of (edge_type, strength, weight)."""
    strong, medium, weak = [], {}, []
    for etype, strength, weight in edges:
        if strength == STRENGTH_STRONG:
            strong.append(etype)
        elif strength == STRENGTH_MEDIUM:
            medium[etype] = max(weight, medium.get(etype, 0.0))
        elif strength == STRENGTH_WEAK:
            weak.append((etype, weight))
    medium_sum = round(sum(medium.values()), 3)
    medium_link = len(medium) >= 2 and medium_sum >= medium_threshold - 1e-9
    total = len(strong) * 1.0 + medium_sum + sum(w for _, w in weak)
    return {
        "linked": bool(strong) or medium_link,
        "strong": bool(strong),
        "strong_types": sorted(set(strong)),
        "medium_types": sorted(medium),
        "medium_sum": medium_sum,
        "weak_types": sorted({t for t, _ in weak}),
        "score": round(min(1.0, total), 3),
    }


def pair_edges(rows) -> dict:
    """rows: (user_a, user_b, edge_type, strength, weight) -> {(a, b): [(type, strength, weight)]}"""
    out = defaultdict(list)
    for a, b, etype, strength, weight in rows:
        key = (a, b) if a < b else (b, a)
        out[key].append((etype, strength, weight))
    return out


class UnionFind:
    def __init__(self):
        self.parent: dict = {}

    def find(self, x):
        parent = self.parent
        parent.setdefault(x, x)
        root = x
        while parent[root] != root:
            root = parent[root]
        while parent[x] != root:
            parent[x], x = root, parent[x]
        return root

    def union(self, a, b):
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            if str(ra) < str(rb):
                self.parent[rb] = ra
            else:
                self.parent[ra] = rb

    def groups(self) -> dict:
        out = defaultdict(set)
        for x in list(self.parent):
            out[self.find(x)].add(x)
        return out


def clusters(pairs: dict, medium_threshold: float = 1.0, households=frozenset()) -> list[dict]:
    """``pairs``: output of pair_edges. Returns [{members, strong_pairs, medium_pairs,
    max_pair_score}] for components of 2+ accounts, largest first."""
    uf = UnionFind()
    linked = {}
    for pair, edges in pairs.items():
        if pair in households:
            continue
        summary = summarize_pair(edges, medium_threshold)
        if summary["linked"]:
            uf.union(*pair)
            linked[pair] = summary
    comps = []
    for members in uf.groups().values():
        if len(members) < 2:
            continue
        inside = [s for p, s in linked.items() if p[0] in members]
        comps.append({
            "members": sorted(members),
            "strong_pairs": sum(1 for s in inside if s["strong"]),
            "medium_pairs": sum(1 for s in inside if not s["strong"]),
            "max_pair_score": max((s["score"] for s in inside), default=0.0),
        })
    comps.sort(key=lambda c: (-len(c["members"]), c["members"][0]))
    return comps
