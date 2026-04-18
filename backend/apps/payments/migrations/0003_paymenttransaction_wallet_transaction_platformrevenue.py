# Generated migration for PlatformRevenue model and wallet_transaction link

import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('payments', '0002_withdrawalrequest'),
        ('wallet', '0002_wallettransaction_reference_id'),  # Ensure wallet app is migrated first
        ('challenges', '0001_initial'),
    ]

    operations = [
        migrations.AddField(
            model_name='paymenttransaction',
            name='wallet_transaction',
            field=models.OneToOneField(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name='payment_transaction',
                to='wallet.wallettransaction',
                help_text='Linked wallet transaction for reconciliation'
            ),
        ),
        migrations.CreateModel(
            name='PlatformRevenue',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('amount_kes', models.DecimalField(decimal_places=2, help_text='5% fee from challenge.total_pool', max_digits=12)),
                ('collected_at', models.DateTimeField(auto_now_add=True, db_index=True)),
                ('narration', models.CharField(max_length=255)),
                ('metadata', models.JSONField(blank=True, null=True)),
                ('challenge', models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name='revenue_records', to='challenges.challenge')),
            ],
            options={
                'ordering': ['-collected_at'],
                'indexes': [
                    models.Index(fields=['-collected_at'], name='payments_pl_collecte_abc123_idx'),
                ],
            },
        ),
    ]
