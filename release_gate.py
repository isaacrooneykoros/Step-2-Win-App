#!/usr/bin/env python3
"""Release gate command for backend and frontend validation."""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent
BACKEND = ROOT / 'backend'
WEB = ROOT / 'step2win-web'
ADMIN = ROOT / 'step2win-admin'
NPM_CMD = 'npm.cmd' if os.name == 'nt' else 'npm'
ANDROID_GRADLE = 'gradlew.bat' if os.name == 'nt' else './gradlew'


def run(cmd: list[str], cwd: Path, env: dict[str, str] | None = None) -> None:
    print(f"\n>>> {' '.join(cmd)} (cwd={cwd})")
    merged_env = os.environ.copy()
    if env:
        merged_env.update(env)

    result = subprocess.run(cmd, cwd=str(cwd), env=merged_env)
    if result.returncode != 0:
        raise SystemExit(result.returncode)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description='Run Step2Win release gates.')
    parser.add_argument('--mode', choices=['ci', 'deploy'], default='ci')
    parser.add_argument('--skip-backend-tests', action='store_true')
    parser.add_argument('--skip-web', action='store_true')
    parser.add_argument('--skip-admin', action='store_true')
    parser.add_argument('--include-android', action='store_true')
    return parser.parse_args()


def _is_false_like(value: str) -> bool:
    return value.strip().lower() in {'0', 'false', 'no', 'off'}


def validate_production_env_safety() -> None:
    env = os.environ
    errors: list[str] = []

    required_non_empty = [
        'DJANGO_ENV',
        'DEBUG',
        'SECRET_KEY',
        'ALLOWED_HOSTS',
        'CSRF_TRUSTED_ORIGINS',
        'DATABASE_URL',
        'DATABASE_POOL_URL',
        'REDIS_URL',
    ]

    for key in required_non_empty:
        if not env.get(key, '').strip():
            errors.append(f'Missing required env var: {key}')

    django_env = env.get('DJANGO_ENV', '').strip().lower()
    if django_env and django_env != 'production':
        errors.append('DJANGO_ENV must be "production" for deploy mode')

    debug_value = env.get('DEBUG', '').strip()
    if debug_value and not _is_false_like(debug_value):
        errors.append('DEBUG must be false-like (False/0/no/off) in deploy mode')

    secret_key = env.get('SECRET_KEY', '')
    if secret_key and (len(secret_key) < 32 or 'changeme' in secret_key.lower()):
        errors.append('SECRET_KEY is too weak or appears to be a placeholder')

    database_url = env.get('DATABASE_URL', '').strip().lower()
    if database_url and not database_url.startswith(('postgres://', 'postgresql://')):
        errors.append('DATABASE_URL must be a PostgreSQL URL')
    if database_url.startswith('sqlite'):
        errors.append('DATABASE_URL cannot use SQLite in deploy mode')

    database_pool_url = env.get('DATABASE_POOL_URL', '').strip().lower()
    if database_pool_url and not database_pool_url.startswith(('postgres://', 'postgresql://')):
        errors.append('DATABASE_POOL_URL must be a PostgreSQL URL')

    redis_url = env.get('REDIS_URL', '').strip().lower()
    if redis_url and not redis_url.startswith(('redis://', 'rediss://')):
        errors.append('REDIS_URL must be a Redis URL')

    hosts = [h.strip().lower() for h in env.get('ALLOWED_HOSTS', '').split(',') if h.strip()]
    if any(h in {'localhost', '127.0.0.1'} for h in hosts):
        errors.append('ALLOWED_HOSTS cannot contain localhost/127.0.0.1 in deploy mode')

    origins = [o.strip() for o in env.get('CSRF_TRUSTED_ORIGINS', '').split(',') if o.strip()]
    if any(not origin.startswith('https://') for origin in origins):
        errors.append('CSRF_TRUSTED_ORIGINS entries must start with https:// in deploy mode')

    if errors:
        print('\nProduction environment safety checks failed:')
        for error in errors:
            print(f' - {error}')
        raise SystemExit(2)


def run_backend_ci_checks(python_cmd: list[str], *, skip_tests: bool) -> None:
    backend_prod_env = {
        'DJANGO_ENV': 'production',
        'DEBUG': 'False',
        'USE_SQLITE': 'False',
        'SECRET_KEY': 'prod-check-secret-key-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ',
        'ALLOWED_HOSTS': 'api.step2win.example',
        'CSRF_TRUSTED_ORIGINS': 'https://api.step2win.example',
        'DATABASE_URL': 'postgres://releasegate:releasegate@localhost:5432/releasegate',
        'DATABASE_POOL_URL': 'postgres://releasegate:releasegate@localhost:6432/releasegate',
        'REDIS_URL': 'redis://localhost:6379/1',
    }

    backend_test_env = {
        'DJANGO_ENV': 'test',
        'DEBUG': 'True',
        'USE_SQLITE': 'True',
        'SECRET_KEY': 'test-secret-key-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ',
        'ALLOWED_HOSTS': 'localhost,127.0.0.1,testserver',
    }

    run(python_cmd + ['manage.py', 'check', '--deploy'], BACKEND, backend_prod_env)
    run(python_cmd + ['manage.py', 'makemigrations', '--check', '--dry-run'], BACKEND, backend_test_env)
    if not skip_tests:
        run(python_cmd + ['manage.py', 'test'], BACKEND, backend_test_env)


def run_backend_predeploy_checks(python_cmd: list[str]) -> None:
    run(python_cmd + ['manage.py', 'check', '--deploy'], BACKEND)
    run(python_cmd + ['manage.py', 'check', '--database', 'default'], BACKEND)
    run(python_cmd + ['manage.py', 'migrate', '--check', '--noinput'], BACKEND)
    run(
        python_cmd + [
            'manage.py',
            'reconcile_financial_integrity',
            '--no-alerts',
            '--max-stuck-processing',
            '10',
            '--max-unprocessed-callbacks',
            '5',
            '--max-negative-balance-users',
            '0',
            '--max-callback-failure-rate-pct',
            '5.0',
        ],
        BACKEND,
    )


def run_frontend_checks(*, skip_web: bool, skip_admin: bool) -> None:
    if not skip_web:
        run([NPM_CMD, 'run', 'lint'], WEB)
        run([NPM_CMD, 'run', 'build'], WEB)

    if not skip_admin:
        run([NPM_CMD, 'run', 'lint'], ADMIN)
        run([NPM_CMD, 'run', 'build'], ADMIN)


def run_android_build_if_requested(*, requested: bool) -> None:
    if requested:
        run([NPM_CMD, 'run', 'build'], WEB)
        run([NPM_CMD, 'exec', 'cap', 'sync', 'android'], WEB)
        run([ANDROID_GRADLE, ':app:assembleDebug', '--no-daemon'], WEB / 'android')


def main() -> int:
    args = parse_args()
    python_cmd = [sys.executable]

    if args.mode == 'deploy':
        validate_production_env_safety()
        run_backend_predeploy_checks(python_cmd)
    else:
        run_backend_ci_checks(python_cmd, skip_tests=args.skip_backend_tests)
        run_frontend_checks(skip_web=args.skip_web, skip_admin=args.skip_admin)

    android_requested = args.include_android or os.getenv('RELEASE_GATE_ANDROID', '0').lower() in {'1', 'true', 'yes'}
    run_android_build_if_requested(requested=android_requested)

    print('\nRelease gate passed.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
