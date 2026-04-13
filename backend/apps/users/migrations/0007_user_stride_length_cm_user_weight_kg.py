from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('users', '0006_user_best_day_steps_user_best_streak_and_more'),
    ]

    operations = [
        migrations.AddField(
            model_name='user',
            name='stride_length_cm',
            field=models.FloatField(default=78.0, help_text='User-calibrated stride length in centimeters for distance precision.'),
        ),
        migrations.AddField(
            model_name='user',
            name='weight_kg',
            field=models.FloatField(default=70.0, help_text='User body weight in kilograms for calorie estimation precision.'),
        ),
    ]
