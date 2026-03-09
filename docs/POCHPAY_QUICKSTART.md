# PochPay Integration - Quick Start Guide

## 🚀 5-Minute Setup

### 1. Install Dependencies
```bash
cd backend
pip install requests==2.31.0
```

### 2. Configure PochPay Credentials

Edit `backend/.env`:
```env
POCHIPAY_EMAIL=your-email@company.com
POCHIPAY_PASSWORD=your-password

# For local testing with ngrok:
POCHIPAY_DEPOSIT_CALLBACK_URL=https://YOUR-NGROK-URL.ngrok.io/api/payments/mpesa/deposit-callback/
POCHIPAY_PAYOUT_CALLBACK_URL=https://YOUR-NGROK-URL.ngrok.io/api/payments/mpesa/payout-callback/
```

### 3. Start Ngrok (for local testing)
```bash
ngrok http 8000
# Copy the HTTPS URL and update .env
```

### 4. Restart Django
```bash
python manage.py runserver
```

### 5. Start Celery (in separate terminals)
```bash
# Terminal 1
celery -A step2win worker -l info

# Terminal 2  
celery -A step2win beat -l info
```

### 6. Test Deposit

1. Open app → Wallet screen
2. Click "Deposit"
3. Enter: Amount (e.g., 100) + Phone (07XXXXXXXX)
4. Click "Send STK Push"
5. Check phone → Enter M-Pesa PIN
6. Wait for success ✅

---

## 🔍 Key Files

### Backend
- `apps/payments/pochipay.py` - PochPay API client
- `apps/payments/views.py` - Deposit/payout endpoints
- `apps/payments/models.py` - PaymentTransaction, CallbackLog
- `apps/payments/tasks.py` - Token refresh, reconciliation

### Frontend
- `src/services/api/payments.ts` - Payment API service
- `src/hooks/useDeposit.ts` - Deposit state machine
- `src/screens/WalletScreen.tsx` - M-Pesa deposit UI

---

## 📋 API Endpoints

### User Endpoints (Authenticated)
- `POST /api/payments/deposit/` - Initiate M-Pesa deposit
- `GET /api/payments/deposit/<order_id>/status/` - Poll status
- `GET /api/payments/wallet/` - Get balance + transactions

### Callback Endpoints (PUBLIC - No Auth)
- `POST /api/payments/mpesa/deposit-callback/` - PochPay deposit callback
- `POST /api/payments/mpesa/payout-callback/` - PochPay payout callback

### Admin Endpoints
- `GET /api/admin/payments/overview/` - Financial dashboard
- `POST /api/admin/payments/<txn_id>/retry/` - Retry failed payout

---

## 🐛 Quick Debug

### Check if callback was received:
```bash
python manage.py shell
>>> from apps.payments.models import CallbackLog
>>> CallbackLog.objects.all().order_by('-created_at')[:5]
```

### Check transaction status:
```bash
>>> from apps.payments.models import PaymentTransaction
>>> PaymentTransaction.objects.filter(status='pending')
```

### Manually query PochPay:
```bash
>>> from apps.payments import pochipay
>>> pochipay.query_collection('DEP-<order_id>')
```

### Refresh token:
```bash
>>> pochipay._refresh_token()
```

---

## ⚠️ Important Notes

1. **Callback URLs MUST be public** - Use ngrok for local dev
2. **Always restart Django** after changing .env
3. **Celery must be running** for token refresh and reconciliation
4. **Django admin:** `/admin/payments/` to view all transactions
5. **Min deposit:** KES 10, **Max:** KES 100,000

---

## 🎯 Production Checklist

Before going live:

- [ ] Replace ngrok URL with real public domain
- [ ] Set up SSL/HTTPS
- [ ] Enable Redis for production caching
- [ ] Contact PochPay for server IPs (for IP whitelisting)
- [ ] Test with small amounts first
- [ ] Monitor `CallbackLog` for any issues
- [ ] Set up Sentry for error tracking

---

## 📞 Need Help?

1. Check `POCHPAY_INTEGRATION.md` for full documentation
2. Django logs: `python manage.py runserver` output
3. Celery logs: Worker terminal output
4. Database: Django admin at `/admin/`
5. PochPay docs: https://developers.pochipay.com/

**Status:** ✅ Implementation Complete - Ready for Testing
