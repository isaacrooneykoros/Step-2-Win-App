"""
Risk model (SHADOW MODE) storage.

Nothing in this app changes steps, challenge standings, trust or money. It stores
derived features, scores and explanations, and human labels for future training.

- UserDayFeatures: derived, aggregated features per user-day (no coordinates, no phone
  numbers). Deleted when the account is anonymised (see signals.py).
- RiskScore: shadow score 0-1 + plain-English reasons per user-day and model version.
  Deleted with the features on anonymisation.
- Label: a human (or synthetic) judgement on a user-day or a window. Synthetic labels
  are kept apart by ``source`` and never used for training unless explicitly requested
  for a dry run.
- ModelArtifact: an exported model (JSON) + its model card. Trained offline only.
"""

from django.conf import settings
from django.db import models


class UserDayFeatures(models.Model):
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE,
                             related_name="risk_day_features")
    date = models.DateField()
    feature_version = models.CharField(max_length=16)
    # A few typed columns for querying; everything else lives in ``features``.
    steps = models.IntegerField(default=0)
    in_paid_challenge = models.BooleanField(default=False)
    features = models.JSONField(default=dict)
    computed_at = models.DateTimeField(auto_now=True)

    class Meta:
        unique_together = [("user", "date", "feature_version")]
        indexes = [
            models.Index(fields=["date", "feature_version"], name="riskml_feat_date_idx"),
            models.Index(fields=["user", "-date"], name="riskml_feat_user_idx"),
        ]
        ordering = ["-date"]

    def __str__(self):
        return f"features {self.user_id} {self.date} {self.feature_version}"


class RiskScore(models.Model):
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE,
                             related_name="risk_scores")
    date = models.DateField()
    model_version = models.CharField(max_length=64)
    feature_version = models.CharField(max_length=16)
    score = models.FloatField()
    # [{"code", "feature", "value", "text", "contribution"}] strongest first.
    explanations = models.JSONField(default=list)
    # Non-scoring context shown next to the score (money at stake, deadline, ...).
    context = models.JSONField(default=dict)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        unique_together = [("user", "date", "model_version")]
        indexes = [
            models.Index(fields=["user", "-date"], name="riskml_score_user_idx"),
            models.Index(fields=["date", "-score"], name="riskml_score_date_idx"),
        ]
        ordering = ["-date", "-score"]

    def __str__(self):
        return f"risk {self.user_id} {self.date} {self.score:.2f} ({self.model_version})"


class Label(models.Model):
    LABEL_CHEAT = "cheat"
    LABEL_HONEST = "honest"
    LABEL_UNSURE = "unsure"
    LABEL_CHOICES = [(LABEL_CHEAT, "Cheat"), (LABEL_HONEST, "Honest"), (LABEL_UNSURE, "Unsure")]

    SOURCE_PAYOUT_REVIEW = "admin_payout_review"
    SOURCE_FLAG_ACTION = "admin_flag_action"
    SOURCE_ADMIN_MANUAL = "admin_manual"
    SOURCE_SYNTHETIC = "synthetic"
    SOURCE_CHOICES = [
        (SOURCE_PAYOUT_REVIEW, "Admin payout review"),
        (SOURCE_FLAG_ACTION, "Admin action on an anti-cheat flag"),
        (SOURCE_ADMIN_MANUAL, "Admin labelled the day directly"),
        (SOURCE_SYNTHETIC, "Synthetic (tests / evaluation only)"),
    ]
    REAL_SOURCES = (SOURCE_PAYOUT_REVIEW, SOURCE_FLAG_ACTION, SOURCE_ADMIN_MANUAL)

    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE,
                             related_name="risk_labels")
    date_start = models.DateField()
    date_end = models.DateField()
    label = models.CharField(max_length=10, choices=LABEL_CHOICES)
    source = models.CharField(max_length=24, choices=SOURCE_CHOICES)
    # Identifies what produced the label ("flag:123", "heldpayout:9", "admin:4") so
    # harvesting is idempotent and a later decision replaces an earlier one.
    source_ref = models.CharField(max_length=64)
    notes = models.TextField(blank=True, default="")
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True,
                                   blank=True, related_name="risk_labels_created")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        unique_together = [("user", "source", "source_ref", "date_start", "date_end")]
        indexes = [
            models.Index(fields=["source", "label"], name="riskml_label_src_idx"),
            models.Index(fields=["user", "date_start"], name="riskml_label_user_idx"),
        ]
        ordering = ["-date_start"]

    def __str__(self):
        return f"{self.label} {self.user_id} {self.date_start}..{self.date_end} ({self.source})"


class ModelArtifact(models.Model):
    KIND_ANOMALY = "anomaly"
    KIND_SUPERVISED = "supervised"
    KIND_CHOICES = [(KIND_ANOMALY, "Anomaly (unsupervised)"), (KIND_SUPERVISED, "Supervised")]

    kind = models.CharField(max_length=16, choices=KIND_CHOICES)
    version = models.CharField(max_length=64, unique=True)
    feature_version = models.CharField(max_length=16)
    payload = models.JSONField()
    metrics = models.JSONField(default=dict)
    model_card = models.TextField(blank=True, default="")
    # "real" or "synthetic": what the model was fit on. Synthetic artifacts can't be activated.
    trained_on = models.CharField(max_length=16, default="real")
    is_active = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]
        indexes = [models.Index(fields=["kind", "is_active"], name="riskml_artifact_active_idx")]

    def __str__(self):
        return f"{self.kind} {self.version}{' (active)' if self.is_active else ''}"
