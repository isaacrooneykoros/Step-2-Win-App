"""Remove plaintext session tokens from stored sync payloads.

StepSyncEvent.raw_payload used to keep the whole request body, including the
session_token (a bearer secret for step uploads). New rows are redacted before
saving (steps.views._redact_payload); this migration redacts the existing rows.
"""

from django.db import migrations

REDACTED = "[redacted]"
SECRET_KEYS = ("session_token",)
BATCH = 500


def redact_existing(apps, schema_editor):
    StepSyncEvent = apps.get_model("steps", "StepSyncEvent")
    qs = StepSyncEvent.objects.filter(raw_payload__isnull=False).only("id", "raw_payload")
    pending = []
    for event in qs.iterator(chunk_size=BATCH):
        payload = event.raw_payload
        if not isinstance(payload, dict):
            continue
        changed = False
        for key in SECRET_KEYS:
            if payload.get(key) not in (None, "", REDACTED):
                payload[key] = REDACTED
                changed = True
        if changed:
            event.raw_payload = payload
            pending.append(event)
        if len(pending) >= BATCH:
            StepSyncEvent.objects.bulk_update(pending, ["raw_payload"])
            pending = []
    if pending:
        StepSyncEvent.objects.bulk_update(pending, ["raw_payload"])


class Migration(migrations.Migration):
    dependencies = [
        ("steps", "0011_healthrecord_anticheat_raw_tracking"),
    ]

    operations = [
        migrations.RunPython(redact_existing, migrations.RunPython.noop),
    ]
