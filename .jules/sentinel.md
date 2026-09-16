# Sentinel's Journal - Critical Learnings

## 2026-05-02 - UserXP Auto-Creation & Signal Handling
**Vulnerability:** Input validation & Stored XSS vulnerability in `award_xp` endpoint.
**Learning:** `UserXP` instances may be created automatically via signals/listeners upon `User` creation. Attempting `UserXP.objects.create(user=user)` in test setups causes an `IntegrityError` due to a UNIQUE constraint failure.
**Prevention:** Always use `UserXP.objects.get_or_create(user=user)` in test setups when creating or obtaining a user's XP profile.
