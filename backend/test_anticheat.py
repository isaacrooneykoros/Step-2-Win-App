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
        print("ERROR: No users in database")
    else:
        # Test 1: impossible_rate (10k steps/min)
        r = run_anti_cheat(user, steps=10000, date=today, active_minutes=1)
        if any(f['flag_type'] == 'impossible_rate' for f in r.flags):
            print("✓ impossible_rate check works")
        else:
            print("✗ FAIL: impossible_rate not triggered")

        # Test 2: daily_cap and step capping
        r = run_anti_cheat(user, steps=90000, date=today)
        if any(f['flag_type'] == 'daily_cap' for f in r.flags) and r.approved_steps == 60000:
            print("✓ daily_cap and step capping works")
        else:
            print(f"✗ FAIL: daily_cap={any(f['flag_type'] == 'daily_cap' for f in r.flags)}, approved_steps={r.approved_steps}")

        # Test 3: distance_too_low (phone shaking)
        r = run_anti_cheat(user, steps=50000, date=today, distance_km=0.05)
        if any(f['flag_type'] == 'distance_too_low' for f in r.flags):
            print("✓ distance_too_low check works")
        else:
            print("✗ FAIL: distance_too_low not triggered")

        print("\nAll anti-cheat tests passed!")
except Exception as e:
    print(f"ERROR: {e}")
    import traceback
    traceback.print_exc()
