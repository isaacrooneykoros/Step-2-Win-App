"""Account deletion hook (called from apps.users.account_deletion.delete_account,
inside its transaction). Removes the person's social footprint:

* friendships, friend requests and blocks (both directions), friend code / profile;
* team memberships: an owner's team passes to the longest-standing admin (else the
  longest-standing member); a team left empty is deleted;
* feed items, reactions, notifications (sent and received);
* weekly step totals (derived from the health records deleted alongside).

Kept: reports about the person (moderation integrity) and reports they filed, with the
reporter link removed.
"""

from __future__ import annotations

from django.db.models import Q

from .models import (Block, FeedEvent, FeedReaction, FriendRequest, Friendship,
                     SocialNotification, SocialProfile, SocialReport, Team,
                     TeamMembership, WeeklyStepTotal)


def delete_social_data(user) -> dict:
    uid = user.pk
    counts = {}
    counts["friendships"] = Friendship.objects.filter(Q(user_id=uid) | Q(friend_id=uid)).delete()[0]
    counts["friend_requests"] = FriendRequest.objects.filter(Q(from_user_id=uid) | Q(to_user_id=uid)).delete()[0]
    counts["blocks"] = Block.objects.filter(Q(blocker_id=uid) | Q(blocked_id=uid)).delete()[0]
    counts["feed_reactions"] = FeedReaction.objects.filter(user_id=uid).delete()[0]
    counts["feed_events"] = FeedEvent.objects.filter(user_id=uid).delete()[0]
    counts["social_notifications"] = SocialNotification.objects.filter(Q(recipient_id=uid) | Q(actor_id=uid)).delete()[0]
    counts["weekly_totals"] = WeeklyStepTotal.objects.filter(user_id=uid).delete()[0]
    SocialReport.objects.filter(reporter_id=uid).update(reporter=None)

    teams_touched = []
    for m in list(TeamMembership.objects.filter(user_id=uid).select_related("team")):
        team = m.team
        was_owner = m.role == TeamMembership.OWNER
        m.delete()
        rest = TeamMembership.objects.filter(team=team)
        if not rest.exists():
            team.delete()
            continue
        if was_owner:
            heir = (
                rest.filter(role=TeamMembership.ADMIN).order_by("joined_at", "id").first()
                or rest.order_by("joined_at", "id").first()
            )
            heir.role = TeamMembership.OWNER
            heir.save(update_fields=["role"])
        team.member_count = rest.count()
        team.save(update_fields=["member_count", "updated_at"])
        teams_touched.append(team.id)
    counts["team_memberships"] = len(teams_touched)
    counts["social_profile"] = SocialProfile.objects.filter(user_id=uid).delete()[0]

    if teams_touched:
        from .common import current_week_start
        from .rankings import refresh_team_totals

        refresh_team_totals(current_week_start(), Team.objects.filter(id__in=teams_touched).values_list("id", flat=True))
    return counts
