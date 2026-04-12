"""
IntaSend API Client
Handles all communication with the IntaSend payment gateway.
Uses static API key/secret authentication — no token refresh required.

Documentation: https://developers.intasend.com
Sandbox: https://sandbox.intasend.com
"""
import uuid
import logging
import requests
from django.conf import settings
from django.core.cache import cache

logger = logging.getLogger(__name__)

INTASEND_BASE_LIVE = 'https://payment.intasend.com/api/v1'
INTASEND_BASE_TEST = 'https://sandbox.intasend.com/api/v1'


class IntaSendAPIError(Exception):
    """Raised when an IntaSend API call fails."""

    def __init__(self, message: str, status_code: int | None = None, response_text: str = ''):
        super().__init__(message)
        self.status_code = status_code
        self.response_text = response_text


# ── Authentication & Base ─────────────────────────────────────────────────────

def _base_url() -> str:
    """Returns the appropriate IntaSend API base URL (live or sandbox)."""
    if getattr(settings, 'INTASEND_TEST_MODE', False):
        return INTASEND_BASE_TEST
    return INTASEND_BASE_LIVE


def _headers(public_only: bool = False) -> dict:
    """Returns authorization headers for every IntaSend request."""
    headers = {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
    }
    if not public_only:
        api_key = getattr(settings, 'INTASEND_API_KEY', '').strip()
        if not api_key:
            raise IntaSendAPIError(
                'IntaSend API key missing. Set INTASEND_API_KEY in backend/.env'
            )
        headers['Authorization'] = f'Bearer {api_key}'
    return headers


# ── Collections (Deposits) ────────────────────────────────────────────────────

def initiate_mpesa_collection(
    order_id: str,
    phone_number: str,
    amount: float,
    narration: str,
    user_email: str = '',
) -> dict:
    """
    Initiates an M-Pesa STK Push to the user's phone via IntaSend.
    The user sees a prompt on their phone to enter their M-Pesa PIN.

    Returns immediately — actual result arrives via the deposit callback URL
    (configured as a webhook in the IntaSend dashboard).

    Args:
        order_id:     Our unique order identifier, passed as api_ref so it
                      appears in the webhook callback for matching.
        phone_number: User's M-Pesa number in format 2547XXXXXXXX
        amount:       Amount in KES (must be > 0)
        narration:    Description shown in M-Pesa message
        user_email:   Optional — stored in IntaSend for records

    Returns:
        dict: IntaSend invoice object, e.g.:
              {'invoice_id': 'NR5XKGY', 'state': 'PENDING', ...}
    """
    publishable_key = getattr(settings, 'INTASEND_PUBLISHABLE_KEY', '').strip()
    if not publishable_key:
        raise IntaSendAPIError(
            'IntaSend publishable key missing. Set INTASEND_PUBLISHABLE_KEY in backend/.env'
        )

    payload = {
        'public_key': publishable_key,
        'currency': 'KES',
        'method': 'M-PESA',
        'amount': float(amount),
        'phone_number': phone_number,
        'api_ref': order_id,
        'narrative': narration,
    }
    if user_email:
        payload['email'] = user_email

    try:
        resp = requests.post(
            f'{_base_url()}/payment/mpesa-stk-push/',
            json=payload,
            headers=_headers(),
            timeout=15,
        )
        if resp.status_code == 400:
            raise IntaSendAPIError(
                f'IntaSend STK Push rejected: {resp.text}',
                status_code=400,
                response_text=resp.text,
            )
        resp.raise_for_status()
        data = resp.json()
        invoice = data.get('invoice', {})
        logger.info(
            'IntaSend STK Push sent | order_id=%s | invoice_id=%s | phone=%s',
            order_id, invoice.get('invoice_id'), phone_number,
        )
        return invoice  # {'invoice_id': '...', 'state': 'PENDING', ...}

    except requests.RequestException as e:
        status_code = getattr(getattr(e, 'response', None), 'status_code', None)
        response_text = getattr(getattr(e, 'response', None), 'text', '')
        logger.error(
            'IntaSend STK Push failed | order_id=%s | status=%s | detail=%s',
            order_id, status_code, (response_text or str(e))[:500],
        )
        raise IntaSendAPIError(
            f'IntaSend STK Push failed: {e}',
            status_code=status_code,
            response_text=response_text,
        )


def query_collection(invoice_id: str) -> dict:
    """
    Queries the status of an M-Pesa STK Push by IntaSend invoice_id.
    Use this as a polling fallback if the webhook callback was missed.

    Args:
        invoice_id: IntaSend's invoice_id returned from initiate_mpesa_collection
                    (stored as PaymentTransaction.collection_id)

    Returns:
        dict: IntaSend invoice object with 'state' field
              (PENDING, PROCESSING, COMPLETE, FAILED)
    """
    publishable_key = getattr(settings, 'INTASEND_PUBLISHABLE_KEY', '').strip()
    payload = {
        'invoice_id': invoice_id,
        'public_key': publishable_key,
    }
    try:
        resp = requests.post(
            f'{_base_url()}/payment/status/',
            json=payload,
            headers=_headers(),
            timeout=15,
        )
        resp.raise_for_status()
        data = resp.json()
        # Return the invoice object directly for consistent handling
        return data.get('invoice', data)
    except requests.RequestException as e:
        status_code = getattr(getattr(e, 'response', None), 'status_code', None)
        raise IntaSendAPIError(
            f'IntaSend status check failed: {e}',
            status_code=status_code,
        )


# ── Disbursements (Payouts / Withdrawals) ─────────────────────────────────────

def _send_money(provider: str, transactions: list[dict], callback_url: str) -> dict:
    """
    Common send-money initiator for all payout types.
    Uses requires_approval='NO' for immediate processing without manual approval.

    Args:
        provider:     'MPESA-B2C', 'PESALINK', or 'MPESA-B2B'
        transactions: List of recipient dicts (fields vary by provider)
        callback_url: IntaSend will POST the result to this URL

    Returns:
        dict: IntaSend response with 'tracking_id' for status queries and
              callback matching.
    """
    payload = {
        'provider': provider,
        'currency': 'KES',
        'transactions': transactions,
        'requires_approval': 'NO',
        'callback_url': callback_url,
    }
    try:
        resp = requests.post(
            f'{_base_url()}/send-money/initiate/',
            json=payload,
            headers=_headers(),
            timeout=30,
        )
        if resp.status_code == 400:
            raise IntaSendAPIError(
                f'IntaSend send-money rejected ({provider}): {resp.text}',
                status_code=400,
                response_text=resp.text,
            )
        resp.raise_for_status()
        data = resp.json()
        logger.info(
            'IntaSend send-money initiated | provider=%s | tracking_id=%s | count=%d',
            provider, data.get('tracking_id'), len(transactions),
        )
        return data

    except requests.RequestException as e:
        status_code = getattr(getattr(e, 'response', None), 'status_code', None)
        response_text = getattr(getattr(e, 'response', None), 'text', '')
        logger.error(
            'IntaSend send-money failed | provider=%s | status=%s | detail=%s',
            provider, status_code, (response_text or str(e))[:500],
        )
        raise IntaSendAPIError(
            f'IntaSend send-money failed ({provider}): {e}',
            status_code=status_code,
            response_text=response_text,
        )


def send_to_mobile(recipients: list[dict], callback_url: str) -> dict:
    """
    Sends funds to one or more M-Pesa mobile numbers (B2C).

    Args:
        recipients: List of dicts, each containing:
            - name (str): Recipient name
            - account (str): M-Pesa phone number (2547XXXXXXXX)
            - amount (float): Amount in KES
        callback_url: IntaSend will POST the disbursement result to this URL

    Returns:
        dict: {'tracking_id': '...', 'status': 'PENDING', 'transactions': [...]}
    """
    return _send_money('MPESA-B2C', recipients, callback_url)


def send_to_bank(recipients: list[dict], callback_url: str) -> dict:
    """
    Sends funds to bank accounts via PesaLink.

    Args:
        recipients: List of dicts, each containing:
            - name (str): Account holder name
            - account (str): Bank account number
            - amount (float): Amount in KES
            - bank_code (str): PesaLink bank code (from get_available_banks)
    """
    return _send_money('PESALINK', recipients, callback_url)


def send_to_paybill(recipients: list[dict], callback_url: str) -> dict:
    """
    Sends funds to M-Pesa Paybill or Till numbers (B2B).

    Args:
        recipients: List of dicts, each containing:
            - name (str): Business name
            - account (str): Paybill number or Till number
            - amount (float): Amount in KES
            - account_ref (str, optional): Account reference (Paybill only)
    """
    return _send_money('MPESA-B2B', recipients, callback_url)


def send_withdrawal_to_mobile(
    phone_number: str,
    amount: float,
    remarks: str,
    callback_url: str,
    account_name: str = 'Step2Win Withdrawal',
) -> str:
    """
    Sends a single user withdrawal to their M-Pesa number.

    Returns:
        str: IntaSend tracking_id — store this in WithdrawalRequest.tracking_reference
             and WithdrawalRequest.request_id for callback matching.
    """
    data = send_to_mobile(
        recipients=[{
            'name': account_name,
            'account': phone_number,
            'amount': float(amount),
        }],
        callback_url=callback_url,
    )
    tracking_id = data.get('tracking_id', '')
    logger.info(
        'Withdrawal sent to M-Pesa | tracking_id=%s | amount=%s | phone=%s',
        tracking_id, amount, phone_number,
    )
    return tracking_id


def send_withdrawal_to_bank(
    bank_code: str,
    account_number: str,
    amount: float,
    remarks: str,
    callback_url: str,
    account_name: str = 'Step2Win Withdrawal',
) -> str:
    """
    Sends a single user withdrawal to a bank account.

    Returns:
        str: IntaSend tracking_id — store for callback matching.
    """
    data = send_to_bank(
        recipients=[{
            'name': account_name,
            'account': account_number,
            'amount': float(amount),
            'bank_code': bank_code,
        }],
        callback_url=callback_url,
    )
    tracking_id = data.get('tracking_id', '')
    logger.info(
        'Withdrawal sent to bank | tracking_id=%s | bank=%s | amount=%s',
        tracking_id, bank_code, amount,
    )
    return tracking_id


def send_withdrawal_to_paybill(
    short_code: str,
    account_number: str | None,
    amount: float,
    remarks: str,
    callback_url: str,
) -> str:
    """
    Sends a single user withdrawal to a Paybill or Till number.

    Returns:
        str: IntaSend tracking_id — store for callback matching.
    """
    recipient: dict = {
        'name': 'Step2Win Withdrawal',
        'account': short_code,
        'amount': float(amount),
    }
    if account_number:
        recipient['account_ref'] = account_number

    data = send_to_paybill(
        recipients=[recipient],
        callback_url=callback_url,
    )
    tracking_id = data.get('tracking_id', '')
    logger.info(
        'Withdrawal sent to paybill | tracking_id=%s | short_code=%s | amount=%s',
        tracking_id, short_code, amount,
    )
    return tracking_id


def get_disbursement_status(tracking_id: str) -> dict:
    """
    Checks status of a send-money batch by IntaSend tracking_id.
    Use this if you missed the payout/withdrawal callback.

    Returns:
        dict: {'tracking_id': '...', 'status': 'COMPLETE|FAILED|PENDING',
               'transactions': [...]}
    """
    payload = {'tracking_id': tracking_id}
    try:
        resp = requests.post(
            f'{_base_url()}/send-money/status/',
            json=payload,
            headers=_headers(),
            timeout=15,
        )
        resp.raise_for_status()
        return resp.json()
    except requests.RequestException as e:
        raise IntaSendAPIError(f'IntaSend disbursement status check failed: {e}')


# ── Account ───────────────────────────────────────────────────────────────────

def get_platform_balance() -> dict:
    """Returns the Step2Win platform wallet balance on IntaSend."""
    try:
        resp = requests.get(
            f'{_base_url()}/wallets/',
            headers=_headers(),
            timeout=10,
        )
        resp.raise_for_status()
        data = resp.json()
        wallets = data.get('results', [])
        if wallets:
            w = wallets[0]
            return {
                'currency': w.get('currency', 'KES'),
                'balance': w.get('current_balance', 0),
            }
        return {'currency': 'KES', 'balance': 0}
    except requests.RequestException as e:
        raise IntaSendAPIError(f'IntaSend balance fetch failed: {e}')


def get_available_banks() -> list[dict]:
    """
    Returns list of banks supported for PesaLink (bank) transfers.
    Result is cached for 24 hours — the bank list rarely changes.
    """
    cached = cache.get('intasend:banks')
    if cached:
        return cached

    try:
        resp = requests.get(
            f'{_base_url()}/send-money/bank-codes/ke/',
            headers=_headers(public_only=True),
            timeout=15,
        )
        resp.raise_for_status()
        result = resp.json()
        banks = result if isinstance(result, list) else result.get('results', [])
        cache.set('intasend:banks', banks, timeout=86400)  # 24 hours
        return banks
    except requests.RequestException as e:
        raise IntaSendAPIError(f'IntaSend bank list fetch failed: {e}')


# ── Utility ───────────────────────────────────────────────────────────────────

def format_phone(phone: str) -> str:
    """
    Converts any Kenyan phone format to IntaSend's required 2547XXXXXXXX format.
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


def generate_tracking_reference(prefix: str = 'TX') -> str:
    """Generates a unique internal tracking reference for deposits."""
    return f"{prefix}-{uuid.uuid4().hex[:16].upper()}"
