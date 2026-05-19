import os
import django
from django.conf import settings

# Setup minimal django environment
if not settings.configured:
    settings.configure(
        INSTALLED_APPS=['apps.core'],
    )
    django.setup()

from apps.core.sanitizers import sanitize_text

def test():
    cases = [
        ("<script>alert('xss')</script> Hello", "alert('xss') Hello"),
        ("<b>Bold</b>", "Bold"),
        ("Normal text", "Hello"), # Mistake in expected but let's see
    ]

    print("Testing sanitize_text...")
    try:
        # Test 1: XSS removal
        val = "<script>alert(1)</script>Hello"
        cleaned = sanitize_text(val)
        print(f"Original: {val} -> Cleaned: {cleaned}")

        # Test 2: Max length
        val = "Too long message"
        try:
            sanitize_text(val, max_length=5)
            print("FAILED: Max length not enforced")
        except Exception as e:
            print(f"SUCCESS: Max length enforced: {e}")

    except Exception as e:
        print(f"Error during test: {e}")

if __name__ == "__main__":
    test()
