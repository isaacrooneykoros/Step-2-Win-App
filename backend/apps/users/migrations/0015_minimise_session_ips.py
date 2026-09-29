"""Data: hash the login network of existing sessions, then clear full IPs that are no
longer needed (ended sessions, expired refresh tokens, rows older than 90 days).
Same rules as the nightly job apps.users.network_privacy.purge_ip_data."""

from datetime import timedelta

from django.conf import settings
from django.db import migrations
from django.utils import timezone


def forwards(apps, schema_editor):
    from apps.users.network_privacy import RETENTION_DAYS, network_hash

    DeviceSession = apps.get_model("users", "DeviceSession")
    now = timezone.now()
    lifetime = (getattr(settings, "SIMPLE_JWT", {}) or {}).get("REFRESH_TOKEN_LIFETIME") or timedelta(days=7)
    old = now - timedelta(days=RETENTION_DAYS)
    for pk, ip, active, last in (DeviceSession.objects.exclude(ip_address__isnull=True)
                                 .values_list("pk", "ip_address", "is_active", "last_active_at")
                                 .iterator(chunk_size=2000)):
        fields = {}
        if last is not None and last < old:
            fields = {"ip_address": None, "network_hash": ""}
        else:
            fields["network_hash"] = network_hash(ip)
            if not active or (last is not None and last < now - lifetime):
                fields["ip_address"] = None
        DeviceSession.objects.filter(pk=pk).update(**fields)


class Migration(migrations.Migration):
    dependencies = [("users", "0014_devicesession_network_hash")]

    operations = [migrations.RunPython(forwards, migrations.RunPython.noop)]
