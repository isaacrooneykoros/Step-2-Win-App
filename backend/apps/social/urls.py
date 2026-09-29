from django.urls import path

from . import views

app_name = "social"

urlpatterns = [
    path("me/", views.me, name="me"),
    path("me/reset-code/", views.reset_friend_code, name="reset-code"),
    path("users/search/", views.search_users, name="search-users"),
    path("users/code/<str:code>/", views.user_by_code, name="user-by-code"),
    path("friends/", views.friends_list, name="friends"),
    path("friends/<int:user_id>/", views.remove_friend, name="remove-friend"),
    path("friends/requests/", views.friend_requests, name="friend-requests"),
    path(
        "friends/requests/<int:request_id>/<str:action>/",
        views.friend_request_action,
        name="friend-request-action",
    ),
    path("blocks/", views.blocks, name="blocks"),
    path("blocks/<int:user_id>/", views.unblock, name="unblock"),
    path("reports/", views.report, name="report"),
    path("rankings/friends/", views.rankings_friends, name="rankings-friends"),
    path("rankings/teams/", views.rankings_teams, name="rankings-teams"),
    path("rankings/history/", views.rankings_history, name="rankings-history"),
    path("teams/", views.teams, name="teams"),
    path("teams/discover/", views.teams_discover, name="teams-discover"),
    path("teams/join-by-code/", views.teams_join_by_code, name="teams-join-by-code"),
    path("teams/<int:team_id>/", views.team_detail, name="team-detail"),
    path("teams/<int:team_id>/members/<int:user_id>/<str:action>/", views.team_member_action, name="team-member-action"),
    path("teams/<int:team_id>/<str:action>/", views.team_action, name="team-action"),
    path("feed/", views.feed, name="feed"),
    path("feed/<int:event_id>/react/", views.feed_react, name="feed-react"),
    path("notifications/", views.notifications, name="notifications"),
    path("notifications/summary/", views.notifications_summary, name="notifications-summary"),
    path("notifications/read/", views.notifications_read, name="notifications-read"),
]
