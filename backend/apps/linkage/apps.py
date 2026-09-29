from django.apps import AppConfig


class LinkageConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.linkage"
    verbose_name = "Account linkage"

    def ready(self):
        from . import signals  # noqa: F401
