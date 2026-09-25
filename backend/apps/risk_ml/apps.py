from django.apps import AppConfig


class RiskMlConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.risk_ml"
    verbose_name = "Risk model (shadow)"

    def ready(self):
        from . import signals  # noqa: F401
