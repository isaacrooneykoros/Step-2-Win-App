#!/usr/bin/env python3
"""Release gate command for backend and frontend validation.

Checks performed:
  1. Django --deploy check (production settings guard)
  2. Django makemigrations --check (no uncommitted migrations)
  3. Python tests with coverage (fails if coverage < 70 %)
  4. ruff linter (PEP 8 + isort + pyupgrade equivalent)
  5. pip-audit (known CVE scan for Python dependencies)
  6. OpenAPI schema generation (keeps Step2Win API.yaml in sync)
  7. npm audit (known CVE scan for JS dependencies)
  8. ESLint + TypeScript build for both frontends
"""

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

# Minimum acceptable test coverage percentage.
MIN_COVERAGE = 70


def run(cmd: list[str], cwd: Path, env: dict[str, str] | None = None) -> None:
    print(f"\n>>> {' '.join(cmd)} (cwd={cwd})")
    merged_env = os.environ.copy()
    if env:
        merged_env.update(env)

    result = subprocess.run(cmd, cwd=str(cwd), env=merged_env)
    if result.returncode != 0:
        raise SystemExit(result.returncode)


def run_optional(cmd: list[str], cwd: Path, env: dict[str, str] | None = None) -> bool:
    """Runs a command but only exits if it fails, printing a warning for missing tools."""
    print(f"\n>>> {' '.join(cmd)} (cwd={cwd})")
    merged_env = os.environ.copy()
    if env:
        merged_env.update(env)

    result = subprocess.run(cmd, cwd=str(cwd), env=merged_env)
    if result.returncode != 0:
        print(f"WARNING: '{' '.join(cmd)}' exited {result.returncode} — treating as failure")
        raise SystemExit(result.returncode)
    return True


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
    pip_cmd    = [sys.executable, '-m', 'pip']

    # ── 1. Django deployment check ────────────────────────────────────────
    run(python_cmd + ['manage.py', 'check', '--deploy'], BACKEND, backend_prod_env)

    # ── 2. Migration check ────────────────────────────────────────────────
    run(
        python_cmd + ['manage.py', 'makemigrations', '--check', '--dry-run'],
        BACKEND,
        backend_test_env,
    )

    # ── 3. Tests with coverage ────────────────────────────────────────────
    # Install coverage if not available; fail the gate if coverage is below threshold.
    run(pip_cmd + ['install', '--quiet', 'coverage'], BACKEND)
    run(
        python_cmd + ['-m', 'coverage', 'run', '--source=apps', 'manage.py', 'test'],
        BACKEND,
        backend_test_env,
    )
    run(
        python_cmd + [
            '-m', 'coverage', 'report',
            f'--fail-under={MIN_COVERAGE}',
        ],
        BACKEND,
        backend_test_env,
    )

    # ── 4. ruff linter ────────────────────────────────────────────────────
    # ruff covers flake8 + isort + pyupgrade rules with near-zero config.
    run(pip_cmd + ['install', '--quiet', 'ruff'], BACKEND)
    run(python_cmd + ['-m', 'ruff', 'check', '.'], BACKEND)

    # ── 5. pip-audit (Python dependency CVE scan) ─────────────────────────
    run(pip_cmd + ['install', '--quiet', 'pip-audit'], BACKEND)
    run(python_cmd + ['-m', 'pip_audit', '-r', 'requirements.txt'], BACKEND)

    # ── 6. OpenAPI schema generation ─────────────────────────────────────
    # Regenerates Step2Win API.yaml from the live serializers/views so the
    # committed schema stays in sync with the implementation.
    run(
        python_cmd + [
            'manage.py', 'spectacular',
            '--color', '--file', str(ROOT / 'Step2Win API.yaml'),
        ],
        BACKEND,
        backend_test_env,
    )

    # ── 7. npm audit + lint + build (web) ─────────────────────────────────
    run([NPM_CMD, 'audit', '--audit-level=high'], WEB)
    run([NPM_CMD, 'run', 'lint'], WEB)
    run([NPM_CMD, 'run', 'build'], WEB)

    # ── 8. npm audit + lint + build (admin) ───────────────────────────────
    run([NPM_CMD, 'audit', '--audit-level=high'], ADMIN)
    run([NPM_CMD, 'run', 'lint'], ADMIN)
    run([NPM_CMD, 'run', 'build'], ADMIN)

    # ── Android build (optional, gated by env var) ─────────────────────────
    if os.getenv('RELEASE_GATE_ANDROID', '0').lower() in {'1', 'true', 'yes'}:
        run([NPM_CMD, 'run', 'build'], WEB)
        run([NPM_CMD, 'exec', 'cap', 'sync', 'android'], WEB)
        run([ANDROID_GRADLE, ':app:assembleDebug', '--no-daemon'], WEB / 'android')

    print('\nRelease gate passed.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
