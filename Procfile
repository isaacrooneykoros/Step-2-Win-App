release: bash -lc 'cd backend && python manage.py migrate && python manage.py collectstatic --noinput'
web: bash -lc 'cd backend && gunicorn -w 4 -b 0.0.0.0:$PORT --timeout 120 --access-logfile - --error-logfile - step2win.wsgi'
worker: bash -lc 'cd backend && celery -A step2win worker -l info --concurrency=2'
beat: bash -lc 'cd backend && celery -A step2win beat -l info --scheduler django_celery_beat.schedulers:DatabaseScheduler'
