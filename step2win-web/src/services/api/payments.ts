import api from './client';

const createIdempotencyKey = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `idem-${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

const lastActionAt: Record<string, number> = {};
const ensureDebounced = (action: string, minIntervalMs: number = 1500): void => {
  const now = Date.now();
  const last = lastActionAt[action] || 0;
  if (now - last < minIntervalMs) {
    throw new Error('Please wait a moment before trying again.');
  }
  lastActionAt[action] = now;
};

export const paymentsService = {
  /**
   * Initiates an M-Pesa STK Push for deposit
   */
  initiateDeposit: (data: { amount: number; phone_number: string }) =>
    (ensureDebounced('payments:initiateDeposit'), api.post('/api/payments/deposit/', data, {
      headers: {
        'X-Idempotency-Key': createIdempotencyKey(),
      },
    })).then(r => r.data),

  /**
   * Polls the status of a deposit by order_id
   */
  getDepositStatus: (orderId: string) =>
    api.get(`/api/payments/deposit/${orderId}/status/`).then(r => r.data),

  /**
   * Gets wallet status including balance and recent payment transactions
   */
  getWalletStatus: () =>
    api.get('/api/payments/wallet/').then(r => r.data),

  requestWithdrawal: (data: {
    method: 'mpesa' | 'bank' | 'paybill'
    amount: number
    phone_number?: string
    bank_code?: string
    account_number?: string
    short_code?: string
    is_paybill?: boolean
  }) => {
    ensureDebounced('payments:requestWithdrawal');
    return api.post('/api/payments/withdrawal/request/', data, {
      headers: {
        'X-Idempotency-Key': createIdempotencyKey(),
      },
    }).then(r => r.data);
  },

  getWithdrawalHistory: () =>
    api.get('/api/payments/withdrawal/history/').then(r => r.data),

  cancelWithdrawal: (id: string) =>
    api.post(`/api/payments/withdrawal/${id}/cancel/`).then(r => r.data),

  getBanks: () =>
    api.get('/api/payments/banks/').then(r => r.data),
};
