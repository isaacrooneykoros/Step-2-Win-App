# Email setup (password reset codes and account notices)

The backend sends transactional email over SMTP. Today it sends:

- the 6-digit **password reset code** (Forgot password on the sign-in screen),
- a **"your password was changed"** notice after a reset,
- a **"you sign in with Google"** hint when a Google-only account asks for a reset,
- the existing nightly admin alerts in `apps/users/tasks.py` (now actually deliverable).

Any SMTP provider works: Brevo, Resend, SendGrid, Mailgun, Amazon SES. The steps below use
**Brevo** because its free tier (300 emails/day) is enough to start.

## 1. Render environment variables (backend web service)

| Variable | Value |
| --- | --- |
| `EMAIL_HOST` | `smtp-relay.brevo.com` |
| `EMAIL_PORT` | `587` |
| `EMAIL_USE_TLS` | `True` |
| `EMAIL_HOST_USER` | your Brevo SMTP login (looks like `8a1b2c001@smtp-brevo.com`) |
| `EMAIL_HOST_PASSWORD` | the Brevo **SMTP key** (not your account password) |
| `DEFAULT_FROM_EMAIL` | `Step2Win <no-reply@yourdomain.com>` (must be a verified sender/domain) |
| `EMAIL_TIMEOUT` | `10` (optional, seconds) |

Add them to the **web service** (and the worker service too if you want the Celery alert
emails). Saving the variables redeploys the service.

If `EMAIL_HOST` is not set:
- development / tests: emails are printed to the server log (console backend);
- production: nothing is sent, the API still answers normally, and the log shows
  `Email not configured (EMAIL_HOST unset): dropped kind=password_reset_code`.
  Customers would never receive their code, so configure this before announcing the feature.

Other providers: Resend `smtp.resend.com` / user `resend` / password = API key; SendGrid
`smtp.sendgrid.net` / user `apikey` / password = API key. Port 587 + TLS for all of them.

## 2. Brevo account + SMTP key

1. Sign up at https://www.brevo.com (free plan).
2. **Settings -> SMTP & API -> SMTP** tab: note the *SMTP server*, *port* and *login*.
3. Click **Generate a new SMTP key**, name it `step2win-render`, copy it once into
   `EMAIL_HOST_PASSWORD` on Render. Never commit it.

## 3. Verify the sending domain (SPF / DKIM / DMARC)

Without this, mail lands in spam or is rejected by Gmail.

1. Brevo: **Settings -> Senders, Domains & Dedicated IPs -> Domains -> Add a domain**,
   enter the domain used in `DEFAULT_FROM_EMAIL` (for example `step2win.app`).
2. Brevo shows DNS records. Add them at your DNS host (Cloudflare, Namecheap, ...):
   - a `TXT` record `brevo-code:...` (ownership),
   - the **DKIM** record (`TXT` on `mail._domainkey` or the CNAMEs Brevo shows),
   - **SPF**: if the domain has no SPF yet, `TXT @ "v=spf1 include:spf.brevo.com ~all"`.
     If one exists, add `include:spf.brevo.com` to it; a domain must only have ONE SPF record.
   - **DMARC** (recommended): `TXT _dmarc "v=DMARC1; p=none; rua=mailto:you@yourdomain.com"`.
3. Wait for DNS (minutes to a few hours) and click **Verify** in Brevo until all are green.
4. Also add `no-reply@yourdomain.com` under **Senders** if Brevo asks for it.

## 4. Test

Local (no SMTP needed): run the backend, use Forgot password in the app; the email, including
the code, is printed in the backend log.

Production after setting the variables:

1. In the app: Sign in -> **Forgot password?** -> enter the email of a test account you own.
2. The email should arrive within a minute from `DEFAULT_FROM_EMAIL`. In Gmail, open
   "Show original" and check `SPF: PASS`, `DKIM: PASS`, `DMARC: PASS`.
3. Enter the code, choose a new password, confirm you're signed out on other devices and
   receive the "Your Step2Win password was changed" email.
4. Render logs show `Email sent: kind=password_reset_code` (addresses are never logged). A
   `Email send failed: kind=... error=SMTPAuthenticationError` means a wrong login/key;
   `error=timeout` / `gaierror` means a wrong host or port.

Optional one-liner from a Render shell:

```bash
python manage.py sendtestemail you@yourdomain.com
```

## How the reset flow behaves (for support)

- Codes are 6 digits, valid 15 minutes, 5 wrong tries lock the code, a new request replaces
  the old code. "Resend" is available after 60 seconds.
- The request screen always says "If an account matches, we've sent a code", whether or not
  the account exists (prevents account discovery).
- Staff/admin accounts don't get codes: a superuser resets them in the admin console
  (Users -> Reset password). Google-only accounts get an email telling them to use
  Continue with Google.
- Rate limits: 5 requests per hour per email/username/phone, 20 per hour per IP.
- During maintenance mode the reset endpoints are blocked, the same as sign-in.
- A completed reset signs the customer out on every device.
