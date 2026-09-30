from django.apps import AppConfig


class SocialConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.social"
    verbose_name = "Social (friends, teams, weekly rankings)"

    def ready(self):
        from . import signals  # noqa: F401
