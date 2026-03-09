from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
        ('challenges', '0003_challenge_phase1_differentiators'),
    ]

    operations = [
        migrations.CreateModel(
            name='ChallengeMessage',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('message', models.TextField()),
                ('is_system', models.BooleanField(default=False, help_text='True for automated event messages')),
                ('event_type', models.CharField(blank=True, help_text='Type of automated event (e.g. milestone_reached, elimination)', max_length=50)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('challenge', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='messages', to='challenges.challenge')),
                ('user', models.ForeignKey(blank=True, help_text='Null for system/automated messages', null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='challenge_messages', to=settings.AUTH_USER_MODEL)),
            ],
            options={
                'ordering': ['created_at'],
            },
        ),
        migrations.AddIndex(
            model_name='challengemessage',
            index=models.Index(fields=['challenge', 'created_at'], name='challenges__challen_85a734_idx'),
        ),
    ]
