import api from './client';
import type {
  WalletSummary,
  Transaction,
  Withdrawal,
  DepositForm,
  WithdrawForm,
} from '../../types';

export const walletService = {
  /**
   * Get wallet summary
   */
  getSummary: async (): Promise<WalletSummary> => {
    const response = await api.get<WalletSummary>('/api/wallet/summary/');
    return response.data;
  },

  /**
   * Get transaction history
   */
  getTransactions: async (params?: {
    type?: string;
    start_date?: string;
    end_date?: string;
  }): Promise<Transaction[]> => {
    const response = await api.get<any>('/api/wallet/transactions/', { params });
    // Handle paginated response from DRF
    return Array.isArray(response.data) ? response.data : (response.data.results || []);
  },

  /**
   * Get transaction statistics
   */
  getTransactionStats: async (): Promise<any> => {
    const response = await api.get('/api/wallet/transactions/stats/');
    return response.data;
  },

  /**
   * Deposit funds
   */
  deposit: async (data: DepositForm): Promise<{
    status: string;
    balance: string;
    transaction_id: number;
    amount: string;
  }> => {
    const response = await api.post<{
      status: string;
      balance: string;
      transaction_id: number;
      amount: string;
    }>('/api/wallet/deposit/', data);
    return response.data;
  },

  /**
   * Request withdrawal
   */
  withdraw: async (data: WithdrawForm): Promise<{
    status: string;
    reference_number: string;
    amount: string;
    message: string;
  }> => {
    const response = await api.post<{
      status: string;
      reference_number: string;
      amount: string;
      message: string;
    }>('/api/wallet/withdraw/', data);
    return response.data;
  },

  /**
   * Get withdrawal history
   */
  getWithdrawals: async (): Promise<Withdrawal[]> => {
    const response = await api.get<any>('/api/wallet/withdrawals/');
    // Handle paginated response from DRF
    return Array.isArray(response.data) ? response.data : (response.data.results || []);
  },

  /**
   * Get withdrawal detail
   */
  getWithdrawalDetail: async (referenceNumber: string): Promise<Withdrawal> => {
    const response = await api.get<Withdrawal>(`/api/wallet/withdrawals/${referenceNumber}/`);
    return response.data;
  },
};
