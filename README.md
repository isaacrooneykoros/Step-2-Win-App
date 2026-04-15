# Step2Win

**Step2Win** is a walk-to-earn fitness challenge platform that motivates users to stay active by rewarding them for hitting step milestones. Users join or create walking challenges, fund their entries through a built-in wallet, track their steps via Google Fit or Apple Health, and earn real money when they reach their goal.

---

## What the App Does

- **Step Tracking** – Users sync their daily steps from Google Fit (Android) or Apple Health (iOS). The platform records and validates step data with built-in anti-cheat detection to prevent fraud.
- **Challenges** – Users can create or join 7-day walking challenges. Each challenge has a step milestone target (50,000 / 70,000 / 90,000 steps) and an entry fee. Participants who hit the milestone by the end of the challenge share the prize pool.
- **Wallet** – Every user has an in-app wallet. They can deposit funds via mobile money (STK Push) and withdraw winnings directly to their mobile money account. All transactions are tracked with full history.
- **Leaderboards** – Each challenge has a live leaderboard showing participant rankings and progress.
- **Admin Panel** – A separate admin dashboard for platform operators to monitor users, challenges, transactions, and fraud flags, and to approve or reject withdrawals.
- **Automated Payouts** – When a challenge ends, a scheduled background job automatically calculates and distributes winnings to qualifying participants, refunds non-qualifiers, and deducts the platform fee.

---

## Project Structure

The repository is organized into three main parts:

```
Step-2-Win-App/
├── backend/           # Django REST API
├── step2win-web/      # React + TypeScript web & Android app (Capacitor)
└── step2win-admin/    # React admin dashboard
```

### `backend/` — Django REST API

The core server-side application powering all business logic and data.

- **Framework**: Django 5 + Django REST Framework
- **Database**: PostgreSQL
- **Task Queue**: Celery with Redis as the message broker
- **Authentication**: JWT (JSON Web Tokens) with token rotation
- **Payments**: IntaSend payment gateway (mobile money STK Push for deposits, send-money for withdrawals)

Key Django apps:

| App | Responsibility |
|---|---|
| `users` | Registration, login, profiles, device binding |
| `wallet` | Deposits, withdrawals, transaction history |
| `steps` | Step sync, daily records, fraud/anti-cheat detection |
| `challenges` | Challenge creation, joining, leaderboards, finalization |
| `payments` | Payment gateway integration |
| `gamification` | Streaks and user engagement features |
| `legal` | Terms of service and privacy policy endpoints |
| `admin_api` | Endpoints for the admin dashboard |

**Business rules:**
- Challenge duration: 7 days
- Step milestones: 50,000 / 70,000 / 90,000 steps
- Daily step cap: 60,000 steps (anti-cheat)
- Platform fee: 5% of the total prize pool
- Minimum withdrawal: configurable per deployment

**Scheduled tasks (Celery Beat):**
- Daily challenge finalization and payout distribution
- User streak calculation
- Cleanup of reviewed fraud flags

### `step2win-web/` — Mobile & Web Frontend

A React + TypeScript single-page application that also runs as a native Android app through Capacitor.

- **Framework**: Vite + React 18 + TypeScript
- **Styling**: Tailwind CSS (dark theme)
- **State**: Zustand (auth/global) + TanStack Query (server data)
- **Mobile**: Capacitor 5 for Android packaging

Key screens: Login, Register, Home (dashboard), Challenges, Challenge Detail, Wallet, Profile.

### `step2win-admin/` — Admin Dashboard

A separate React + TypeScript web application for platform operators.

- User management and monitoring
- Challenge oversight
- Transaction and withdrawal management
- Fraud detection review

---

## Tech Stack Summary

| Layer | Technology |
|---|---|
| Backend | Django 5, Django REST Framework |
| Database | PostgreSQL |
| Cache / Queue | Redis, Celery |
| Auth | JWT (SimpleJWT) |
| Payments | IntaSend (mobile money) |
| Frontend | React 18, TypeScript, Vite |
| Styling | Tailwind CSS |
| Mobile | Capacitor 5 (Android) |
| Deployment | Render (backend), Vercel/Netlify (frontend) |

---

## How It Works — User Flow

1. **Sign up** and bind your mobile device for step tracking.
2. **Deposit funds** into your wallet via mobile money STK Push.
3. **Join a challenge** by selecting a milestone and paying the entry fee from your wallet.
4. **Walk!** Sync your steps daily — the app pulls data from Google Fit or Apple Health.
5. **Track progress** on the challenge leaderboard.
6. When the 7-day challenge ends, the platform **automatically finalizes results**:
   - Participants who hit the milestone share the prize pool (minus the platform fee).
   - Participants who did not qualify receive a refund.
7. **Withdraw winnings** to your mobile money account.

---

## License

Proprietary — All rights reserved.
