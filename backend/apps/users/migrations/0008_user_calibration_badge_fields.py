from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('users', '0007_user_stride_length_cm_user_weight_kg'),
    ]

    operations = [
        migrations.AddField(
            model_name='user',
            name='calibration_quality',
            field=models.CharField(
                blank=True,
                choices=[('excellent', 'Excellent'), ('good', 'Good'), ('noisy', 'Noisy')],
                help_text='Last stride calibration quality from two-pass variance check.',
                max_length=16,
                null=True,
            ),
        ),
        migrations.AddField(
            model_name='user',
            name='calibration_variance_pct',
            field=models.FloatField(
                blank=True,
                help_text='Pass-to-pass stride variance percentage from last calibration.',
                null=True,
            ),
        ),
        migrations.AddField(
            model_name='user',
            name='last_calibrated_at',
            field=models.DateTimeField(
                blank=True,
                help_text='Timestamp of the most recent stride calibration.',
                null=True,
            ),
        ),
    ]
