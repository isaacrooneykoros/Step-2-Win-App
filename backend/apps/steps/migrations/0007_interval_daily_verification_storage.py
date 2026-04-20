from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ('steps', '0006_alter_healthrecord_source_device_sensor'),
    ]

    operations = [
        migrations.CreateModel(
            name='IntervalVerificationResult',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('date', models.DateField(db_index=True)),
                ('interval_start', models.DateTimeField()),
                ('interval_end', models.DateTimeField()),
                ('source_platform', models.CharField(blank=True, max_length=40)),
                ('source_device', models.CharField(blank=True, max_length=80)),
                ('source_app', models.CharField(blank=True, max_length=80)),
                ('raw_steps', models.IntegerField(default=0)),
                ('normalized_steps', models.IntegerField(default=0)),
                ('verified_steps', models.IntegerField(default=0)),
                ('risk_score', models.FloatField(default=0.0)),
                ('confidence_score', models.FloatField(default=0.0)),
                ('verification_status', models.CharField(default='accept', max_length=20)),
                ('review_state', models.CharField(default='none', max_length=20)),
                ('payout_state', models.CharField(default='eligible', max_length=20)),
                ('rule_hits_json', models.JSONField(default=list)),
                ('explainability_json', models.JSONField(default=dict)),
                ('trust_score_before', models.IntegerField(default=100)),
                ('trust_score_after', models.IntegerField(default=100)),
                ('mode', models.CharField(choices=[('active', 'Active'), ('shadow', 'Shadow')], default='active', max_length=12)),
                ('verification_version', models.CharField(default='v2', max_length=32)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('user', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='interval_verification_results', to=settings.AUTH_USER_MODEL)),
            ],
            options={
                'ordering': ['-created_at'],
            },
        ),
        migrations.CreateModel(
            name='DailyVerificationSummary',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('date', models.DateField(db_index=True)),
                ('raw_steps_total', models.IntegerField(default=0)),
                ('verified_steps_total', models.IntegerField(default=0)),
                ('suspicious_steps_total', models.IntegerField(default=0)),
                ('interval_count', models.IntegerField(default=0)),
                ('accepted_count', models.IntegerField(default=0)),
                ('review_count', models.IntegerField(default=0)),
                ('rejected_count', models.IntegerField(default=0)),
                ('risk_score', models.FloatField(default=0.0)),
                ('review_state', models.CharField(default='none', max_length=20)),
                ('payout_state', models.CharField(default='eligible', max_length=20)),
                ('trust_score_before', models.IntegerField(default=100)),
                ('trust_score_after', models.IntegerField(default=100)),
                ('mode', models.CharField(choices=[('active', 'Active'), ('shadow', 'Shadow')], default='active', max_length=12)),
                ('verification_version', models.CharField(default='v2', max_length=32)),
                ('audit_snapshot', models.JSONField(default=dict)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('user', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='daily_verification_summaries', to=settings.AUTH_USER_MODEL)),
            ],
            options={
                'ordering': ['-date', '-updated_at'],
                'unique_together': {('user', 'date', 'mode')},
            },
        ),
        migrations.AddIndex(
            model_name='intervalverificationresult',
            index=models.Index(fields=['user', 'date', 'mode'], name='steps_int_usr_mode_idx'),
        ),
        migrations.AddIndex(
            model_name='intervalverificationresult',
            index=models.Index(fields=['review_state', 'payout_state', '-created_at'], name='steps_int_rev_pay_idx'),
        ),
        migrations.AddIndex(
            model_name='intervalverificationresult',
            index=models.Index(fields=['verification_status', '-created_at'], name='steps_int_status_idx'),
        ),
        migrations.AddIndex(
            model_name='dailyverificationsummary',
            index=models.Index(fields=['user', 'date', 'mode'], name='steps_day_usr_mode_idx'),
        ),
        migrations.AddIndex(
            model_name='dailyverificationsummary',
            index=models.Index(fields=['review_state', 'payout_state', '-updated_at'], name='steps_day_rev_pay_idx'),
        ),
    ]
