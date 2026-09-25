import logging

from django.apps import AppConfig

logger = logging.getLogger("apps.core.realtime")


class CoreConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.core"
    label = "core"
    verbose_name = "Core"

    def ready(self):
        from apps.core.realtime import channel_layer_name, realtime_enabled
        from apps.core.signals import connect_signals

        if not realtime_enabled():
            logger.info("Admin realtime: disabled (REALTIME_ENABLED=False).")
            return
        wired = connect_signals()
        logger.info(
            "Admin realtime: channel layer=%s, %d models wired for admin events.",
            channel_layer_name(),
            len(wired),
        )
