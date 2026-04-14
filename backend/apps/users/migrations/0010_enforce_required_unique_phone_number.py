from django.db import migrations, models


def _build_fallback_phone(user_id: int, used: set[str]) -> str:
    # 12-digit local fallback in 2547XXXXXXXX format.
    seed = 10000000 + int(user_id)
    candidate = f"2547{seed:08d}"[:20]
    while candidate in used:
        seed += 1
        candidate = f"2547{seed:08d}"[:20]
    used.add(candidate)
    return candidate


def forwards_fill_missing_and_duplicate_phones(apps, schema_editor):
    User = apps.get_model('users', 'User')
    used: set[str] = set()
    updates = []

    for user in User.objects.all().order_by('id').only('id', 'phone_number'):
        phone = (user.phone_number or '').strip()

        if not phone or phone in used:
            user.phone_number = _build_fallback_phone(user.id, used)
            updates.append(user)
            continue

        used.add(phone)

    if updates:
        User.objects.bulk_update(updates, ['phone_number'])


class Migration(migrations.Migration):

    dependencies = [
        ('users', '0009_user_profile_picture_fields'),
    ]

    operations = [
        migrations.RunPython(forwards_fill_missing_and_duplicate_phones, migrations.RunPython.noop),
        migrations.SeparateDatabaseAndState(
            database_operations=[],
            state_operations=[
                migrations.AlterField(
                    model_name='user',
                    name='phone_number',
                    field=models.CharField(
                        max_length=20,
                        blank=False,
                        null=False,
                        unique=True,
                        help_text='M-Pesa phone number (e.g., 254712345678)',
                    ),
                ),
            ],
        ),
    ]
