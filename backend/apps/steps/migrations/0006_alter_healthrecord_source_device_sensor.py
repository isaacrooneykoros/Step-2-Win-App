from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('steps', '0005_hourlysteprecord_locationwaypoint'),
    ]

    operations = [
        migrations.AlterField(
            model_name='healthrecord',
            name='source',
            field=models.CharField(
                choices=[
                    ('device_sensor', 'Device Sensor'),
                    ('google_fit', 'Google Fit'),
                    ('apple_health', 'Apple Health'),
                    ('manual', 'Manual Entry'),
                ],
                default='google_fit',
                max_length=20,
            ),
        ),
    ]
