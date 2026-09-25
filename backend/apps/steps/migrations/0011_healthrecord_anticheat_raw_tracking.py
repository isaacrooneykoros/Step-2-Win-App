from django.db import migrations, models


class Migration(migrations.Migration):
    """Anti-cheat Phase 0: raw-vs-raw velocity, deferred (unverified) steps, day meta."""

    dependencies = [
        ("steps", "0010_healthrecord_last_client_timestamp"),
    ]

    operations = [
        migrations.AddField(
            model_name="healthrecord",
            name="last_raw_steps",
            field=models.IntegerField(default=0),
        ),
        migrations.AddField(
            model_name="healthrecord",
            name="unverified_steps",
            field=models.IntegerField(default=0),
        ),
        migrations.AddField(
            model_name="healthrecord",
            name="anticheat",
            field=models.JSONField(blank=True, default=dict),
        ),
        migrations.AddField(
            model_name="healthrecord",
            name="verification",
            field=models.JSONField(blank=True, default=dict),
        ),
    ]
