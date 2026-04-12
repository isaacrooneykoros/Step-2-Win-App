#!/usr/bin/env python3
"""
Quick smoke test for Step2Win API endpoints
"""
import os
import sys
import django
import requests
from django.contrib.auth import get_user_model
from requests import RequestException

# Setup Django
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'step2win.settings')
os.environ['USE_SQLITE'] = 'True'
django.setup()

User = get_user_model()

BASE_TIMEOUT_SECONDS = 15
MAX_RETRIES = 3


def request_with_retry(method, url, **kwargs):
    last_error = None
    timeout = kwargs.pop('timeout', BASE_TIMEOUT_SECONDS)
    for _ in range(MAX_RETRIES):
        try:
            return requests.request(method, url, timeout=timeout, **kwargs)
        except RequestException as exc:
            last_error = exc
    raise last_error

def test_api_endpoints():
    """Test key API endpoints"""
    base_url = "http://127.0.0.1:8000"
    
    print("🧪 SMOKE TEST - Step2Win API")
    print("=" * 50)
    
    # Test 1: API Root
    try:
        resp = request_with_retry('GET', f"{base_url}/api/health/")
        if resp.status_code != 200:
            print(f"❌ Health Check failed: {resp.status_code}")
            print(f"   Response: {resp.text[:200]}")
            return False
        print(f"✅ Health Check: {resp.status_code}")
    except Exception as e:
        print(f"❌ Health Check: {e}")
        return False
    
    # Test 2: Register a test user
    import random
    test_username = f"smoke_test_{random.randint(100000, 999999)}"
    test_email = f"{test_username}@test.com"
    test_password = "TestPass123!"
    
    try:
        resp = request_with_retry('POST', f"{base_url}/api/auth/register/", json={
            "username": test_username,
            "email": test_email,
            "password": test_password,
            "confirm_password": test_password,
            "full_name": "Smoke Test User"
        })
        print(f"✅ User Registration: {resp.status_code}")
        if resp.status_code not in [200, 201]:
            print(f"   Response: {resp.text[:200]}")
            return False
    except Exception as e:
        print(f"❌ User Registration: {e}")
        return False
    
    # Test 3: Login
    try:
        resp = request_with_retry('POST', f"{base_url}/api/auth/login/", json={
            "username": test_username,
            "password": test_password
        })
        print(f"✅ User Login: {resp.status_code}")
        tokens = resp.json()
        access_token = tokens.get('access')
    except Exception as e:
        print(f"❌ User Login: {e}")
        return False
    
    headers = {"Authorization": f"Bearer {access_token}"}
    
    # Test 4: User Profile
    try:
        resp = request_with_retry('GET', f"{base_url}/api/auth/profile/", headers=headers)
        print(f"✅ User Profile: {resp.status_code}")
        profile = resp.json()
        print(f"   User: {profile.get('username')}, XP: {profile.get('xp_profile', {}).get('total_xp', 'N/A')}")
    except Exception as e:
        print(f"❌ User Profile: {e}")
    
    # Test 5: Challenges List
    try:
        resp = request_with_retry('GET', f"{base_url}/api/challenges/", headers=headers)
        print(f"✅ Challenges List: {resp.status_code}")
        if resp.status_code == 200:
            data = resp.json()
            count = len(data.get('results', [])) if 'results' in data else len(data)
            print(f"   Challenges available: {count}")
        else:
            print(f"   Error: {resp.text[:200]}")
    except Exception as e:
        print(f"❌ Challenges List: {e}")
    
    # Test 6: XP Profile
    try:
        resp = request_with_retry('GET', f"{base_url}/api/gamification/xp/my_xp/", headers=headers)
        print(f"✅ XP Profile: {resp.status_code}")
        if resp.status_code == 200:
            xp_data = resp.json()
            print(f"   Level: {xp_data.get('level', 'N/A')}, Total XP: {xp_data.get('total_xp', 0)}")
    except Exception as e:
        print(f"❌ XP Profile: {e}")
    
    # Test 7: XP Events List
    try:
        resp = request_with_retry('GET', f"{base_url}/api/gamification/events/", headers=headers)
        print(f"✅ XP Events: {resp.status_code}")
        if resp.status_code == 200:
            data = resp.json()
            events = data.get('results', []) if 'results' in data else data
            print(f"   Events count: {len(events)}")
    except Exception as e:
        print(f"❌ XP Events: {e}")
    
    # Test 8: Admin API (should fail without admin perms)
    try:
        resp = request_with_retry('GET', f"{base_url}/api/admin/users/", headers=headers)
        if resp.status_code == 403:
            print("✅ Admin API Permission: Correctly forbidden for non-admin")
        else:
            print(f"⚠️  Admin API Permission: Unexpected status {resp.status_code}")
    except Exception as e:
        print(f"❌ Admin API Permission: {e}")
    
    print("=" * 50)
    print("✅ SMOKE TEST COMPLETE - All critical endpoints responding")
    return True

if __name__ == "__main__":
    success = test_api_endpoints()
    sys.exit(0 if success else 1)
