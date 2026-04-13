# Railway Deployment Guide

Complete step-by-step guide to deploy Step2Win to Railway.

## Prerequisites

- GitHub account with repository access
- Railway account (https://railway.app)
- Completed code changes validated locally

## Step 1: Push Code to GitHub

```bash
cd c:\Users\Admin\PycharmProjects\Final Steps
git add .
git commit -m "Railway deployment: Add Procfile, runtime.txt, frontend env configs"
git push origin main
```

## Step 2: Create Railway Account & Project

1. Go to https://railway.app
2. Sign in with GitHub
3. Click "New Project" → "Deploy from GitHub repo"
4. Select `isaacrooneykoros/Step-2-Win-App`
5. Railway auto-detects Django and creates default service

## Step 3: Add PostgreSQL Database

1. In Railway Dashboard → Click "+ New" → "Database" → "PostgreSQL"
2. Wait for PostgreSQL to be created (2-3 minutes)
3. Click on PostgreSQL service → "Connect" tab
4. **Copy the connection string** (entire URL)
5. In the web service (step2win-web):
   - Go to **Variables** tab
   - Click "Add Variable"
   - **Name**: `DATABASE_URL`
   - **Value**: *(paste the PostgreSQL URL)*
   - Save

## Step 4: Add Redis Cache

1. Click "+ New" → "Database" → "Redis"
2. Wait for Redis to be created
3. Click on Redis service → "Connect" tab
4. **Copy the Redis URL**
5. In the web service, add these variables:
   - **Name**: `REDIS_URL` → **Value**: *(paste Redis URL)*
   - **Name**: `USE_REDIS` → **Value**: `True`
   - **Name**: `CELERY_BROKER_URL` → **Value**: *(paste same Redis URL)*

## Step 5: Configure Backend Environment Variables

In the web service **Variables** tab, add:

**Production Django Settings:**
```
DJANGO_ENV=production
DEBUG=False
SECRET_KEY=<generate-50+-char-random-secret-key>
ALLOWED_HOSTS=<your-railway-domain>.railway.app,www.<your-railway-domain>.railway.app
CSRF_TRUSTED_ORIGINS=https://<your-railway-domain>.railway.app
CORS_ALLOWED_ORIGINS=https://<your-railway-domain>.railway.app
SECURE_SSL_REDIRECT=True
SECURE_HSTS_SECONDS=31536000
```

**Admin & Security:**
```
DJANGO_ADMIN_URL=admin-s2w-secure/
ADMIN_REGISTRATION_CODE=<your-random-code>
ENABLE_DEFENDER=True
```

**PochPay (if using):**
```
POCHIPAY_EMAIL=your@email.com
POCHIPAY_PASSWORD=your_password
POCHIPAY_WEBHOOK_SECRET=your_webhook_secret
POCHIPAY_DEPOSIT_CALLBACK_URL=https://<your-railway-domain>.railway.app/api/payments/mpesa/deposit-callback/
POCHIPAY_PAYOUT_CALLBACK_URL=https://<your-railway-domain>.railway.app/api/payments/mpesa/payout-callback/
POCHIPAY_WITHDRAWAL_CALLBACK_URL=https://<your-railway-domain>.railway.app/api/payments/mpesa/withdrawal-callback/
```

**Optional:**
```
SENTRY_DSN=your_sentry_dsn
```

## Step 6: Deploy Web Service

1. Railway auto-deploys when you push code
2. Check **Deploy** tab for build progress
3. Wait for "Deployment successful" message
4. Note the **Service Domain** (e.g., `step2win-production-12345.railway.app`)

## Step 7: Run Database Migrations

1. In the web service, click **Deploy** tab
2. Click **"Railway Shell"** (top right)
3. Run these commands one by one:
   ```bash
   python manage.py migrate
   python manage.py createsuperuser
   python manage.py check --deploy
   ```

## Step 8: Verify Backend Health

1. Get your Railway domain from the web service settings
2. Test health endpoint:
   ```
   https://<your-domain>.railway.app/api/health/
   ```
   Should return: `{"status": "ok"}`

3. Test admin login:
   ```
   https://<your-domain>.railway.app/admin-s2w-secure/
   ```

## Step 9: Create Celery Worker Service

1. In Railway Dashboard, click "+ New" → "Service"
2. **Service Name**: Set to same GitHub repo → Select "Deploy from GitHub"
3. Configure the service:
   - **Start Command**: On the service settings, set `Start Command` to: `celery -A step2win worker -l info --concurrency=2`
   - Add all the same environment variables as web service (copy from web service)
4. Deploy

## Step 10: Create Celery Beat Service (Scheduler)

1. Click "+ New" → "Service"
2. **Service Name**: Same GitHub repo
3. Configure:
   - **Start Command**: `celery -A step2win beat -l info --scheduler django_celery_beat.schedulers:DatabaseScheduler`
   - Copy all environment variables from web service
4. Deploy

## Step 11: Update Frontend Configuration

Update frontend to use Railway backend URL.

For native APK (React Native):
```bash
cd step2win-web
# Edit .env.production
VITE_API_BASE_URL=https://<your-railway-domain>.railway.app

# Rebuild APK
npm run build
npx cap sync android
# Then build in Android Studio
```

For web app:
```bash
cd step2win-web
# Edit .env.production  
VITE_API_BASE_URL=https://<your-railway-domain>.railway.app

# Build and deploy
npm run build
```

## Step 12: Test Complete Flow

1. Open your app on phone or browser
2. Try user registration (if enabled)
3. Try login with superuser credentials
4. Check if dashboard loads

## Troubleshooting

### "Login failed" on Frontend
- Check VITE_API_BASE_URL in frontend .env
- Verify CORS_ALLOWED_ORIGINS includes your frontend domain
- Check browser console for CORS errors

### Database connection errors
- Verify DATABASE_URL is set correctly
- Run `python manage.py migrate` in Railway Shell
- Check PostgreSQL service is running

### Celery not processing tasks
- Verify REDIS_URL is set
- Check worker logs: `Railway Dashboard → worker service → Logs`
- Verify CELERY_BROKER_URL matches REDIS_URL

### Admin login fails
- Run `python manage.py createsuperuser` in Railway Shell
- Check DATABASE_URL is correct

### 502 Bad Gateway after deploy
- Check build logs for Python errors
- Verify SECRET_KEY is set and 50+ characters
- Check `python manage.py check --deploy` output in shell

## Important Notes

- **Services share env vars**: Update in one place, applies to all
- **Automatic backups**: PostgreSQL has daily backups by default
- **Logs**: Click service → "Logs" tab to see real-time output
- **Redeploy**: Push to GitHub → Railway auto-redeploys
- **Monitoring**: Use Railway Analytics tab to monitor performance

## Next Steps After Deployment

1. Update M-Pesa callback URLs in PochPay dashboard
2. Configure SSL certificate (Railway auto-provides)
3. Set up monitoring/alerts in Railway dashboard
4. Plan database backup strategy
5. Document your Railway domain for team

---

**Support**: For Railway-specific issues, see https://docs.railway.app/
