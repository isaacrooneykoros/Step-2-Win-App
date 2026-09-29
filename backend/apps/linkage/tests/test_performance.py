"""
Nightly recompute on a synthetic 5,000-account dataset: time and peak memory.

Data: 5,000 accounts; 100 phones shared by 3 accounts each; 50 withdrawals to another
account's number; 100 shared deposit numbers; 30 near-sequential registration bursts;
login IPs mostly behind 20 carrier-NAT /24s; 7 days of hourly steps (350,000 rows)
with 40 twin pairs; 32,000 GPS fixes with 20 co-walking pairs; 150 small challenges.
"""

import random
import time
from datetime import datetime, timedelta
from datetime import timezone as dt_timezone
from decimal import Decimal

from django.contrib.auth import get_user_model
from django.test import TestCase
from django.utils import timezone

from apps.challenges.models import Challenge, Participant
from apps.linkage.detectors import live_strong_edges
from apps.linkage.models import LinkCluster, LinkEdge
from apps.linkage.store import local_today, recompute_linkage
from apps.payments.models import PaymentTransaction, WithdrawalRequest
from apps.steps.models import DeviceRegistration, HealthRecord, HourlyStepRecord, LocationWaypoint
from apps.users.models import DeviceSession

User = get_user_model()
N_USERS = 5000
DAYS = 7
MAX_SECONDS = 180
MAX_PEAK_MB = 250


class SyntheticPerformanceTest(TestCase):
    def build(self):
        rnd = random.Random(42)
        now = timezone.now()
        today = local_today()
        numbers = rnd.sample(range(700_000_000, 799_999_999, 1000), N_USERS)
        # 30 registration bursts of 5 near-sequential numbers joined within days.
        for burst in range(30):
            base = 710_000_000 + burst * 100_000
            for k in range(5):
                numbers[burst * 5 + k] = base + k
        users = [User(username=f"u{i}", email=f"u{i}@ex.com", phone_number=f"254{numbers[i]}",
                      password="!", date_joined=now - timedelta(days=rnd.randint(1, 400)))
                 for i in range(N_USERS)]
        for burst in range(30):
            for k in range(5):
                users[burst * 5 + k].date_joined = now - timedelta(days=100 + burst, hours=k)
        User.objects.bulk_create(users, batch_size=1000)
        ids = list(User.objects.order_by("pk").values_list("pk", flat=True))
        phones = dict(User.objects.values_list("pk", "phone_number"))

        regs = [DeviceRegistration(user_id=u, device_id=f"dev-{u:08d}-{'x' * 30}", platform="android") for u in ids]
        for f in range(100):  # 100 farm phones, 3 accounts each
            for k in range(3):
                regs.append(DeviceRegistration(user_id=ids[1000 + f * 3 + k], device_id=f"farm-{f:04d}-{'y' * 30}",
                                               platform="android"))
        DeviceRegistration.objects.bulk_create(regs, batch_size=2000)

        pays = []
        for i in range(2000):
            u = ids[rnd.randrange(N_USERS)]
            phone = phones[ids[2000 + i % 100]] if i < 100 else phones[u]
            pays.append(PaymentTransaction(user_id=u, type="deposit", amount_kes=Decimal("100"), order_id=f"o{i}",
                                           tracking_reference=f"t{i}", phone_number=phone, narration="d"))
        PaymentTransaction.objects.bulk_create(pays, batch_size=1000)
        wds = [WithdrawalRequest(user_id=ids[3000 + i], amount_kes=Decimal("100"), method="mpesa",
                                 phone_number=phones[ids[3500 + i]] if i < 50 else phones[ids[3000 + i]],
                                 tracking_reference=f"w{i}") for i in range(1000)]
        WithdrawalRequest.objects.bulk_create(wds, batch_size=1000)

        sessions = []
        for n, u in enumerate(ids):
            if n % 5:
                ip = f"105.{160 + n % 20}.{n % 20}.{n % 250 + 1}"          # carrier NAT hubs
            else:
                ip = f"41.{90 + n % 50}.{(n // 10) % 250}.{n % 250 + 1}"  # home-sized networks
            sessions.append(DeviceSession(user_id=u, refresh_jti=f"j{n}", ip_address=ip, last_active_at=now))
        DeviceSession.objects.bulk_create(sessions, batch_size=2000)

        hourly, health = [], []
        for n, u in enumerate(ids):
            for d in range(1, DAYS + 1):
                day = today - timedelta(days=d)
                src = ids[n - 1] if (4000 <= n < 4080 and n % 2) else u  # 40 twin pairs
                r2 = random.Random(src * 100 + d)
                hours = r2.sample(range(5, 22), 10)
                total = 0
                for h in hours:
                    s = r2.randint(100, 1500)
                    total += s
                    hourly.append(HourlyStepRecord(user_id=u, date=day, hour=h, steps=s))
                health.append(HealthRecord(user_id=u, date=day, steps=total, last_raw_steps=total))
        HourlyStepRecord.objects.bulk_create(hourly, batch_size=5000)
        HealthRecord.objects.bulk_create(health, batch_size=5000)
        del hourly, health

        wps = []
        for n in range(400):
            u = ids[n]
            for d in (1, 2):
                day = today - timedelta(days=d)
                pair_base = n - 1 if (n < 40 and n % 2) else n  # 20 co-walking pairs
                start = datetime(day.year, day.month, day.day, 4 + pair_base % 12, 0, tzinfo=dt_timezone.utc)
                lat0 = -1.2 - pair_base * 0.01
                for m in range(40):
                    at = start + timedelta(minutes=m)
                    wps.append(LocationWaypoint(user_id=u, date=day, hour=at.hour, recorded_at=at,
                                                latitude=lat0 + m * 0.00005, longitude=36.8, accuracy_m=10))
        LocationWaypoint.objects.bulk_create(wps, batch_size=5000)

        creator = ids[0]
        parts = []
        for c in range(150):
            ch = Challenge.objects.create(creator_id=creator, name=f"C{c}", entry_fee=Decimal("50"), milestone=5000,
                                          start_date=today - timedelta(days=20), end_date=today - timedelta(days=5),
                                          status="completed", total_pool=Decimal("1000"))
            for k in range(20):
                parts.append(Participant(challenge=ch, user_id=ids[(c * 20 + k) % N_USERS], steps=6000,
                                         qualified=bool(k % 3)))
        Participant.objects.bulk_create(parts, batch_size=2000)
        return ids

    def test_5000_accounts(self):
        t0 = time.monotonic()
        ids = self.build()
        setup_s = time.monotonic() - t0

        t1 = time.monotonic()
        first = recompute_linkage()
        run_s = time.monotonic() - t1
        second = recompute_linkage(measure_memory=True)   # idempotent re-run, traced for memory

        t2 = time.monotonic()
        live = live_strong_edges(ids[1000:1050])           # settlement: 50 participants
        live_s = time.monotonic() - t2

        by_type = {t: LinkEdge.objects.filter(edge_type=t).count() for t, _ in LinkEdge.TYPE_CHOICES}
        print(f"\n[linkage perf] setup {setup_s:.1f}s; recompute {run_s:.1f}s; traced re-run "
              f"{second['seconds']}s peak {second['peak_mb']} MB; settlement live check {live_s * 1000:.0f} ms "
              f"({len(live)} strong edges); edges {by_type}; clusters {first['clusters']}")
        print(f"[linkage perf] detector seconds: "
              f"{ {k: v.get('seconds') for k, v in first['detectors'].items() if isinstance(v, dict)} }")

        self.assertLess(run_s, MAX_SECONDS)
        self.assertLess(second["peak_mb"], MAX_PEAK_MB)
        self.assertEqual((second["edges"]["created"], second["edges"]["updated"], second["edges"]["deactivated"]),
                         (0, 0, 0))
        self.assertEqual(by_type["shared_device"], 300)          # 100 phones x 3 pairs
        self.assertGreaterEqual(by_type["shared_payout_account"], 50)
        self.assertGreaterEqual(by_type["twin_curves"], 40)
        self.assertGreaterEqual(by_type["co_location"], 20)
        self.assertGreaterEqual(by_type["phone_sequence"], 30 * 10)
        self.assertEqual(by_type["shared_network"] and LinkEdge.objects.filter(
            edge_type="shared_network", evidence__accounts_on_network__gt=6).count(), 0)
        self.assertGreaterEqual(LinkCluster.objects.filter(size=3).count(), 100)
        self.assertLess(live_s, 5)
