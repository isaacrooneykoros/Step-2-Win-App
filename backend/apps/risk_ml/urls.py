from django.urls import path

from . import views

app_name = "risk_ml"

urlpatterns = [
    path("users/<int:user_id>/scores/", views.user_risk_scores, name="user-risk-scores"),
    path("labels/", views.label_user_day, name="label-user-day"),
    path("models/", views.model_artifacts, name="model-artifacts"),
    path("models/<str:version>/activate/", views.activate_model, name="model-activate"),  # ROLE: owner
]
