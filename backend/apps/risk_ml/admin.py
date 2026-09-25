from django.contrib import admin

from .models import Label, ModelArtifact, RiskScore, UserDayFeatures


@admin.register(UserDayFeatures)
class UserDayFeaturesAdmin(admin.ModelAdmin):
    list_display = ("user", "date", "feature_version", "steps", "in_paid_challenge", "computed_at")
    list_filter = ("feature_version", "in_paid_challenge")
    raw_id_fields = ("user",)
    date_hierarchy = "date"


@admin.register(RiskScore)
class RiskScoreAdmin(admin.ModelAdmin):
    list_display = ("user", "date", "model_version", "score", "created_at")
    list_filter = ("model_version",)
    raw_id_fields = ("user",)
    date_hierarchy = "date"


@admin.register(Label)
class LabelAdmin(admin.ModelAdmin):
    list_display = ("user", "date_start", "date_end", "label", "source", "source_ref", "created_at")
    list_filter = ("label", "source")
    raw_id_fields = ("user", "created_by")


@admin.register(ModelArtifact)
class ModelArtifactAdmin(admin.ModelAdmin):
    list_display = ("version", "kind", "feature_version", "trained_on", "is_active", "created_at")
    list_filter = ("kind", "is_active", "trained_on")
    exclude = ("payload",)
