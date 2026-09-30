"""Friends: search, requests (send / accept / decline / cancel), remove, block.

Request state machine (FriendRequest.status):

    pending --accept (recipient)--> accepted   (two Friendship rows are created)
    pending --decline (recipient)--> declined  (the sender is not told)
    pending --cancel (sender)-----> cancelled
    pending --block (either side)-> cancelled

Sending a request to someone who already asked you accepts theirs (mutual intent).
A blocked pair can't find, request or see each other anywhere; to the blocked person
the blocker looks exactly like an account that doesn't exist.
"""

from __future__ import annotations

from datetime import timedelta

from django.contrib.auth import get_user_model
from django.db import IntegrityError, transaction
from django.db.models import Q
from django.utils import timezone

from .common import (SocialError, get_profile, hidden_user_ids,
                     is_blocked_between, is_visible_account,
                     require_social_enabled)
from .models import Block, FriendRequest, Friendship, SocialNotification, SocialProfile
from .notify import notify

User = get_user_model()

SEARCH_MIN_CHARS = 3
SEARCH_MAX_RESULTS = 10
MAX_PENDING_OUTGOING = 50
# After a decline the sender waits this long before asking the same person again.
REREQUEST_COOLDOWN = timedelta(days=7)

NOT_FOUND = SocialError("not_found", "We couldn't find that person.", 404)


def friend_ids(user_id: int) -> set[int]:
    return set(Friendship.objects.filter(user_id=user_id).values_list("friend_id", flat=True))


def are_friends(a_id: int, b_id: int) -> bool:
    return Friendship.objects.filter(user_id=a_id, friend_id=b_id).exists()


def has_mutual_friend(a_id: int, b_id: int) -> bool:
    return Friendship.objects.filter(
        user_id=a_id,
        friend_id__in=Friendship.objects.filter(user_id=b_id).values("friend_id"),
    ).exists()


def relationship(me, other_id: int) -> str:
    """'self' | 'friends' | 'outgoing' | 'incoming' | 'blocked' | 'none'.

    'blocked' only when *I* blocked them; if they blocked me the caller must treat
    them as not found (see ``visible_to``).
    """
    if other_id == me.id:
        return "self"
    if Block.objects.filter(blocker_id=me.id, blocked_id=other_id).exists():
        return "blocked"
    if are_friends(me.id, other_id):
        return "friends"
    pending = FriendRequest.objects.filter(
        Q(from_user_id=me.id, to_user_id=other_id) | Q(from_user_id=other_id, to_user_id=me.id),
        status=FriendRequest.PENDING,
    ).values_list("from_user_id", flat=True).first()
    if pending is not None:
        return "outgoing" if pending == me.id else "incoming"
    return "none"


def discoverable_by(target, target_profile: SocialProfile | None, searcher_id: int) -> bool:
    """Can ``searcher`` find ``target`` by username search? (Codes always work.)"""
    mode = target_profile.discoverability if target_profile else SocialProfile.DISCOVER_EVERYONE
    if mode == SocialProfile.DISCOVER_EVERYONE:
        return True
    if mode == SocialProfile.DISCOVER_NOBODY:
        return are_friends(target.id, searcher_id)
    return are_friends(target.id, searcher_id) or has_mutual_friend(target.id, searcher_id)


def _eligible_users():
    return User.objects.filter(is_active=True, deleted_at__isnull=True, is_staff=False)


def search(me, query: str) -> list:
    """Username search. At least 3 characters, at most 10 results, exact match first.

    Prefix match only (no substring scan), respects each person's "who can find me"
    setting, and never returns blocked pairs, staff or deleted accounts.
    """
    require_social_enabled()
    q = (query or "").strip().lstrip("@")
    if len(q) < SEARCH_MIN_CHARS:
        raise SocialError("query_too_short", f"Type at least {SEARCH_MIN_CHARS} characters.", 400)
    q = q[:150]
    hidden = hidden_user_ids(me.id) | {me.id}
    candidates = list(
        _eligible_users()
        .filter(username__istartswith=q)
        .exclude(id__in=hidden)
        .select_related("social_profile")
        .order_by("username")[: SEARCH_MAX_RESULTS * 3]
    )
    candidates.sort(key=lambda u: (u.username.lower() != q.lower(), len(u.username), u.username.lower()))
    results = []
    for u in candidates:
        try:
            profile = u.social_profile
        except SocialProfile.DoesNotExist:
            profile = None
        if not discoverable_by(u, profile, me.id):
            continue
        results.append(u)
        if len(results) >= SEARCH_MAX_RESULTS:
            break
    return results


def find_by_code(me, code: str):
    require_social_enabled()
    code = (code or "").strip().upper()
    if not code or len(code) > 12:
        raise NOT_FOUND
    profile = SocialProfile.objects.select_related("user").filter(friend_code=code).first()
    if not profile or not is_visible_account(profile.user) or profile.user.is_staff:
        raise NOT_FOUND
    if profile.user_id != me.id and profile.user_id in hidden_user_ids(me.id):
        raise NOT_FOUND
    return profile.user


def _check_friend_cap(user_id: int, cap: int, *, mine: bool):
    if Friendship.objects.filter(user_id=user_id).count() >= cap:
        if mine:
            raise SocialError("friend_limit", f"You've reached the limit of {cap} friends.", 409)
        raise SocialError("their_friend_limit", "This person can't add more friends right now.", 409)


def send_request(me, target, *, via: str = "search") -> tuple[str, FriendRequest | None]:
    """Returns ("sent" | "already_sent" | "accepted", request)."""
    settings_ = require_social_enabled()
    if target is None or not is_visible_account(target) or target.is_staff:
        raise NOT_FOUND
    if target.id == me.id:
        raise SocialError("self", "That's you.", 400)
    if is_blocked_between(me.id, target.id):
        raise NOT_FOUND
    if via == "search":
        try:
            profile = target.social_profile
        except SocialProfile.DoesNotExist:
            profile = None
        if not discoverable_by(target, profile, me.id):
            raise NOT_FOUND
    if are_friends(me.id, target.id):
        raise SocialError("already_friends", "You're already friends.", 409)

    incoming = FriendRequest.objects.filter(
        from_user_id=target.id, to_user_id=me.id, status=FriendRequest.PENDING
    ).first()
    if incoming:
        accept(me, incoming.id)
        incoming.refresh_from_db()
        return "accepted", incoming

    existing = FriendRequest.objects.filter(
        from_user_id=me.id, to_user_id=target.id, status=FriendRequest.PENDING
    ).first()
    if existing:
        return "already_sent", existing

    now = timezone.now()
    if FriendRequest.objects.filter(
        from_user_id=me.id, to_user_id=target.id, status=FriendRequest.DECLINED,
        responded_at__gte=now - REREQUEST_COOLDOWN,
    ).exists():
        raise SocialError("recently_requested", "You asked this person recently. Try again in a few days.", 429)
    if FriendRequest.objects.filter(from_user_id=me.id, created_at__gte=now - timedelta(hours=24)).count() >= settings_.friend_requests_per_day:
        raise SocialError("daily_limit", "You've sent a lot of requests today. Try again tomorrow.", 429)
    if FriendRequest.objects.filter(from_user_id=me.id, status=FriendRequest.PENDING).count() >= MAX_PENDING_OUTGOING:
        raise SocialError("pending_limit", "You have many requests waiting. Cancel some first.", 429)
    _check_friend_cap(me.id, settings_.max_friends, mine=True)

    get_profile(me)  # make sure the sender has a code to share back
    try:
        with transaction.atomic():
            req = FriendRequest.objects.create(from_user=me, to_user=target, via=via[:12])
    except IntegrityError:
        existing = FriendRequest.objects.filter(
            from_user_id=me.id, to_user_id=target.id, status=FriendRequest.PENDING
        ).first()
        return "already_sent", existing
    notify(target, SocialNotification.FRIEND_REQUEST, actor=me, data={"request_id": req.id})
    return "sent", req


def _pending_for(request_id: int, **who) -> FriendRequest:
    req = (
        FriendRequest.objects.select_for_update()
        .filter(id=request_id, status=FriendRequest.PENDING, **who)
        .first()
    )
    if not req:
        raise SocialError("request_not_found", "This request is no longer open.", 404)
    return req


def accept(me, request_id: int) -> FriendRequest:
    settings_ = require_social_enabled()
    with transaction.atomic():
        req = _pending_for(request_id, to_user_id=me.id)
        if is_blocked_between(req.from_user_id, me.id) or not is_visible_account(req.from_user):
            req.status = FriendRequest.CANCELLED
            req.responded_at = timezone.now()
            req.save(update_fields=["status", "responded_at"])
            raise SocialError("request_not_found", "This request is no longer open.", 404)
        _check_friend_cap(me.id, settings_.max_friends, mine=True)
        _check_friend_cap(req.from_user_id, settings_.max_friends, mine=False)
        Friendship.objects.get_or_create(user_id=me.id, friend_id=req.from_user_id)
        Friendship.objects.get_or_create(user_id=req.from_user_id, friend_id=me.id)
        req.status = FriendRequest.ACCEPTED
        req.responded_at = timezone.now()
        req.save(update_fields=["status", "responded_at"])
        # Any request the other way round is now moot.
        FriendRequest.objects.filter(
            from_user_id=me.id, to_user_id=req.from_user_id, status=FriendRequest.PENDING
        ).update(status=FriendRequest.CANCELLED, responded_at=timezone.now())
        SocialNotification.objects.filter(
            recipient=me, kind=SocialNotification.FRIEND_REQUEST, actor_id=req.from_user_id, read_at__isnull=True
        ).update(read_at=timezone.now())
    notify(req.from_user, SocialNotification.FRIEND_ACCEPTED, actor=me)
    return req


def decline(me, request_id: int) -> FriendRequest:
    require_social_enabled()
    with transaction.atomic():
        req = _pending_for(request_id, to_user_id=me.id)
        req.status = FriendRequest.DECLINED
        req.responded_at = timezone.now()
        req.save(update_fields=["status", "responded_at"])
        SocialNotification.objects.filter(
            recipient=me, kind=SocialNotification.FRIEND_REQUEST, actor_id=req.from_user_id, read_at__isnull=True
        ).update(read_at=timezone.now())
    return req


def cancel(me, request_id: int) -> FriendRequest:
    require_social_enabled()
    with transaction.atomic():
        req = _pending_for(request_id, from_user_id=me.id)
        req.status = FriendRequest.CANCELLED
        req.responded_at = timezone.now()
        req.save(update_fields=["status", "responded_at"])
        # Take the notice back so it doesn't linger in their inbox.
        SocialNotification.objects.filter(
            recipient_id=req.to_user_id, kind=SocialNotification.FRIEND_REQUEST, actor=me, read_at__isnull=True
        ).delete()
    return req


def remove_friend(me, other_id: int) -> bool:
    require_social_enabled()
    deleted, _ = Friendship.objects.filter(
        Q(user_id=me.id, friend_id=other_id) | Q(user_id=other_id, friend_id=me.id)
    ).delete()
    return deleted > 0


def block(me, other_id: int) -> None:
    """Block: ends the friendship, cancels requests both ways, hides both from each other."""
    if other_id == me.id:
        raise SocialError("self", "You can't block yourself.", 400)
    other = User.objects.filter(id=other_id).first()
    if other is None:
        raise NOT_FOUND
    now = timezone.now()
    with transaction.atomic():
        Block.objects.get_or_create(blocker_id=me.id, blocked_id=other_id)
        Friendship.objects.filter(
            Q(user_id=me.id, friend_id=other_id) | Q(user_id=other_id, friend_id=me.id)
        ).delete()
        FriendRequest.objects.filter(
            Q(from_user_id=me.id, to_user_id=other_id) | Q(from_user_id=other_id, to_user_id=me.id),
            status=FriendRequest.PENDING,
        ).update(status=FriendRequest.CANCELLED, responded_at=now)
        SocialNotification.objects.filter(
            Q(recipient_id=me.id, actor_id=other_id) | Q(recipient_id=other_id, actor_id=me.id)
        ).delete()


def unblock(me, other_id: int) -> bool:
    deleted, _ = Block.objects.filter(blocker_id=me.id, blocked_id=other_id).delete()
    return deleted > 0
