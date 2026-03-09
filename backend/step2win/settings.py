import os
from pathlib import Path
from datetime import timedelta
from celery.schedules import crontab
from dotenv import load_dotenv

load_dotenv()
BASE_DIR = Path(__file__).resolve().parent.parent

SECRET_KEY = os.getenv('SECRET_KEY', 'dev-secret-key-change-in-production')
DEBUG = os.getenv('DEBUG', 'True') == 'True'
ALLOWED_HOSTS = os.getenv('ALLOWED_HOSTS', 'localhost,127.0.0.1,testserver').split(',')
USE_REDIS = os.getenv('USE_REDIS', 'False') == 'True'
ENABLE_DEFENDER = os.getenv('ENABLE_DEFENDER', 'False') == 'True'
APP_SIGNING_SECRET = os.getenv('APP_SIGNING_SECRET', 'change-me-in-production')

INSTALLED_APPS = [
    'django.contrib.admin',
    'django.contrib.auth',
    'django.contrib.contenttypes',
    'django.contrib.sessions',
    'django.contrib.messages',
    'django.contrib.staticfiles',
    'channels',
    'rest_framework',
    'rest_framework_simplejwt',
    'rest_framework_simplejwt.token_blacklist',
    'corsheaders',
    'drf_spectacular',
    'django_celery_beat',
    'django_celery_results',
    'apps.users',
    'apps.challenges',
    'apps.wallet',
    'apps.steps',
    'apps.gamification',
    'apps.admin_api',
    'apps.payments',
    'apps.legal',
]

if ENABLE_DEFENDER:
    INSTALLED_APPS.append('defender')

MIDDLEWARE = [
    'django.middleware.security.SecurityMiddleware',
    'step2win.middleware.SecurityHeadersMiddleware',
    'corsheaders.middleware.CorsMiddleware',
    'django.contrib.sessions.middleware.SessionMiddleware',
    'django.middleware.common.CommonMiddleware',
    'django.middleware.csrf.CsrfViewMiddleware',
    'django.contrib.auth.middleware.AuthenticationMiddleware',
    'apps.steps.middleware.HMACSignatureMiddleware',
    'step2win.middleware.UserIsolationAuditMiddleware',
    'django.contrib.messages.middleware.MessageMiddleware',
    'django.middleware.clickjacking.XFrameOptionsMiddleware',
]

if ENABLE_DEFENDER:
    MIDDLEWARE.insert(6, 'defender.middleware.FailedLoginMiddleware')

ROOT_URLCONF = 'step2win.urls'

TEMPLATES = [
    {
        'BACKEND': 'django.template.backends.django.DjangoTemplates',
        'DIRS': [],
        'APP_DIRS': True,
        'OPTIONS': {
            'context_processors': [
                'django.template.context_processors.debug',
                'django.template.context_processors.request',
                'django.contrib.auth.context_processors.auth',
                'django.contrib.messages.context_processors.messages',
            ],
        },
    },
]

WSGI_APPLICATION = 'step2win.wsgi.application'
ASGI_APPLICATION = 'step2win.asgi.application'

CHANNEL_LAYERS = {
    'default': {
        'BACKEND': 'channels.layers.InMemoryChannelLayer',
    },
}

USE_SQLITE = os.getenv('USE_SQLITE', 'False') == 'True'

if USE_SQLITE:
    DATABASES = {
        'default': {
            'ENGINE': 'django.db.backends.sqlite3',
            'NAME': BASE_DIR / 'db.sqlite3',
        }
    }
else:
    DATABASES = {
        'default': {
            'ENGINE': 'django.db.backends.postgresql',
            'NAME': os.getenv('DB_NAME', 'step2win'),
            'USER': os.getenv('DB_USER', 'postgres'),
            'PASSWORD': os.getenv('DB_PASSWORD', ''),
            'HOST': os.getenv('DB_HOST', 'localhost'),
            'PORT': os.getenv('DB_PORT', '5432'),
            'CONN_MAX_AGE': 600,
        }
    }

AUTH_PASSWORD_VALIDATORS = [
    {'NAME': 'django.contrib.auth.password_validation.UserAttributeSimilarityValidator'},
    {'NAME': 'django.contrib.auth.password_validation.MinimumLengthValidator'},
    {'NAME': 'django.contrib.auth.password_validation.CommonPasswordValidator'},
    {'NAME': 'django.contrib.auth.password_validation.NumericPasswordValidator'},
]

LANGUAGE_CODE = 'en-us'
TIME_ZONE = 'UTC'
USE_I18N = True
USE_TZ = True

STATIC_URL = 'static/'
STATIC_ROOT = os.path.join(BASE_DIR, 'staticfiles')

MEDIA_URL = 'media/'
MEDIA_ROOT = os.path.join(BASE_DIR, 'media')

DEFAULT_AUTO_FIELD = 'django.db.models.BigAutoField'

REST_FRAMEWORK = {
    'DEFAULT_AUTHENTICATION_CLASSES': [
        'rest_framework_simplejwt.authentication.JWTAuthentication',
    ],
    'DEFAULT_PERMISSION_CLASSES': [
        'rest_framework.permissions.IsAuthenticated',
    ],
    'DEFAULT_THROTTLE_CLASSES': [
        'rest_framework.throttling.AnonRateThrottle',
        'rest_framework.throttling.UserRateThrottle',
    ],
    'DEFAULT_THROTTLE_RATES': {
        'anon': '100/hour',
        'user': '1000/hour',
        'wallet': '10/minute',
    },
    'DEFAULT_SCHEMA_CLASS': 'drf_spectacular.openapi.AutoSchema',
    'DEFAULT_PAGINATION_CLASS': 'rest_framework.pagination.PageNumberPagination',
    'PAGE_SIZE': 20,
    'EXCEPTION_HANDLER': 'step2win.exceptions.custom_exception_handler',
}

SIMPLE_JWT = {
    # Access token: short-lived for security
    'ACCESS_TOKEN_LIFETIME': timedelta(minutes=30),
    # Refresh token: 30 days for mobile UX
    'REFRESH_TOKEN_LIFETIME': timedelta(days=30),
    # Rotate refresh tokens on every use - old token instantly invalid
    'ROTATE_REFRESH_TOKENS': True,
    # Blacklist old refresh tokens when rotated
    'BLACKLIST_AFTER_ROTATION': True,
    # Update last_login on every token refresh
    'UPDATE_LAST_LOGIN': True,
    'ALGORITHM': 'HS256',
    'SIGNING_KEY': SECRET_KEY,
    'AUTH_HEADER_TYPES': ('Bearer',),
    'USER_ID_FIELD': 'id',
    'USER_ID_CLAIM': 'user_id',
}

SPECTACULAR_SETTINGS = {
    'TITLE': 'Step2Win API',
    'DESCRIPTION': 'Corporate-grade fitness challenge platform',
    'VERSION': '1.0.0',
    'SERVE_INCLUDE_SCHEMA': False,
}

CORS_ALLOWED_ORIGINS = os.getenv(
    'CORS_ALLOWED_ORIGINS',
    'http://localhost:5173,http://127.0.0.1:5173,http://localhost:5174,http://127.0.0.1:5174'
).split(',')
CORS_ALLOW_CREDENTIALS = True

# Use Django database as Celery broker and backend (100% free, no Redis needed)
CELERY_BROKER_URL = os.getenv('CELERY_BROKER_URL', 'sqla+sqlite:///' + str(BASE_DIR / 'celery_broker.sqlite'))
CELERY_RESULT_BACKEND = os.getenv('CELERY_RESULT_BACKEND', 'django-db')
CELERY_BROKER_CONNECTION_RETRY_ON_STARTUP = True
CELERY_BEAT_SCHEDULER = 'django_celery_beat.schedulers:DatabaseScheduler'
CELERY_BEAT_SCHEDULE = {
    'nightly-fraud-scan': {
        'task': 'apps.steps.tasks.nightly_fraud_scan',
        'schedule': crontab(hour=2, minute=0),
    },
    'update-participant-consistency': {
        'task': 'apps.steps.tasks.update_participant_consistency_stats',
        'schedule': crontab(hour=0, minute=5),  # every night at 00:05
    },
    'update-user-streaks': {
        'task': 'apps.steps.tasks.update_user_streak_records',
        'schedule': crontab(hour=0, minute=15),
    },
    'refresh-pochipay-token': {
        'task': 'apps.payments.tasks.refresh_pochipay_token',
        'schedule': crontab(minute=0, hour='*/1'),
    },
    'reconcile-pending-payments': {
        'task': 'apps.payments.tasks.reconcile_pending_payments',
        'schedule': crontab(minute='*/30'),
    },
    'cleanup-inactive-sessions': {
        'task': 'apps.users.tasks.cleanup_inactive_sessions',
        'schedule': crontab(hour=3, minute=0),  # 3AM every night
    },
}
CELERY_TASK_SERIALIZER = 'json'
CELERY_RESULT_SERIALIZER = 'json'
CELERY_ACCEPT_CONTENT = ['json']
CELERY_TIMEZONE = TIME_ZONE

if USE_REDIS:
    CACHES = {
        'default': {
            'BACKEND': 'django.core.cache.backends.redis.RedisCache',
            'LOCATION': os.getenv('REDIS_URL', 'redis://localhost:6379/1'),
        }
    }
else:
    CACHES = {
        'default': {
            'BACKEND': 'django.core.cache.backends.locmem.LocMemCache',
            'LOCATION': 'step2win-local-cache',
        }
    }

# Security settings (production)
if not DEBUG:
    SECURE_SSL_REDIRECT = True
    SESSION_COOKIE_SECURE = True
    CSRF_COOKIE_SECURE = True
    SECURE_HSTS_SECONDS = 31536000
    SECURE_HSTS_INCLUDE_SUBDOMAINS = True
    SECURE_HSTS_PRELOAD = True
    X_FRAME_OPTIONS = 'DENY'
    SECURE_CONTENT_TYPE_NOSNIFF = True
    SECURE_BROWSER_XSS_FILTER = True

# Additional security headers (all environments)
SECURE_BROWSER_XSS_FILTER = True
SECURE_CONTENT_TYPE_NOSNIFF = True
X_FRAME_OPTIONS = 'DENY'
SECURE_REFERRER_POLICY = 'same-origin'

# Brute force protection
MAX_LOGIN_ATTEMPTS = 5
LOGIN_LOCKOUT_MINUTES = 15

# Django Defender settings
if ENABLE_DEFENDER:
    DEFENDER_COOLOFF_TIME = 300  # 5 min lockout
    DEFENDER_LOGIN_FAILURE_LIMIT = 5
    DEFENDER_LOCKOUT_TEMPLATE = None
    DEFENDER_USE_CELERY = True
    DEFENDER_REDIS_URL = os.getenv('REDIS_URL', 'redis://localhost:6379/0')

AUTH_USER_MODEL = 'users.User'

# PochPay Configuration
POCHIPAY_BASE_URL = 'https://app.pochipay.com/api/v1'
POCHIPAY_EMAIL = os.getenv('POCHIPAY_EMAIL', '')
POCHIPAY_PASSWORD = os.getenv('POCHIPAY_PASSWORD', '')

# Callback URLs - must be public, unauthenticated POST endpoints
POCHIPAY_DEPOSIT_CALLBACK_URL = os.getenv(
    'POCHIPAY_DEPOSIT_CALLBACK_URL',
    'https://api.step2win.com/api/payments/mpesa/deposit-callback/'
)
POCHIPAY_PAYOUT_CALLBACK_URL = os.getenv(
    'POCHIPAY_PAYOUT_CALLBACK_URL',
    'https://api.step2win.com/api/payments/mpesa/payout-callback/'
)
POCHIPAY_WITHDRAWAL_CALLBACK_URL = os.getenv(
    'POCHIPAY_WITHDRAWAL_CALLBACK_URL',
    'https://api.step2win.com/api/payments/mpesa/withdrawal-callback/'
)

# Step2Win business rules
PLATFORM_FEE_PERCENT = 5
MIN_DEPOSIT_KES = 10
MAX_DEPOSIT_KES = 100_000
MIN_WITHDRAWAL_KES = 10
MAX_WITHDRAWAL_KES = 70_000
MAX_DAILY_WITHDRAWAL = 150_000
WITHDRAWAL_FEE_KES = 0
WITHDRAWAL_AUTO_APPROVE_LIMIT = 0

# Withdrawal security limits
MAX_WITHDRAWALS_PER_DAY = 3
MAX_WITHDRAWALS_PER_HOUR = 1
MIN_SECONDS_BETWEEN_WITHDRAWALS = 300  # 5 minutes
MAX_DAILY_WITHDRAWAL_AMOUNT_KES = 100_000

# Sentry integration (optional - install sentry-sdk if needed)
# import sentry_sdk
# if os.getenv('SENTRY_DSN'):
#     sentry_sdk.init(
#         dsn=os.getenv('SENTRY_DSN'),
#         traces_sample_rate=0.1,
#         environment='production' if not DEBUG else 'development'
#     )
