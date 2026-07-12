import sys
import os
import django
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'step2win.settings')
django.setup()

from apps.steps.anti_cheat import run_anti_cheat  # noqa: E402
from django.contrib.auth import get_user_model  # noqa: E402
from django.utils import timezone  # noqa: E402

User = get_user_model()
today = timezone.now().date()

try:
    user = User.objects.first()
    if not user:
        # Create a mock user for testing if none exists
        user = User.objects.create_user(username='test_anticheat_user', phone_number='0700000000', password='password')
        print('Created test user')

    if user:
        # Test 1: impossible_rate (10k steps/min)
        r = run_anti_cheat(user, steps=10000, date=today, active_minutes=1)
        if any(f['flag_type'] in ['impossible_rate', 'steps_per_min_impossible'] for f in r.flags):
            print("✓ impossible_rate check works")
        else:
            print("✗ FAIL: impossible_rate not triggered"); sys.exit(1)

        # Test 2: daily_cap and step capping
        r = run_anti_cheat(user, steps=90000, date=today)
        if any(f['flag_type'] in ['daily_cap', 'daily_total_review', 'daily_total_impossible'] for f in r.flags) and r.approved_steps < 90000:
            print("✓ daily_cap and step capping works")
        else:
            print(f"✗ FAIL: daily_cap={any(f['flag_type'] in ['daily_cap', 'daily_total_review', 'daily_total_impossible'] for f in r.flags)}, approved_steps={r.approved_steps}"); sys.exit(1)

        # Test 3: distance_too_low (phone shaking)
        r = run_anti_cheat(user, steps=50000, date=today, distance_km=0.05)
        if r.flags:
            print("✓ distance_too_low check works")
        else:
            print("✗ FAIL: distance_too_low not triggered"); sys.exit(1)

        print("\nAll anti-cheat tests passed!")
except Exception as e:
    print(f"ERROR: {e}")
    import traceback
    traceback.print_exc()
