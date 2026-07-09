"""
Migration to add production security hardening models.
Includes: DeviceRegistration, StepSession, StepSyncEvent, AntiCheatPolicy,
UserTrustProfile, SuspiciousSessionReview.
"""

from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion
import uuid


class Migration(migrations.Migration):

    dependencies = [
        ('steps', '0001_initial'),  # Adjust to latest existing migration
    ]

    operations = [
        migrations.CreateModel(
            name='DeviceRegistration',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ('device_id', models.CharField(db_index=True, max_length=255)),
                ('device_public_key', models.TextField(blank=True, null=True)),
                ('platform', models.CharField(choices=[('android', 'Android'), ('ios', 'iOS'), ('web', 'Web')], max_length=20)),
                ('app_version', models.CharField(blank=True, max_length=64, null=True)),
                ('is_active', models.BooleanField(default=True)),
                ('trust_level', models.CharField(choices=[('unknown', 'Unknown'), ('new', 'New'), ('low', 'Low'), ('standard', 'Standard'), ('trusted', 'Trusted')], default='unknown', max_length=20)),
                ('first_seen_at', models.DateTimeField(auto_now_add=True)),
                ('last_seen_at', models.DateTimeField(auto_now=True)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('user', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='device_registrations', to=settings.AUTH_USER_MODEL)),
            ],
            options={
                'ordering': ['-last_seen_at'],
            },
        ),
        migrations.CreateModel(
            name='AntiCheatPolicy',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ('version', models.CharField(db_index=True, max_length=64, unique=True)),
                ('is_active', models.BooleanField(db_index=True, default=False)),
                ('description', models.TextField(blank=True, null=True)),
                ('config', models.JSONField(default=dict)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
            ],
            options={
                'verbose_name_plural': 'Anti-cheat policies',
                'ordering': ['-created_at'],
            },
        ),
        migrations.CreateModel(
            name='StepSession',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ('session_token_hash', models.CharField(db_index=True, max_length=255)),
                ('server_nonce', models.CharField(max_length=255)),
                ('status', models.CharField(choices=[('active', 'Active'), ('completed', 'Completed'), ('expired', 'Expired'), ('rejected', 'Rejected')], db_index=True, default='active', max_length=20)),
                ('started_at', models.DateTimeField(auto_now_add=True)),
                ('ended_at', models.DateTimeField(blank=True, null=True)),
                ('expires_at', models.DateTimeField(db_index=True)),
                ('last_sequence_number', models.IntegerField(default=0)),
                ('total_steps', models.IntegerField(default=0)),
                ('accepted_steps', models.IntegerField(default=0)),
                ('rejected_steps', models.IntegerField(default=0)),
                ('avg_walk_probability', models.FloatField(blank=True, null=True)),
                ('avg_shake_probability', models.FloatField(blank=True, null=True)),
                ('avg_risk_score', models.FloatField(blank=True, null=True)),
                ('session_risk_score', models.FloatField(default=0.0)),
                ('trust_adjustment', models.FloatField(default=0.0)),
                ('policy_version', models.CharField(blank=True, max_length=64, null=True)),
                ('ml_model_version', models.CharField(blank=True, max_length=64, null=True)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('device', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='sessions', to='steps.deviceregistration')),
                ('user', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='step_sessions', to=settings.AUTH_USER_MODEL)),
            ],
            options={
                'ordering': ['-created_at'],
            },
        ),
        migrations.CreateModel(
            name='UserTrustProfile',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ('trust_score', models.FloatField(default=50.0)),
                ('trust_tier', models.CharField(choices=[('new', 'New User'), ('low', 'Low Trust'), ('standard', 'Standard'), ('trusted', 'Trusted'), ('restricted', 'Restricted')], default='new', max_length=20)),
                ('verified_sessions_count', models.IntegerField(default=0)),
                ('suspicious_sessions_count', models.IntegerField(default=0)),
                ('replay_attempts_count', models.IntegerField(default=0)),
                ('total_accepted_steps', models.IntegerField(default=0)),
                ('total_rejected_steps', models.IntegerField(default=0)),
                ('last_suspicious_at', models.DateTimeField(blank=True, null=True)),
                ('last_verified_at', models.DateTimeField(blank=True, null=True)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('user', models.OneToOneField(on_delete=django.db.models.deletion.CASCADE, related_name='trust_profile', to=settings.AUTH_USER_MODEL)),
            ],
            options={
                'ordering': ['-created_at'],
            },
        ),
        migrations.CreateModel(
            name='StepSyncEvent',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ('client_event_id', models.CharField(db_index=True, max_length=255)),
                ('sequence_number', models.IntegerField(default=0)),
                ('timestamp_client', models.DateTimeField(blank=True, null=True)),
                ('timestamp_server', models.DateTimeField(auto_now_add=True)),
                ('payload_hash', models.CharField(db_index=True, max_length=255)),
                ('signature_valid', models.BooleanField(default=False)),
                ('replay_detected', models.BooleanField(db_index=True, default=False)),
                ('steps_delta', models.IntegerField(default=0)),
                ('raw_steps_total', models.IntegerField(blank=True, null=True)),
                ('ml_motion_label', models.CharField(blank=True, max_length=20, null=True)),
                ('ml_walk_probability', models.FloatField(blank=True, null=True)),
                ('ml_shake_probability', models.FloatField(blank=True, null=True)),
                ('ml_model_version', models.CharField(blank=True, max_length=64, null=True)),
                ('interval_risk_score', models.FloatField(default=0.0)),
                ('accepted', models.BooleanField(db_index=True, default=True)),
                ('rejection_reason', models.CharField(blank=True, max_length=255, null=True)),
                ('raw_payload', models.JSONField(blank=True, null=True)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('device', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='sync_events', to='steps.deviceregistration')),
                ('session', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='events', to='steps.stepsession')),
                ('user', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='sync_events', to=settings.AUTH_USER_MODEL)),
            ],
            options={
                'ordering': ['-created_at'],
            },
        ),
        migrations.CreateModel(
            name='SuspiciousSessionReview',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ('risk_score', models.FloatField()),
                ('reason_summary', models.TextField()),
                ('risk_hits', models.JSONField(default=list)),
                ('status', models.CharField(choices=[('pending', 'Pending Review'), ('reviewed', 'Reviewed'), ('approved', 'Approved'), ('rejected', 'Rejected'), ('escalated', 'Escalated')], db_index=True, default='pending', max_length=20)),
                ('reviewed_at', models.DateTimeField(blank=True, null=True)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('reviewer', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='reviewed_sessions', to=settings.AUTH_USER_MODEL)),
                ('session', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='reviews', to='steps.stepsession')),
                ('user', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='suspicious_session_reviews', to=settings.AUTH_USER_MODEL)),
            ],
            options={
                'ordering': ['-created_at'],
            },
        ),
        # Add unique constraints
        migrations.AddConstraint(
            model_name='deviceregistration',
            constraint=models.UniqueConstraint(fields=['user', 'device_id'], name='device_registration_unique'),
        ),
        migrations.AddIndex(
            model_name='deviceregistration',
            index=models.Index(fields=['user', 'is_active'], name='device_reg_user_active_idx'),
        ),
        migrations.AddConstraint(
            model_name='stepsession',
            constraint=models.UniqueConstraint(fields=['user', 'session_token_hash'], name='session_unique_token_hash'),
        ),
        migrations.AddIndex(
            model_name='stepsession',
            index=models.Index(fields=['user', 'status'], name='session_user_status_idx'),
        ),
        migrations.AddIndex(
            model_name='stepsession',
            index=models.Index(fields=['user', '-created_at'], name='session_user_created_idx'),
        ),
        migrations.AddIndex(
            model_name='stepsession',
            index=models.Index(fields=['expires_at', 'status'], name='session_expiry_status_idx'),
        ),
        migrations.AddConstraint(
            model_name='stepsyncevent',
            constraint=models.UniqueConstraint(fields=['user', 'client_event_id'], name='syncevent_unique_user_event'),
        ),
        migrations.AddIndex(
            model_name='stepsyncevent',
            index=models.Index(fields=['session', 'sequence_number'], name='syncevent_session_sq_idx'),
        ),
        migrations.AddIndex(
            model_name='stepsyncevent',
            index=models.Index(fields=['user', 'created_at'], name='syncevent_user_created_idx'),
        ),
        migrations.AddIndex(
            model_name='stepsyncevent',
            index=models.Index(fields=['payload_hash'], name='syncevent_hash_idx'),
        ),
        migrations.AddIndex(
            model_name='suspicioussessionreview',
            index=models.Index(fields=['status', '-created_at'], name='review_status_created_idx'),
        ),
        migrations.AddIndex(
            model_name='suspicioussessionreview',
            index=models.Index(fields=['user', '-created_at'], name='review_user_created_idx'),
        ),
    ]
