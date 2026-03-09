from django.urls import path
from . import views

app_name = 'challenges'

urlpatterns = [
    path('', views.ChallengeListView.as_view(), name='list'),
    path('lobby/', views.public_lobby, name='lobby'),
    path('lobby/<int:pk>/', views.challenge_lobby_card, name='lobby_card'),
    path('create/', views.create_challenge, name='create'),
    path('join/', views.join_challenge, name='join'),
    path('my-challenges/', views.MyChallengesView.as_view(), name='my_challenges'),
    path('my-results/', views.my_recent_results, name='my_recent_results'),
    path('<int:pk>/', views.ChallengeDetailView.as_view(), name='detail'),
    path('<int:pk>/leaderboard/', views.leaderboard, name='leaderboard'),
    path('<int:pk>/spectate/', views.spectator_leaderboard, name='spectator_leaderboard'),
    path('<int:pk>/stats/', views.challenge_stats, name='stats'),
    path('<int:pk>/results/', views.challenge_results, name='results'),
    path('<int:pk>/leave/', views.leave_challenge, name='leave'),
    path('<int:pk>/feature/', views.feature_challenge, name='feature'),
    path('<int:pk>/rematch/', views.rematch_challenge, name='rematch'),
    path('<int:pk>/chat/', views.challenge_chat, name='chat'),
    path('<int:pk>/social-stats/', views.challenge_social_stats, name='social_stats'),
]
