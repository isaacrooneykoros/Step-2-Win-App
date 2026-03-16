# Step2Win Backend

Corporate-grade fitness challenge platform backend built with Django.

## Features

- **User Management**: Registration, authentication, profile management
- **Wallet System**: Deposits, withdrawals, transaction history
- **Step Tracking**: Daily step sync with fraud detection
- **Challenges**: Create/join walking challenges with entry fees
- **Automated Payouts**: Celery tasks for challenge finalization

## Tech Stack

- Django 5.0
- Django REST Framework
- PostgreSQL
- Redis + Celery
- JWT Authentication
- OpenAPI/Swagger Documentation

## Quick Start

### Prerequisites

- Python 3.11+
- PostgreSQL 14+
- Redis 7+

### Installation

```bash
# Create virtual environment
python -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt

# Setup environment
cp .env.example .env
# Edit .env with your settings

# Run migrations
python manage.py makemigrations
python manage.py migrate

# Create superuser
python manage.py createsuperuser

# Run development server
python manage.py runserver
```

### Running Celery

```bash
# Worker
celery -A step2win worker -l info

# Beat scheduler (in separate terminal)
celery -A step2win beat -l info
```

## API Documentation

After starting the server, visit:

- Swagger UI: http://localhost:8000/api/docs/
- ReDoc: http://localhost:8000/api/redoc/
- Schema: http://localhost:8000/api/schema/

## API Endpoints

### Authentication
- `POST /api/auth/register/` - Register new user
- `POST /api/auth/login/` - Login
- `POST /api/auth/logout/` - Logout
- `POST /api/auth/refresh/` - Refresh token
- `GET/PUT /api/auth/profile/` - User profile
- `POST /api/auth/change-password/` - Change password
- `POST /api/auth/bind-device/` - Bind device for step tracking
- `GET /api/auth/device-status/` - Device status
- `GET /api/auth/stats/` - User statistics

### Challenges
- `GET /api/challenges/` - List challenges
- `POST /api/challenges/create/` - Create challenge
- `POST /api/challenges/join/` - Join challenge
- `GET /api/challenges/my-challenges/` - My challenges
- `GET /api/challenges/<id>/` - Challenge detail
- `GET /api/challenges/<id>/leaderboard/` - Leaderboard
- `GET /api/challenges/<id>/stats/` - Challenge stats
- `POST /api/challenges/<id>/leave/` - Leave challenge

### Wallet
- `GET /api/wallet/summary/` - Wallet summary
- `GET /api/wallet/transactions/` - Transaction history
- `GET /api/wallet/transactions/stats/` - Transaction stats
- `POST /api/wallet/deposit/` - Deposit funds
- `POST /api/wallet/withdraw/` - Request withdrawal
- `GET /api/wallet/withdrawals/` - Withdrawal history
- `GET /api/wallet/withdrawals/<ref>/` - Withdrawal detail

### Steps
- `POST /api/steps/sync/` - Sync steps from device
- `GET /api/steps/today/` - Today's steps
- `GET /api/steps/weekly/` - Weekly steps
- `GET /api/steps/daily/` - Daily step history
- `GET /api/steps/stats/` - Step statistics
- `GET/POST/PUT /api/steps/goal/` - Step goals

## Business Rules

- Challenge duration: 7 days
- Milestone options: 50k / 70k / 90k steps
- Entry fee range: $1 - $1,000
- Platform fee: 5% of total pool
- Daily step cap: 60,000 steps
- Spike detection: 10× recent average
- Min withdrawal: $10
- Max deposit: $10,000

## Database Models

### User
- Custom user model with wallet balance
- Device binding for step tracking
- Stats: total steps, challenges won, total earned

### Challenge
- Milestone-based fitness challenge
- Entry fee and prize pool
- Status: pending/active/completed
- Unique invite code

### Participant
- Links user to challenge
- Tracks steps and qualification status
- Payout calculation

### WalletTransaction
- All financial transactions
- Types: deposit, withdrawal, entry, payout, fee

### DailySteps
- Daily step count records
- Source tracking (Google Fit, Apple Health)
- Fraud detection flags

## Celery Tasks

### finalize_completed_challenges
- Runs daily at 00:05 UTC
- Distributes payouts to qualified participants
- Refunds non-qualified participants
- Calculates platform fees

### calculate_user_streaks
- Updates user streak counts
- Tracks consecutive active days

### cleanup_old_suspicious_activities
- Removes reviewed fraud flags older than 90 days

## Security Features

- JWT authentication with token rotation
- Rate limiting (10 req/min for wallet operations)
- Brute force protection (5 failed attempts = 5 min lockout)
- CORS configuration
- SQL injection protection
- XSS protection
- HTTPS enforcement in production

## Admin Interface

Access at http://localhost:8000/admin/

Features:
- User management
- Challenge monitoring
- Transaction history
- Fraud detection review
- Withdrawal approval/rejection

## Development

### Running Tests

```bash
python manage.py test
```

### Creating Migrations

```bash
python manage.py makemigrations
python manage.py migrate
```

### Collecting Static Files

```bash
python manage.py collectstatic
```

## Production Deployment

### Using Gunicorn

```bash
gunicorn step2win.wsgi:application --bind 0.0.0.0:8000 --workers 4
```

### Deploying To Render

Recommended Render setup:

- Web service: Django + Gunicorn
- PostgreSQL: Render managed Postgres
- Redis: Render managed Redis
- Worker service: Celery worker
- Worker service: Celery beat

Backend helper scripts included in this repo:

```bash
bash render-build.sh
bash render-start.sh
bash render-worker.sh
bash render-beat.sh
```

Suggested Render commands:

- Build Command:

```bash
bash render-build.sh
```

- Start Command:

```bash
bash render-start.sh
```

- Celery Worker Command:

```bash
bash render-worker.sh
```

- Celery Beat Command:

```bash
bash render-beat.sh
```

Minimum production environment variables:

- `DJANGO_ENV=production`
- `DEBUG=False`
- `SECRET_KEY=<strong random value>`
- `APP_SIGNING_SECRET=<strong random value>`
- `ALLOWED_HOSTS=<your-render-domain>`
- `CSRF_TRUSTED_ORIGINS=https://<your-render-domain>`
- `CORS_ALLOWED_ORIGINS=https://<your-frontend-domain>`
- `DATABASE_URL=<render postgres internal database url>`
- `REDIS_URL=<render redis internal url>`
- `USE_SQLITE=False`
- `USE_REDIS=True`

After first deploy, run:

```bash
python manage.py migrate
python manage.py check --deploy
python manage.py createsuperuser
```

Verify the deployment at:

- `/api/health/`
- `/<DJANGO_ADMIN_URL>`

### Environment Variables

Required for production:
- `SECRET_KEY` - Django secret key
- `DEBUG=False`
- `ALLOWED_HOSTS` - Your domain
- `DB_*` - PostgreSQL credentials
- `REDIS_URL` - Redis connection
- `CORS_ALLOWED_ORIGINS` - Frontend URLs
- `SENTRY_DSN` - Error tracking (optional)

### Nginx Configuration

```nginx
upstream step2win {
    server 127.0.0.1:8000;
}

server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://step2win;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    location /static/ {
        alias /path/to/staticfiles/;
    }
}
```

## Support

For issues and questions, please contact the development team.

## License

Proprietary - All rights reserved
