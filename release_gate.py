#!/usr/bin/env python3
"""Release gate command for backend and frontend validation."""

from __future__ import annotations

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


def main() -> int:
    backend_prod_env = {
        'DJANGO_ENV': 'production',
        'DEBUG': 'False',
        'USE_SQLITE': 'True',
        'SECRET_KEY': 'prod-check-secret-key-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ',
        'ALLOWED_HOSTS': 'api.step2win.example',
        'CSRF_TRUSTED_ORIGINS': 'https://api.step2win.example',
        'APP_SIGNING_SECRET': 'prod-gate-signing-secret-0123456789ABCDEFGHIJ',
    }

    backend_test_env = {
        'DJANGO_ENV': 'test',
        'DEBUG': 'True',
        'USE_SQLITE': 'True',
        'SECRET_KEY': 'test-secret-key-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ',
        'ALLOWED_HOSTS': 'localhost,127.0.0.1,testserver',
    }

    python_cmd = [sys.executable]

    run(python_cmd + ['manage.py', 'check', '--deploy'], BACKEND, backend_prod_env)
    run(python_cmd + ['manage.py', 'makemigrations', '--check', '--dry-run'], BACKEND, backend_test_env)
    run(python_cmd + ['manage.py', 'test'], BACKEND, backend_test_env)

    run([NPM_CMD, 'run', 'lint'], WEB)
    run([NPM_CMD, 'run', 'build'], WEB)

    run([NPM_CMD, 'run', 'lint'], ADMIN)
    run([NPM_CMD, 'run', 'build'], ADMIN)

    if os.getenv('RELEASE_GATE_ANDROID', '0').lower() in {'1', 'true', 'yes'}:
        run([NPM_CMD, 'run', 'build'], WEB)
        run([NPM_CMD, 'exec', 'cap', 'sync', 'android'], WEB)
        run([ANDROID_GRADLE, ':app:assembleDebug', '--no-daemon'], WEB / 'android')

    print('\nRelease gate passed.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
