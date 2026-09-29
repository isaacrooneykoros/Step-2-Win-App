from django.apps import AppConfig


class PrivacyConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.privacy"
    verbose_name = "Privacy (consent, retention, data rights)"

    def ready(self):
        from . import signals  # noqa: F401
