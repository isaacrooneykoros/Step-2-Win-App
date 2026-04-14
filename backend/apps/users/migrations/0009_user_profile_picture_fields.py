from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('users', '0008_user_calibration_badge_fields'),
    ]

    operations = [
        migrations.AddField(
            model_name='user',
            name='profile_picture',
            field=models.ImageField(blank=True, help_text='User profile picture', null=True, upload_to='profile_pictures/'),
        ),
        migrations.AddField(
            model_name='user',
            name='last_profile_picture_update',
            field=models.DateTimeField(blank=True, help_text='Timestamp when profile picture was last updated', null=True),
        ),
    ]
