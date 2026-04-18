import os
import secrets
import sys
import hashlib
from pathlib import Path
from datetime import timedelta
from celery.schedules import crontab
import dj_database_url
import sentry_sdk
from dotenv import load_dotenv
from django.core.exceptions import ImproperlyConfigured

load_dotenv()
BASE_DIR = Path(__file__).resolve().parent.parent

_MANAGE_PY_BOOTSTRAP_COMMANDS = {
    'check',
    'collectstatic',
    'migrate',
    'showmigrations',
}
_CURRENT_MANAGEMENT_COMMAND = sys.argv[1] if len(sys.argv) > 1 and sys.argv[0].endswith('manage.py') else ''
_ALLOW_BOOTSTRAP_SECRET_FALLBACKS = _CURRENT_MANAGEMENT_COMMAND in _MANAGE_PY_BOOTSTRAP_COMMANDS

ENVIRONMENT = os.getenv('DJANGO_ENV', 'development').strip().lower()
DEBUG = os.getenv('DEBUG', 'False').strip().lower() == 'true'
SECRET_KEY = os.getenv('SECRET_KEY', '')
if not SECRET_KEY:
    raise ImproperlyConfigured('SECRET_KEY environment variable is required.')

ALLOWED_HOSTS = [
    host.strip()
    for host in os.getenv('ALLOWED_HOSTS', 'localhost,127.0.0.1,testserver').split(',')
    if host.strip()
]
if not ALLOWED_HOSTS:
    raise ImproperlyConfigured('ALLOWED_HOSTS cannot be empty.')

if not DEBUG and not _ALLOW_BOOTSTRAP_SECRET_FALLBACKS:
    if SECRET_KEY.startswith('django-insecure-') or len(SECRET_KEY) < 50:
        raise ImproperlyConfigured('Production SECRET_KEY must be random and at least 50 characters long.')
    if any(host in {'localhost', '127.0.0.1', 'testserver'} for host in ALLOWED_HOSTS):
        raise ImproperlyConfigured('Production ALLOWED_HOSTS cannot contain localhost/testserver values.')
USE_REDIS = os.getenv('USE_REDIS', 'True' if os.getenv('REDIS_URL') else 'False') == 'True'
ENABLE_DEFENDER = os.getenv('ENABLE_DEFENDER', 'True' if os.getenv('REDIS_URL') else 'False') == 'True'
APP_SIGNING_SECRET = os.environ.get('APP_SIGNING_SECRET', '')
if not APP_SIGNING_SECRET and not _ALLOW_BOOTSTRAP_SECRET_FALLBACKS:
    raise ImproperlyConfigured('APP_SIGNING_SECRET environment variable is required.')
if not APP_SIGNING_SECRET:
    APP_SIGNING_SECRET = SECRET_KEY

INSTALLED_APPS = [
    'daphne',
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
    'axes',
    'auditlog',
]

if ENABLE_DEFENDER:
    INSTALLED_APPS.append('defender')

MIDDLEWARE = [
    'django.middleware.security.SecurityMiddleware',
    'whitenoise.middleware.WhiteNoiseMiddleware',
    'step2win.middleware.SecurityHeadersMiddleware',
    'corsheaders.middleware.CorsMiddleware',
    'django.contrib.sessions.middleware.SessionMiddleware',
    'django.middleware.common.CommonMiddleware',
    'django.middleware.csrf.CsrfViewMiddleware',
    'django.contrib.auth.middleware.AuthenticationMiddleware',
    'axes.middleware.AxesMiddleware',
    'apps.steps.middleware.HMACSignatureMiddleware',
    'step2win.middleware.UserIsolationAuditMiddleware',
    'django.contrib.messages.middleware.MessageMiddleware',
    'django.middleware.clickjacking.XFrameOptionsMiddleware',
]

AUTHENTICATION_BACKENDS = [
    'axes.backends.AxesStandaloneBackend',  # Must be first
    'django.contrib.auth.backends.ModelBackend',
]

if ENABLE_DEFENDER:
    MIDDLEWARE.insert(8, 'defender.middleware.FailedLoginMiddleware')

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

if os.getenv('REDIS_URL'):
    CHANNEL_LAYERS = {
        'default': {
            'BACKEND': 'channels_redis.core.RedisChannelLayer',
            'CONFIG': {
                'hosts': [os.getenv('REDIS_URL')],
            },
        },
    }
else:
    CHANNEL_LAYERS = {
        'default': {
            'BACKEND': 'channels.layers.InMemoryChannelLayer',
        },
    }

USE_SQLITE = os.getenv('USE_SQLITE', 'False') == 'True'
DATABASE_URL = os.getenv('DATABASE_URL', '').strip()

if DATABASE_URL:
    # Render Postgres should always use SSL, including local development against remote DB.
    require_ssl = (not DEBUG) or ('render.com' in DATABASE_URL)
    DATABASES = {
        'default': dj_database_url.parse(
            DATABASE_URL,
            conn_max_age=600,
            ssl_require=require_ssl,
        )
    }
elif USE_SQLITE:
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

STATIC_URL = '/static/'
STATIC_ROOT = os.path.join(BASE_DIR, 'staticfiles')
STORAGES = {
    'default': {
        'BACKEND': 'django.core.files.storage.FileSystemStorage',
    },
    'staticfiles': {
        'BACKEND': 'whitenoise.storage.CompressedManifestStaticFilesStorage',
    },
}

MEDIA_URL = '/media/'
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
        # Global defaults
        'anon':           '300/hour',
        'user':           '3000/hour',
        # Auth endpoints
        'login':          '5/minute',
        'admin_login':    '3/minute',
        'register':       '3/minute',
        'password_reset': '3/hour',
        # Financial endpoints
        'deposit':        '5/minute',
        'withdrawal':     '3/minute',
        # Activity endpoints
        'step_sync':      '10/minute',
        'chat':           '30/minute',
        'dashboard_read': '180/minute',
        'profile_picture_upload': '10/hour',
        'device_bind':    '10/hour',
        # Legacy
        'wallet':         '10/minute',
    },
    'DEFAULT_SCHEMA_CLASS': 'drf_spectacular.openapi.AutoSchema',
    'DEFAULT_PAGINATION_CLASS': 'rest_framework.pagination.PageNumberPagination',
    'PAGE_SIZE': 20,
    'EXCEPTION_HANDLER': 'step2win.exceptions.custom_exception_handler',
}

SIMPLE_JWT = {
    'ACCESS_TOKEN_LIFETIME':    timedelta(minutes=30),
    'REFRESH_TOKEN_LIFETIME':   timedelta(days=7),    # Reduced from 30 to 7 days
    'ROTATE_REFRESH_TOKENS':    True,
    'BLACKLIST_AFTER_ROTATION': True,
    'UPDATE_LAST_LOGIN':        True,
    'ALGORITHM':                'HS256',
    'SIGNING_KEY':              os.getenv('JWT_SIGNING_KEY', '').strip() or SECRET_KEY,
    'AUTH_HEADER_TYPES':        ('Bearer',),
    'USER_ID_FIELD':            'id',
    'USER_ID_CLAIM':            'user_id',
    'AUTH_TOKEN_CLASSES':       ('rest_framework_simplejwt.tokens.AccessToken',),
    'TOKEN_TYPE_CLAIM':         'token_type',
}

SPECTACULAR_SETTINGS = {
    'TITLE': 'Step2Win API',
    'DESCRIPTION': 'Corporate-grade fitness challenge platform',
    'VERSION': '1.0.0',
    'SERVE_INCLUDE_SCHEMA': False,
    'OPERATION_ID_METHOD_POSITION': 'POST',
    'ENUM_NAME_OVERRIDES': {
        'ChallengeStatusEnum': 'apps.challenges.models.Challenge.STATUS_CHOICES',
        'SupportTicketStatusEnum': 'apps.admin_api.models.SupportTicket.STATUS_CHOICES',
        'WithdrawalStatusEnum': 'apps.wallet.models.Withdrawal.STATUS_CHOICES',
        'LegalDocumentStatusEnum': 'apps.legal.models.LegalDocument.STATUS_CHOICES',
    },
}

# Mobile app origins that must always be allowed so Capacitor Android/iOS can reach
# the backend regardless of what CORS_ALLOWED_ORIGINS is set to in the environment.
_CORS_REQUIRED_NATIVE = [
    'http://localhost',
    'https://localhost',
    'capacitor://localhost',
    'ionic://localhost',
]
_CORS_DEFAULT_DEV = [
    'http://localhost:5173', 'http://127.0.0.1:5173',
    'http://localhost:5174', 'http://127.0.0.1:5174',
]
_CORS_REQUIRED_WEB = [
    'https://step-2-win-app.vercel.app',
]
_cors_explicit = [
    o.strip()
    for o in os.getenv('CORS_ALLOWED_ORIGINS', '').split(',')
    if o.strip()
]
# Always prepend the required native origins; use dict.fromkeys to deduplicate
# while preserving order. If an explicit list was supplied in the env var it is
# used; otherwise fall back to the local-dev defaults.
CORS_ALLOWED_ORIGINS = list(dict.fromkeys(
    _CORS_REQUIRED_NATIVE + _CORS_REQUIRED_WEB + (_cors_explicit if _cors_explicit else _CORS_DEFAULT_DEV)
))
CORS_ALLOW_CREDENTIALS = True
CORS_ALLOW_METHODS = ['DELETE', 'GET', 'OPTIONS', 'PATCH', 'POST', 'PUT']
CORS_ALLOW_HEADERS = [
    'accept', 'accept-encoding', 'authorization',
    'content-type', 'dnt', 'origin', 'user-agent',
    'x-csrftoken', 'x-requested-with',
    # Custom headers used by the mobile app for step-sync request signing
    'x-app-signature', 'x-timestamp', 'x-idempotency-key',
]

# Prefer Redis in hosted environments when REDIS_URL is present.
DEFAULT_CELERY_BROKER_URL = os.getenv('REDIS_URL', 'sqla+sqlite:///' + str(BASE_DIR / 'celery_broker.sqlite3')) if USE_REDIS else 'sqla+sqlite:///' + str(BASE_DIR / 'celery_broker.sqlite3')
CELERY_BROKER_URL = os.getenv('CELERY_BROKER_URL', DEFAULT_CELERY_BROKER_URL)
CELERY_RESULT_BACKEND = os.getenv('CELERY_RESULT_BACKEND', 'django-db')
CELERY_BROKER_CONNECTION_RETRY_ON_STARTUP = True
CELERY_BEAT_SCHEDULER = 'django_celery_beat.schedulers:DatabaseScheduler'
CELERY_BEAT_SCHEDULE = {
    'nightly-fraud-scan': {
        'task': 'apps.steps.tasks.nightly_fraud_scan',
        'schedule': crontab(hour=2, minute=0),
    },
    'finalize-completed-challenges': {
        'task': 'apps.steps.tasks.finalize_completed_challenges',
        'schedule': crontab(hour=0, minute=5),
    },
    'update-participant-consistency': {
        'task': 'apps.steps.tasks.update_participant_consistency_stats',
        'schedule': crontab(hour=0, minute=5),  # every night at 00:05
    },
    'update-user-streaks': {
        'task': 'apps.steps.tasks.update_user_streak_records',
        'schedule': crontab(hour=0, minute=15),
    },
    'reconcile-pending-payments': {
        'task': 'apps.payments.tasks.reconcile_pending_payments',
        'schedule': crontab(minute='*/30'),
    },
    'process-unprocessed-callbacks': {
        'task': 'apps.payments.tasks.process_unprocessed_callbacks',
        'schedule': crontab(minute='*/5'),  # Every 5 minutes
    },
    'monitor-new-non-topup-funded-accounts': {
        'task': 'apps.users.tasks.monitor_new_non_topup_funded_accounts',
        'schedule': crontab(hour=2, minute=20),  # 2:20 AM every night
    },
    'check-wallet-balance-consistency': {
        'task': 'apps.users.tasks.check_wallet_balance_consistency',
        'schedule': crontab(hour=2, minute=30),  # 2:30 AM every night
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

if USE_REDIS and os.getenv('REDIS_URL'):
    CACHES = {
        'default': {
            'BACKEND': 'django.core.cache.backends.redis.RedisCache',
            'LOCATION': os.getenv('REDIS_URL'),
        }
    }
else:
    CACHES = {
        'default': {
            'BACKEND': 'django.core.cache.backends.locmem.LocMemCache',
            'LOCATION': 'step2win-local-cache',
        }
    }

# ── Security headers (all environments) ─────────────────────────────────────
SECURE_BROWSER_XSS_FILTER  = True
SECURE_CONTENT_TYPE_NOSNIFF = True
X_FRAME_OPTIONS              = 'DENY'
SECURE_REFERRER_POLICY       = 'strict-origin-when-cross-origin'

# ── Production-only security ──────────────────────────────────────────────────
if not DEBUG:
    SECURE_SSL_REDIRECT              = os.getenv('SECURE_SSL_REDIRECT', 'True').strip().lower() == 'true'
    SECURE_PROXY_SSL_HEADER          = ('HTTP_X_FORWARDED_PROTO', 'https')
    SECURE_HSTS_SECONDS              = int(os.getenv('SECURE_HSTS_SECONDS', '31536000'))
    SECURE_HSTS_INCLUDE_SUBDOMAINS   = os.getenv('SECURE_HSTS_INCLUDE_SUBDOMAINS', 'True').strip().lower() == 'true'
    SECURE_HSTS_PRELOAD              = os.getenv('SECURE_HSTS_PRELOAD', 'True').strip().lower() == 'true'
    SESSION_COOKIE_SECURE            = True
    SESSION_COOKIE_HTTPONLY          = True
    SESSION_COOKIE_SAMESITE          = 'Lax'
    CSRF_COOKIE_SECURE               = True
    CSRF_COOKIE_HTTPONLY             = True
    CSRF_COOKIE_SAMESITE             = 'Lax'
    SECURE_REDIRECT_EXEMPT           = [r'^api/payments/mpesa/.*/$']

CSRF_TRUSTED_ORIGINS = [
    origin.strip()
    for origin in os.getenv('CSRF_TRUSTED_ORIGINS', '').split(',')
    if origin.strip()
]

if 'https://step-2-win-app.vercel.app' not in CSRF_TRUSTED_ORIGINS:
    CSRF_TRUSTED_ORIGINS.append('https://step-2-win-app.vercel.app')

# ── Django admin URL — obscured to resist automated scanning ─────────────────
ADMIN_URL = os.getenv('DJANGO_ADMIN_URL', '').strip()
if ADMIN_URL and not ADMIN_URL.endswith('/'):
    ADMIN_URL = f'{ADMIN_URL}/'
if not ADMIN_URL:
    ADMIN_URL = f"admin-{secrets.token_urlsafe(12).replace('-', '').replace('_', '').lower()}/"
if not DEBUG and (ADMIN_URL == 'admin-s2w-secure/' or len(ADMIN_URL) < 12):
    # Keep startup healthy even if legacy env values persist on the host.
    derived = hashlib.sha256(SECRET_KEY.encode('utf-8')).hexdigest()[:24]
    ADMIN_URL = f'admin-{derived}/'

# ── django-axes brute force protection ───────────────────────────────────────
AXES_FAILURE_LIMIT                        = 5
AXES_COOLOFF_TIME                         = 1    # 1 hour
AXES_LOCK_OUT_AT_FAILURE                  = True
AXES_LOCKOUT_PARAMETERS                   = [['username', 'ip_address']]
AXES_RESET_ON_SUCCESS                     = True
AXES_ENABLE_ADMIN                         = True
AXES_VERBOSE                              = False

# ── django-defender (backup IP-only lockout) ──────────────────────────────────
MAX_LOGIN_ATTEMPTS = 5
LOGIN_LOCKOUT_MINUTES = 15

if ENABLE_DEFENDER:
    DEFENDER_COOLOFF_TIME        = 3600  # 1 hour
    DEFENDER_LOGIN_FAILURE_LIMIT = 5
    DEFENDER_LOCKOUT_TEMPLATE    = None
    DEFENDER_USE_CELERY          = bool(os.getenv('REDIS_URL'))
    DEFENDER_REDIS_URL           = os.getenv('REDIS_URL', '')

AUTH_USER_MODEL = 'users.User'

# IntaSend Configuration
# Get your API keys from https://payment.intasend.com (live) or https://sandbox.intasend.com (test)
INTASEND_API_KEY = os.getenv('INTASEND_API_KEY', '')          # Secret/Token key
INTASEND_PUBLISHABLE_KEY = os.getenv('INTASEND_PUBLISHABLE_KEY', '')  # Publishable key
INTASEND_WEBHOOK_SECRET = os.getenv('INTASEND_WEBHOOK_SECRET', '')    # Webhook challenge secret
INTASEND_TEST_MODE = os.getenv('INTASEND_TEST_MODE', 'False').strip().lower() == 'true'
if not INTASEND_WEBHOOK_SECRET and not _ALLOW_BOOTSTRAP_SECRET_FALLBACKS:
    raise ImproperlyConfigured('INTASEND_WEBHOOK_SECRET environment variable is required.')

TRUSTED_PROXY_IPS = [
    ip.strip()
    for ip in os.getenv('TRUSTED_PROXY_IPS', '').split(',')
    if ip.strip()
]

# Callback URLs — must be publicly accessible, unauthenticated POST endpoints.
# Register these in the IntaSend dashboard under Settings > Webhooks.
# For deposits (STK Push), configure the webhook URL in the IntaSend dashboard.
# For payouts and withdrawals, callback_url is passed per request.
INTASEND_DEPOSIT_CALLBACK_URL = os.getenv(
    'INTASEND_DEPOSIT_CALLBACK_URL',
    'https://step-2-win-app.onrender.com/api/payments/mpesa/deposit-callback/'
)
INTASEND_PAYOUT_CALLBACK_URL = os.getenv(
    'INTASEND_PAYOUT_CALLBACK_URL',
    'https://step-2-win-app.onrender.com/api/payments/mpesa/payout-callback/'
)
INTASEND_WITHDRAWAL_CALLBACK_URL = os.getenv(
    'INTASEND_WITHDRAWAL_CALLBACK_URL',
    'https://step-2-win-app.onrender.com/api/payments/mpesa/withdrawal-callback/'
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
PROFILE_PICTURE_COOLDOWN_MINUTES = int(os.getenv('PROFILE_PICTURE_COOLDOWN_MINUTES', '10'))
MIN_TRUST_SCORE_FOR_PAID_CHALLENGE = int(os.getenv('MIN_TRUST_SCORE_FOR_PAID_CHALLENGE', '60'))
MIN_CHALLENGES_JOINED_TO_CREATE_PAID_CHALLENGE = int(
    os.getenv('MIN_CHALLENGES_JOINED_TO_CREATE_PAID_CHALLENGE', '1')
)

# Wallet balance management
MAX_LOCKED_BALANCE_PERCENT = int(os.getenv('MAX_LOCKED_BALANCE_PERCENT', '80'))  # Max 80% of wallet can be locked

# ── Sentry error monitoring ───────────────────────────────────────────────────
if os.getenv('SENTRY_DSN'):
    sentry_sdk.init(
        dsn=os.getenv('SENTRY_DSN'),
        traces_sample_rate=0.1,
        environment='production' if not DEBUG else 'development',
    )

# ── Structured logging ─────────────────────────────────────────────────────────
os.makedirs(os.path.join(BASE_DIR, 'logs'), exist_ok=True)

LOGGING = {
    'version': 1,
    'disable_existing_loggers': False,
    'formatters': {
        'verbose': {
            'format': '{levelname} {asctime} {module} {process:d} {thread:d} {message}',
            'style': '{',
        },
        'security': {
            'format': '{levelname} {asctime} {message}',
            'style': '{',
        },
    },
    'handlers': {
        'console': {
            'class':     'logging.StreamHandler',
            'formatter': 'verbose',
        },
        'security_file': {
            'class':       'logging.handlers.RotatingFileHandler',
            'filename':    os.path.join(BASE_DIR, 'logs', 'security.log'),
            'maxBytes':    10 * 1024 * 1024,
            'backupCount': 5,
            'formatter':   'security',
        },
    },
    'loggers': {
        'django': {
            'handlers':  ['console'],
            'level':     'INFO',
            'propagate': True,
        },
        'step2win.security': {
            'handlers':  ['console', 'security_file'],
            'level':     'WARNING',
            'propagate': False,
        },
        'apps.payments': {
            'handlers':  ['console'],
            'level':     'INFO',
            'propagate': True,
        },
        'apps.steps': {
            'handlers':  ['console'],
            'level':     'INFO',
            'propagate': True,
        },
    },
}

# ── Audit logging ─────────────────────────────────────────────────────────────
AUDITLOG_INCLUDE_ALL_MODELS = False  # Only log models we explicitly register
