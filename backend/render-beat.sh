#!/usr/bin/env bash
set -o errexit

celery -A step2win beat -l info