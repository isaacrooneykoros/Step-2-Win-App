"""Small concurrent load test for Step2Win API.

Covers:
1) user register/login
2) signed /api/steps/sync/ submissions
3) optional challenge chat GET/POST

Usage example:
  python load_test_concurrent.py --users 25 --loops 3 --chat-challenge-id 12
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import os
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import date
from typing import Any

import requests
from dotenv import load_dotenv


@dataclass
class WorkerResult:
    username: str
    registered: bool
    logged_in: bool
    sync_success: int
    sync_fail: int
    chat_get_ok: bool
    chat_post_ok: bool
    errors: list[str]
    avg_latency_ms: float


class Stats:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.http_status_counts: dict[int, int] = {}
        self.latencies_ms: list[float] = []

    def record_status(self, status_code: int) -> None:
        with self.lock:
            self.http_status_counts[status_code] = self.http_status_counts.get(status_code, 0) + 1

    def record_latency(self, latency_ms: float) -> None:
        with self.lock:
            self.latencies_ms.append(latency_ms)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description='Concurrent Step2Win API load test')
    parser.add_argument('--base-url', default=os.getenv('LOAD_BASE_URL', 'http://127.0.0.1:8000'))
    parser.add_argument('--users', type=int, default=20)
    parser.add_argument('--loops', type=int, default=2, help='Step-sync loops per user')
    parser.add_argument('--sync-delay', type=float, default=1.1, help='Delay between sync loops (seconds)')
    parser.add_argument('--password', default=os.getenv('LOAD_TEST_PASSWORD', 'Step2Win!234'))
    parser.add_argument('--user-prefix', default=os.getenv('LOAD_USER_PREFIX', 'load_user'))
    parser.add_argument('--chat-challenge-id', type=int, default=None)
    parser.add_argument('--signing-secret', default=os.getenv('APP_SIGNING_SECRET', ''))
    parser.add_argument('--timeout', type=float, default=15.0)
    parser.add_argument(
        '--cleanup',
        action=argparse.BooleanOptionalAction,
        default=True,
        help='Delete generated load users after test run (default: enabled).',
    )
    return parser.parse_args()


def cleanup_generated_users(usernames: list[str]) -> tuple[int, str | None]:
    """Delete generated users using Django ORM; returns (deleted_users_count, error_message)."""
    if not usernames:
        return 0, None

    try:
        os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'step2win.settings')
        import django  # type: ignore

        django.setup()
        from django.contrib.auth import get_user_model  # type: ignore

        user_model = get_user_model()
        to_delete = user_model.objects.filter(username__in=usernames)
        deleted_users_count = to_delete.count()
        to_delete.delete()
        return deleted_users_count, None
    except Exception as exc:
        return 0, f'{type(exc).__name__}: {exc}'


def decode_user_id_from_jwt(access_token: str) -> str:
    try:
        parts = access_token.split('.')
        if len(parts) != 3:
            return ''
        padded = parts[1] + '=' * (-len(parts[1]) % 4)
        payload = json.loads(base64.urlsafe_b64decode(padded.encode('utf-8')).decode('utf-8'))
        user_id = payload.get('user_id')
        return str(user_id) if user_id is not None else ''
    except Exception:
        return ''


def build_signature(user_id: str, timestamp: str, body_bytes: bytes, secret: str) -> str:
    body_hash = hashlib.sha256(body_bytes).hexdigest()
    message = f'{user_id}:{timestamp}:{body_hash}'
    return hmac.new(secret.encode('utf-8'), message.encode('utf-8'), hashlib.sha256).hexdigest()


def timed_request(
    session: requests.Session,
    method: str,
    url: str,
    stats: Stats,
    timeout: float,
    **kwargs: Any,
) -> requests.Response:
    start = time.perf_counter()
    response = session.request(method=method, url=url, timeout=timeout, **kwargs)
    elapsed_ms = (time.perf_counter() - start) * 1000.0
    stats.record_status(response.status_code)
    stats.record_latency(elapsed_ms)
    return response


def run_worker(
    idx: int,
    args: argparse.Namespace,
    run_id: str,
    stats: Stats,
) -> WorkerResult:
    username = f'{args.user_prefix}_{run_id}_{idx:03d}'
    email = f'{username}@load.test'
    phone = f'254700{idx:06d}'
    session = requests.Session()
    errors: list[str] = []
    local_latencies: list[float] = []

    def call(method: str, url: str, **kwargs: Any) -> requests.Response:
        start = time.perf_counter()
        response = timed_request(session, method, url, stats, args.timeout, **kwargs)
        local_latencies.append((time.perf_counter() - start) * 1000.0)
        return response

    registered = False
    logged_in = False
    sync_success = 0
    sync_fail = 0
    chat_get_ok = False
    chat_post_ok = False

    try:
        register_payload = {
            'username': username,
            'email': email,
            'phone_number': phone,
            'password': args.password,
            'confirm_password': args.password,
        }
        register_res = call('POST', f'{args.base_url}/api/auth/register/', json=register_payload)
        if register_res.status_code in (200, 201):
            registered = True
        elif register_res.status_code == 400:
            # Reruns can hit existing accounts; continue with login attempt.
            registered = False
        else:
            errors.append(f'register:{register_res.status_code}:{register_res.text[:160]}')

        login_payload = {
            'username': username,
            'password': args.password,
            'device_name': f'LoadTest Device {idx}',
            'device_type': 'android',
            'app_version': 'load-test-1.0',
        }
        login_res = call('POST', f'{args.base_url}/api/auth/login/', json=login_payload)
        if login_res.status_code != 200:
            errors.append(f'login:{login_res.status_code}:{login_res.text[:160]}')
            return WorkerResult(
                username=username,
                registered=registered,
                logged_in=False,
                sync_success=0,
                sync_fail=0,
                chat_get_ok=False,
                chat_post_ok=False,
                errors=errors,
                avg_latency_ms=sum(local_latencies) / max(1, len(local_latencies)),
            )

        logged_in = True
        login_data = login_res.json()
        access = login_data.get('access', '')
        if not access:
            errors.append('login:missing_access_token')
            return WorkerResult(
                username=username,
                registered=registered,
                logged_in=False,
                sync_success=0,
                sync_fail=0,
                chat_get_ok=False,
                chat_post_ok=False,
                errors=errors,
                avg_latency_ms=sum(local_latencies) / max(1, len(local_latencies)),
            )

        auth_headers = {'Authorization': f'Bearer {access}'}
        user_id = decode_user_id_from_jwt(access)

        for loop in range(args.loops):
            steps_value = 2500 + (loop * 120) + (idx * 3)
            sync_payload = {
                'date': str(date.today()),
                'source': 'manual',
                'steps': steps_value,
                'distance_km': round(steps_value / 1300.0, 2),
                'calories_active': int(steps_value * 0.04),
                'active_minutes': min(180, max(10, steps_value // 120)),
            }
            body = json.dumps(sync_payload, separators=(',', ':')).encode('utf-8')
            ts = str(int(time.time()))
            sync_headers = dict(auth_headers)
            sync_headers['Content-Type'] = 'application/json'
            sync_headers['X-Timestamp'] = ts
            sync_headers['X-Idempotency-Key'] = str(uuid.uuid4())
            if args.signing_secret and user_id:
                sync_headers['X-App-Signature'] = build_signature(user_id, ts, body, args.signing_secret)

            sync_res = call(
                'POST',
                f'{args.base_url}/api/steps/sync/',
                data=body,
                headers=sync_headers,
            )
            if sync_res.status_code == 200:
                sync_success += 1
            else:
                sync_fail += 1
                errors.append(f'sync[{loop}]:{sync_res.status_code}:{sync_res.text[:160]}')

            if loop < args.loops - 1:
                time.sleep(max(0.0, args.sync_delay))

        if args.chat_challenge_id:
            chat_base = f'{args.base_url}/api/challenges/{args.chat_challenge_id}/chat/'
            chat_get = call('GET', chat_base, headers=auth_headers)
            chat_get_ok = chat_get.status_code == 200
            if not chat_get_ok:
                errors.append(f'chat_get:{chat_get.status_code}:{chat_get.text[:160]}')

            chat_post = call(
                'POST',
                chat_base,
                headers=auth_headers,
                json={'content': f'Load ping from {username} at {int(time.time())}'},
            )
            chat_post_ok = chat_post.status_code in (200, 201)
            if not chat_post_ok:
                errors.append(f'chat_post:{chat_post.status_code}:{chat_post.text[:160]}')

    except requests.RequestException as exc:
        errors.append(f'network:{type(exc).__name__}:{exc}')
    except Exception as exc:
        errors.append(f'unexpected:{type(exc).__name__}:{exc}')

    return WorkerResult(
        username=username,
        registered=registered,
        logged_in=logged_in,
        sync_success=sync_success,
        sync_fail=sync_fail,
        chat_get_ok=chat_get_ok,
        chat_post_ok=chat_post_ok,
        errors=errors,
        avg_latency_ms=sum(local_latencies) / max(1, len(local_latencies)),
    )


def main() -> None:
    load_dotenv()
    args = parse_args()
    args.base_url = args.base_url.rstrip('/')
    stats = Stats()
    run_id = str(int(time.time()))

    print('=== Step2Win Concurrent Load Test ===')
    print(f'Base URL: {args.base_url}')
    print(f'Users: {args.users}, loops/user: {args.loops}, chat challenge: {args.chat_challenge_id}')

    start = time.perf_counter()
    results: list[WorkerResult] = []
    with ThreadPoolExecutor(max_workers=args.users) as executor:
        futures = [executor.submit(run_worker, i, args, run_id, stats) for i in range(args.users)]
        for future in as_completed(futures):
            results.append(future.result())

    elapsed = time.perf_counter() - start
    total_sync_success = sum(r.sync_success for r in results)
    total_sync_fail = sum(r.sync_fail for r in results)
    login_success = sum(1 for r in results if r.logged_in)
    chat_get_success = sum(1 for r in results if r.chat_get_ok)
    chat_post_success = sum(1 for r in results if r.chat_post_ok)
    error_count = sum(len(r.errors) for r in results)
    generated_usernames = [r.username for r in results]

    cleanup_deleted = 0
    cleanup_error: str | None = None
    if args.cleanup:
        cleanup_deleted, cleanup_error = cleanup_generated_users(generated_usernames)

    latencies = stats.latencies_ms
    avg_ms = round(sum(latencies) / max(1, len(latencies)), 2)
    p95_ms = 0.0
    if latencies:
        ordered = sorted(latencies)
        idx = min(len(ordered) - 1, int(len(ordered) * 0.95))
        p95_ms = round(ordered[idx], 2)

    summary = {
        'elapsed_seconds': round(elapsed, 2),
        'users_total': args.users,
        'login_success': login_success,
        'sync_success': total_sync_success,
        'sync_fail': total_sync_fail,
        'chat_get_success': chat_get_success,
        'chat_post_success': chat_post_success,
        'http_status_counts': stats.http_status_counts,
        'avg_latency_ms': avg_ms,
        'p95_latency_ms': p95_ms,
        'error_count': error_count,
        'cleanup_enabled': args.cleanup,
        'cleanup_deleted_users': cleanup_deleted,
        'cleanup_error': cleanup_error,
    }

    print('\n=== Summary ===')
    print(json.dumps(summary, indent=2))

    failed_workers = [r for r in results if r.errors]
    if failed_workers:
        print('\n=== Sample Errors (up to 10 workers) ===')
        for worker in failed_workers[:10]:
            print(f'- {worker.username}')
            for err in worker.errors[:4]:
                print(f'  * {err}')


if __name__ == '__main__':
    main()
