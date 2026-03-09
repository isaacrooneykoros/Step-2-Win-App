from django.db import migrations, models
import django.core.validators
from decimal import Decimal


class Migration(migrations.Migration):

    dependencies = [
        ('challenges', '0002_initial'),
    ]

    operations = [
        migrations.AlterField(
            model_name='challenge',
            name='entry_fee',
            field=models.DecimalField(
                decimal_places=2,
                max_digits=10,
                validators=[
                    django.core.validators.MinValueValidator(Decimal('1.00')),
                    django.core.validators.MaxValueValidator(Decimal('10000.00')),
                ],
            ),
        ),
        migrations.AddField(
            model_name='challenge',
            name='theme_emoji',
            field=models.CharField(
                choices=[('🔥', 'Flame'), ('👑', 'Royal'), ('🌍', 'Safari'), ('⚡', 'Lightning')],
                default='🔥',
                help_text='Visual identity emoji for private challenge cards',
                max_length=4,
            ),
        ),
        migrations.AddField(
            model_name='challenge',
            name='win_condition',
            field=models.CharField(
                choices=[
                    ('proportional', 'Proportional Split'),
                    ('winner_takes_all', 'Winner Takes All'),
                    ('qualification_only', 'Qualification Only'),
                ],
                default='proportional',
                help_text='How winners are determined and payouts are distributed',
                max_length=30,
            ),
        ),
    ]
