"""
Branded transactional email (password reset codes, security notices).

- Plain-text + HTML alternative, table-based inline-styled HTML (works in Gmail / Outlook /
  Apple Mail), a text wordmark instead of an SVG logo (SVG is stripped by many clients).
- Sent with ``send_mail(fail_silently=False)``; failures are logged WITHOUT the recipient
  address (only the message kind), and never raised to the caller.
- By default sent on a background thread (``settings.EMAIL_SEND_ASYNC``) so SMTP latency
  can't reveal whether an account exists or slow the request down.
- If email isn't configured in production (``EMAIL_HOST`` unset -> dummy backend), the
  message is dropped and "email not configured" is logged.
"""

from __future__ import annotations

import logging
import threading
from html import escape

from django.conf import settings
from django.core.mail import send_mail

logger = logging.getLogger(__name__)

BRAND_GREEN = "#14855D"
BRAND_NAME = "Step2Win"
_DUMMY_BACKEND = "django.core.mail.backends.dummy.EmailBackend"


def email_configured() -> bool:
    return getattr(settings, "EMAIL_BACKEND", "") != _DUMMY_BACKEND


def render_email(
    *,
    heading: str,
    paragraphs: list[str],
    code: str | None = None,
    footer: str | None = None,
) -> tuple[str, str]:
    """Return (plain_text, html). ``paragraphs`` are plain text (escaped for HTML)."""
    footer = footer or (
        f"You're receiving this because of activity on your {BRAND_NAME} account. "
        "We will never ask you for this code by phone, SMS or chat."
    )

    # The code (if any) goes right after the first paragraph.
    text_parts = [BRAND_NAME, "", heading, ""]
    font = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"
    body_html = ""
    for i, p in enumerate(paragraphs):
        text_parts += [p, ""]
        body_html += (
            f'<p style="margin:0 0 14px;font-size:15px;line-height:22px;color:#334155;">{escape(p)}</p>'
        )
        if code and i == 0:
            text_parts += [f"    {code}", ""]
            body_html += (
                '<div style="margin:6px 0 20px;padding:16px 0;border-radius:12px;background:#ECF7F2;'
                f"text-align:center;font-size:32px;font-weight:700;letter-spacing:8px;color:{BRAND_GREEN};"
                f"font-family:'SFMono-Regular',Menlo,Consolas,monospace;\">{escape(code)}</div>"
            )
    text_parts += ["--", footer]
    text = "\n".join(text_parts)

    html = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<meta name="color-scheme" content="light only"><title>{escape(heading)}</title></head>
<body style="margin:0;padding:0;background:#F4F6F5;font-family:{font};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F6F5;">
<tr><td align="center" style="padding:28px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;">
<tr><td style="padding:0 4px 16px;font-size:22px;font-weight:800;letter-spacing:-0.3px;color:{BRAND_GREEN};">Step<span style="color:#0F172A;">2</span>Win</td></tr>
<tr><td style="background:#FFFFFF;border-radius:16px;padding:28px 24px;border:1px solid #E2E8F0;">
<h1 style="margin:0 0 14px;font-size:20px;line-height:26px;color:#0F172A;">{escape(heading)}</h1>
{body_html}
</td></tr>
<tr><td style="padding:16px 8px 0;font-size:12px;line-height:18px;color:#64748B;">{escape(footer)}</td></tr>
</table></td></tr></table></body></html>"""
    return text, html


def _deliver(kind: str, subject: str, text: str, html: str, recipient: str) -> bool:
    try:
        send_mail(
            subject,
            text,
            settings.DEFAULT_FROM_EMAIL,
            [recipient],
            html_message=html,
            fail_silently=False,
        )
        logger.info("Email sent: kind=%s", kind)
        return True
    except Exception as exc:  # never leak the address; never break the request
        logger.error("Email send failed: kind=%s error=%s", kind, type(exc).__name__)
        return False


def send_branded_email(
    *,
    kind: str,
    to: str,
    subject: str,
    heading: str,
    paragraphs: list[str],
    code: str | None = None,
) -> bool:
    """
    Send one branded email. ``kind`` is a short label for logs (e.g. "password_reset_code").
    Returns False when email isn't configured or (sync mode) sending failed.
    """
    if not to:
        return False
    if not email_configured():
        logger.error("Email not configured (EMAIL_HOST unset): dropped kind=%s", kind)
        return False
    text, html = render_email(heading=heading, paragraphs=paragraphs, code=code)
    if getattr(settings, "EMAIL_SEND_ASYNC", True):
        threading.Thread(
            target=_deliver, args=(kind, subject, text, html, to), daemon=True
        ).start()
        return True
    return _deliver(kind, subject, text, html, to)
