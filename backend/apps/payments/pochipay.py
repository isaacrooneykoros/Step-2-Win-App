"""
PochPay API Client
Handles all communication with the PochPay payment gateway.
Token is cached in Redis and refreshed every 55 minutes via Celery.
Never store the token in the database.
"""
import uuid
import logging
import requests
from django.conf import settings
from django.core.cache import cache

logger = logging.getLogger(__name__)

POCHIPAY_BASE = settings.POCHIPAY_BASE_URL
TOKEN_CACHE_KEY = 'pochipay:access_token'
TOKEN_TTL_SECONDS = 3500   # Refresh 100s before PochPay's 3600s expiry


def _mask_phone(phone: str) -> str:
    """Return a partially masked phone number for safe logging.
    E.g. +254712345678 → +254***5678
    """
    if not phone or len(phone) < 5:
        return '***'
    return phone[:4] + '***' + phone[-4:]


class PochiPayAPIError(Exception):
    """Raised when a PochiPay API call fails."""

    def __init__(self, message: str, status_code: int | None = None, response_text: str = ''):
        super().__init__(message)
        self.status_code = status_code
        self.response_text = response_text


# ── Token Management ──────────────────────────────────────────────────────────

def get_token() -> str:
    """
    Returns a valid PochiPay access token.
    Reads from cache. If missing or expired, fetches a new one.
    Token expires every 3600s — we refresh at 3500s to stay ahead.
    """
    token = cache.get(TOKEN_CACHE_KEY)
    if token:   
        return token
    return _refresh_token()


def _refresh_token() -> str:
    """Fetches a fresh token from PochiPay and caches it."""
    credential = (getattr(settings, 'POCHIPAY_EMAIL', '') or '').strip()
    password = (getattr(settings, 'POCHIPAY_PASSWORD', '') or '').strip()

    if not credential or not password:
        raise PochiPayAPIError(
            'PochiPay credentials missing. Set POCHIPAY_EMAIL and POCHIPAY_PASSWORD in backend/.env'
        )

    endpoint = f'{POCHIPAY_BASE}/account/token'
    attempts = [
        {
            'desc': 'json-email',
            'kwargs': {
                'json': {'email': credential, 'password': password},
                'headers': {'accept': 'application/json'},
            },
        },
        {
            'desc': 'form-email',
            'kwargs': {
                'data': {'email': credential, 'password': password},
                'headers': {
                    'accept': 'application/json',
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
            },
        },
        {
            'desc': 'json-username',
            'kwargs': {
                'json': {'username': credential, 'password': password},
                'headers': {'accept': 'application/json'},
            },
        },
        {
            'desc': 'form-username',
            'kwargs': {
                'data': {'username': credential, 'password': password},
                'headers': {
                    'accept': 'application/json',
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
            },
        },
    ]

    last_error = None
    for attempt in attempts:
        try:
            resp = requests.post(endpoint, timeout=15, **attempt['kwargs'])
            data = {}
            try:
                data = resp.json()
            except ValueError:
                data = {}

            if resp.status_code >= 400:
                last_error = PochiPayAPIError(
                    f"PochPay token endpoint rejected request ({attempt['desc']})",
                    status_code=resp.status_code,
                    response_text=resp.text,
                )
                continue

            token = (
                data.get('result', {}).get('accessToken')
                or data.get('result', {}).get('token')
                or data.get('accessToken')
                or data.get('token')
            )

            if not token:
                last_error = PochiPayAPIError(
                    f"PochPay token missing in response ({attempt['desc']})",
                    status_code=resp.status_code,
                    response_text=resp.text,
                )
                continue

            cache.set(TOKEN_CACHE_KEY, token, timeout=TOKEN_TTL_SECONDS)
            logger.info(f"PochPay token refreshed successfully via {attempt['desc']}")
            return token

        except requests.RequestException as e:
            response_text = getattr(getattr(e, 'response', None), 'text', '')
            status_code = getattr(getattr(e, 'response', None), 'status_code', None)
            last_error = PochiPayAPIError(
                f"PochPay token HTTP failure ({attempt['desc']}): {e}",
                status_code=status_code,
                response_text=response_text,
            )

    logger.error(
        'PochPay token refresh failed | endpoint=%s | status=%s | detail=%s',
        endpoint,
        getattr(last_error, 'status_code', None),
        getattr(last_error, 'response_text', '')[:500],
    )
    raise last_error or PochiPayAPIError('PochPay token refresh failed for unknown reason')


def _headers() -> dict:
    """Returns authorization headers for every PochPay request."""
    return {
        'Authorization': f'Bearer {get_token()}',
        'Content-Type':  'application/json',
        'accept':        'application/json',
    }


# ── Collections (Deposits) ───────────────────────────────────────────────────

def initiate_mpesa_collection(
    order_id: str,
    bill_ref_number: str,
    phone_number: str,
    amount: float,
    narration: str,
) -> dict:
    """
    Initiates an STK Push to the user's phone via M-Pesa.
    The user sees a prompt on their phone to enter their M-Pesa PIN.

    Returns immediately with isProcessing: True.
    Actual result arrives via the deposit callback URL.

    Args:
        order_id:        Your unique collection identifier (store this)
        bill_ref_number: Reference number shown to user (e.g. "DEP-{user_id}")
        phone_number:    User's M-Pesa number in format 2547XXXXXXXX
        amount:          Amount in KES (must be > 0)
        narration:       Description shown in M-Pesa message
    """
    payload = {
        'orderId':       order_id,
        'billRefNumber': bill_ref_number,
        'phoneNumber':   phone_number,
        'amount':        float(amount),
        'narration':     narration,
        'callbackUrl':   settings.POCHIPAY_DEPOSIT_CALLBACK_URL,
    }

    try:
        resp = requests.post(
            f'{POCHIPAY_BASE}/collections/mpesa',
            json=payload,
            headers=_headers(),
            timeout=15,
        )
        resp.raise_for_status()
        data = resp.json()

        if data.get('errors') or data.get('message') == 'error':
            raise ValueError(f"PochPay collection error: {data.get('message', data.get('errors'))}")

        logger.info('M-Pesa STK Push sent | order_id=%s | phone=%s | amount=%s',
                    order_id, _mask_phone(phone_number), amount)
        return data['result']   # { collectionId, isProcessing }

    except requests.RequestException as e:
        response_text = getattr(getattr(e, 'response', None), 'text', '')
        status_code = getattr(getattr(e, 'response', None), 'status_code', None)
        logger.error(
            'PochPay collection request failed | order_id=%s | status=%s | detail=%s',
            order_id,
            status_code,
            (response_text or str(e))[:500],
        )
        raise PochiPayAPIError(
            f'PochPay collection request failed: {e}',
            status_code=status_code,
            response_text=response_text,
        )


def query_collection(order_id: str) -> dict:
    """
    Queries the status of an M-Pesa collection.
    Use this if you missed the callback (polling fallback).
    """
    resp = requests.get(
        f'{POCHIPAY_BASE}/collections/mpesa/collection-query',
        params={'OrderId': order_id},
        headers=_headers(),
        timeout=15,
    )
    resp.raise_for_status()
    return resp.json()


def get_collection_status(collection_id: str) -> dict:
    """Check collection status by PochPay's collectionId."""
    resp = requests.post(
        f'{POCHIPAY_BASE}/collections/mpesa/transaction-status',
        json={'collectionId': collection_id},
        headers=_headers(),
        timeout=15,
    )
    resp.raise_for_status()
    return resp.json()


# ── Disbursements (Payouts) ───────────────────────────────────────────────────

def send_to_mobile(recipients: list[dict], request_id: str, title: str) -> dict:
    """
    Sends funds to one or more M-Pesa mobile numbers in a single batch.
    Used for challenge winner payouts.

    Args:
        recipients: List of dicts, each containing:
            - amount (float): Amount in KES
            - remarks (str): Description for the user
            - trackingReference (str): YOUR unique ID for this payment (store it)
            - phoneNumber (str): Recipient's M-Pesa number
        request_id: YOUR unique batch ID (one per challenge payout run)
        title: Human-readable title for this disbursement batch
    """
    payload = {
        'callbackUrl':        settings.POCHIPAY_PAYOUT_CALLBACK_URL,
        'requestId':          request_id,
        'disbursementTitle':  title,
        'recipients':         recipients,
    }

    try:
        resp = requests.post(
            f'{POCHIPAY_BASE}/disbursement/send-to-mobile',
            json=payload,
            headers=_headers(),
            timeout=30,
        )
        resp.raise_for_status()
        data = resp.json()

        if data.get('errors') or data.get('message'):
            # PochPay returns message on error
            if not data.get('result', {}).get('isProcessing'):
                raise ValueError(f"PochPay disbursement error: {data.get('message', data.get('errors'))}")

        logger.info(f'Disbursement batch sent | request_id={request_id} | recipients={len(recipients)}')
        return data

    except requests.RequestException as e:
        logger.error(f'PochPay disbursement request failed: {e}')
        raise


def get_disbursement_status(tracking_reference: str) -> dict:
    """
    Checks status of a specific disbursement by trackingReference.
    Use this if you missed the payout callback.
    """
    resp = requests.post(
        f'{POCHIPAY_BASE}/disbursement/transaction-status',
        json={'trackingReference': tracking_reference},
        headers={'Authorization': f'Bearer {get_token()}',
                 'Content-Type': 'application/json', 'accept': 'text/plain'},
        timeout=15,
    )
    resp.raise_for_status()
    return resp.json()


def retry_pending_disbursement(narration_id: str) -> dict:
    """Retries a pending disbursement using its narrationId."""
    resp = requests.post(
        f'{POCHIPAY_BASE}/disbursement/execute-narration',
        json={'narrationId': narration_id},
        headers={'Authorization': f'Bearer {get_token()}',
                 'Content-Type': 'application/json', 'accept': 'text/plain'},
        timeout=15,
    )
    resp.raise_for_status()
    return resp.json()


# ── Account ───────────────────────────────────────────────────────────────────

def get_platform_balance() -> dict:
    """Returns the Step2Win platform wallet balance on PochPay."""
    resp = requests.get(
        f'{POCHIPAY_BASE}/account/balance',
        headers=_headers(),
        timeout=10,
    )
    resp.raise_for_status()
    return resp.json()['result']   # { currency: 'KES', balance: 0.00 }


def get_transaction_summaries() -> dict:
    """Returns summary of all collections and disbursements."""
    resp = requests.get(
        f'{POCHIPAY_BASE}/transactions/summaries',
        headers=_headers(),
        timeout=10,
    )
    resp.raise_for_status()
    return resp.json()['result']


# ── Utility ───────────────────────────────────────────────────────────────────

def generate_tracking_reference(prefix: str = 'TX') -> str:
    """Generates a unique trackingReference for a transaction."""
    return f"{prefix}-{uuid.uuid4().hex[:16].upper()}"


def format_phone(phone: str) -> str:
    """
    Converts any Kenyan phone format to PochPay's required 2547XXXXXXXX format.
    Handles: 07XXXXXXXX, +2547XXXXXXXX, 2547XXXXXXXX
    """
    phone = str(phone).strip().replace(' ', '').replace('-', '')
    if phone.startswith('+'):
        phone = phone[1:]
    if phone.startswith('07') or phone.startswith('01'):
        phone = '254' + phone[1:]
    if not phone.startswith('254'):
        raise ValueError(f"Cannot format phone number: {phone}")
    return phone


# ── Disbursements for Withdrawals ────────────────────────────────────────────
# These are the same PochPay endpoints as payouts but for user-initiated withdrawals
# Each withdrawal is a single-recipient disbursement, NOT a batch

def send_withdrawal_to_mobile(
    tracking_reference: str,
    request_id: str,
    phone_number: str,
    amount: float,
    remarks: str,
) -> dict:
    """
    Sends a single user withdrawal to their M-Pesa number.
    Uses the same /disbursement/send-to-mobile endpoint as payouts
    but with a single recipient and withdrawal-specific callback URL.
    """
    payload = {
        'callbackUrl':       settings.POCHIPAY_WITHDRAWAL_CALLBACK_URL,
        'requestId':         request_id,
        'disbursementTitle': f'Step2Win Withdrawal {request_id}',
        'recipients': [{
            'amount':            float(amount),
            'remarks':           remarks,
            'trackingReference': tracking_reference,
            'phoneNumber':       phone_number,
        }]
    }
    try:
        resp = requests.post(
            f'{POCHIPAY_BASE}/disbursement/send-to-mobile',
            json=payload,
            headers=_headers(),
            timeout=30,
        )
        resp.raise_for_status()
        data = resp.json()
        if not data.get('result', {}).get('isProcessing'):
            raise ValueError(f"PochPay withdrawal error: {data.get('message')}")
        logger.info(f'Withdrawal sent to M-Pesa | ref={tracking_reference} | amount={amount}')
        return data
    except requests.RequestException as e:
        logger.error(f'PochPay withdrawal (mobile) failed: {e}')
        raise


def send_withdrawal_to_bank(
    tracking_reference: str,
    request_id: str,
    bank_code: str,
    account_number: str,
    amount: float,
    remarks: str,
) -> dict:
    """
    Sends a single user withdrawal to a bank account.
    bank_code obtained from GET /disbursement/banks (cached in get_available_banks()).
    """
    payload = {
        'callbackUrl':       settings.POCHIPAY_WITHDRAWAL_CALLBACK_URL,
        'requestId':         request_id,
        'disbursementTitle': f'Step2Win Bank Withdrawal {request_id}',
        'recipients': [{
            'amount':            float(amount),
            'remarks':           remarks,
            'trackingReference': tracking_reference,
            'bankCode':          bank_code,
            'accountNumber':     account_number,
        }]
    }
    try:
        resp = requests.post(
            f'{POCHIPAY_BASE}/disbursement/send-to-bank',
            json=payload,
            headers=_headers(),
            timeout=30,
        )
        resp.raise_for_status()
        data = resp.json()
        if not data.get('result', {}).get('isProcessing'):
            raise ValueError(f"PochPay bank withdrawal error: {data.get('message')}")
        logger.info(f'Withdrawal sent to bank | ref={tracking_reference} | bank={bank_code}')
        return data
    except requests.RequestException as e:
        logger.error(f'PochPay withdrawal (bank) failed: {e}')
        raise


def send_withdrawal_to_paybill(
    tracking_reference: str,
    request_id: str,
    short_code: str,
    account_number: str | None,
    is_paybill: bool,
    amount: float,
    remarks: str,
) -> dict:
    """
    Sends a single user withdrawal to a Paybill or Till number.
    is_paybill=True for paybill (with optional account_number),
    is_paybill=False for till number.
    """
    payload = {
        'callbackUrl':       settings.POCHIPAY_WITHDRAWAL_CALLBACK_URL,
        'requestId':         request_id,
        'disbursementTitle': f'Step2Win Paybill Withdrawal {request_id}',
        'recipients': [{
            'amount':            float(amount),
            'remarks':           remarks,
            'trackingReference': tracking_reference,
            'shortCode':         short_code,
            'accountNumber':     account_number,
            'IsPaybill':         is_paybill,
        }]
    }
    try:
        resp = requests.post(
            f'{POCHIPAY_BASE}/disbursement/send-to-business',
            json=payload,
            headers=_headers(),
            timeout=30,
        )
        resp.raise_for_status()
        data = resp.json()
        if not data.get('result', {}).get('isProcessing'):
            raise ValueError(f"PochPay paybill withdrawal error: {data.get('message')}")
        logger.info(f'Withdrawal sent to paybill | ref={tracking_reference}')
        return data
    except requests.RequestException as e:
        logger.error(f'PochPay withdrawal (paybill) failed: {e}')
        raise


def get_available_banks() -> list[dict]:
    """
    Returns list of banks supported for bank withdrawals.
    Result is cached for 24 hours — the bank list rarely changes.
    """
    cached = cache.get('pochipay:banks')
    if cached:
        return cached

    resp = requests.get(
        f'{POCHIPAY_BASE}/disbursement/banks',
        headers=_headers(),
        timeout=15,
    )
    resp.raise_for_status()
    banks = resp.json().get('result', [])
    cache.set('pochipay:banks', banks, timeout=86400)  # 24 hours
    return banks


def cancel_withdrawal(tracking_reference: str) -> dict:
    """
    Cancels a pending withdrawal.
    PochPay only allows cancellation after 24 hours of pending status.
    """
    resp = requests.post(
        f'{POCHIPAY_BASE}/disbursement/cancel',
        json={'trackingReference': tracking_reference},
        headers={'Authorization': f'Bearer {get_token()}',
                 'Content-Type': 'application/json', 'accept': 'text/plain'},
        timeout=15,
    )
    resp.raise_for_status()
    return resp.json()
