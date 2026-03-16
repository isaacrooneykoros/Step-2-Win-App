#!/usr/bin/env bash
set -o errexit

python manage.py migrate --noinput
python manage.py check --deploy --fail-level ERROR
gunicorn step2win.wsgi:application --bind 0.0.0.0:${PORT:-8000}