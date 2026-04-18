from __future__ import annotations

import hashlib
import json

from django.db import migrations, models
from django.db.models import Count, Q


def _stable_payload_hash(payload) -> str:
    try:
        text = json.dumps(payload, sort_keys=True, separators=(',', ':'))
    except Exception:
        text = str(payload)
    return hashlib.sha256(text.encode('utf-8')).hexdigest()


def populate_and_dedupe(apps, schema_editor):
    PaymentTransaction = apps.get_model('payments', 'PaymentTransaction')
    CallbackLog = apps.get_model('payments', 'CallbackLog')

    # Normalize callback payload hashes, but only keep hash on the first duplicate
    # so existing historical duplicates don't block the new unique invariant.
    seen = set()
    for cb in CallbackLog.objects.all().order_by('id'):
        payload_hash = _stable_payload_hash(cb.raw_payload)
        key = (cb.type, cb.order_id or '', payload_hash)
        if key in seen:
            cb.payload_hash = ''
        else:
            cb.payload_hash = payload_hash
            seen.add(key)
        cb.save(update_fields=['payload_hash'])

    # De-duplicate payment references for non-empty values.
    # Keep the earliest row value and clear later duplicates to avoid migration failure.
    fields = ['mpesa_reference', 'collection_id', 'request_id']
    for field_name in fields:
        dupes = (
            PaymentTransaction.objects.exclude(**{field_name: ''})
            .values(field_name)
            .annotate(c=Count('id'))
            .filter(c__gt=1)
        )
        for row in dupes:
            value = row[field_name]
            txns = PaymentTransaction.objects.filter(**{field_name: value}).order_by('created_at', 'id')
            first = True
            for txn in txns:
                if first:
                    first = False
                    continue
                setattr(txn, field_name, '')
                txn.save(update_fields=[field_name])


def noop_reverse(apps, schema_editor):
    pass


class Migration(migrations.Migration):

    dependencies = [
        ('payments', '0004_rename_payments_pl_collecte_abc123_idx_payments_pl_collect_a46a18_idx'),
    ]

    operations = [
        migrations.AddField(
            model_name='callbacklog',
            name='payload_hash',
            field=models.CharField(blank=True, db_index=True, max_length=64),
        ),
        migrations.RunPython(populate_and_dedupe, noop_reverse),
        migrations.AddConstraint(
            model_name='paymenttransaction',
            constraint=models.UniqueConstraint(
                condition=Q(mpesa_reference__gt=''),
                fields=('mpesa_reference',),
                name='uniq_payment_mpesa_reference_non_empty',
            ),
        ),
        migrations.AddConstraint(
            model_name='paymenttransaction',
            constraint=models.UniqueConstraint(
                condition=Q(collection_id__gt=''),
                fields=('collection_id',),
                name='uniq_payment_collection_id_non_empty',
            ),
        ),
        migrations.AddConstraint(
            model_name='paymenttransaction',
            constraint=models.UniqueConstraint(
                condition=Q(request_id__gt=''),
                fields=('request_id',),
                name='uniq_payment_request_id_non_empty',
            ),
        ),
        migrations.AddConstraint(
            model_name='callbacklog',
            constraint=models.UniqueConstraint(
                condition=Q(payload_hash__gt=''),
                fields=('type', 'order_id', 'payload_hash'),
                name='uniq_callback_type_order_payload_hash',
            ),
        ),
    ]
