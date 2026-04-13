#!/usr/bin/env bash
set -o errexit

python manage.py migrate --noinput
python manage.py check --deploy --fail-level ERROR
daphne -b 0.0.0.0 -p ${PORT:-8000} step2win.asgi:application