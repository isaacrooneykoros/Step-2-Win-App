import { useState, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { paymentsService } from '../services/api/payments';

type DepositState = 'idle' | 'sending' | 'waiting' | 'success' | 'failed';

export function useDeposit() {
  const [state, setState] = useState<DepositState>('idle');
  const [orderId, setOrderId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string>('');
  const queryClient = useQueryClient();

  const initiateDeposit = useCallback(async (amount: number, phone: string) => {
    setState('sending');
    setErrorMsg('');
    try {
      const result = await paymentsService.initiateDeposit({ amount, phone_number: phone });
      setOrderId(result.order_id);
      setState('waiting');
      // Start polling for status
      _pollStatus(result.order_id);
    } catch (err: any) {
      setErrorMsg(err?.response?.data?.error || 'Failed to initiate payment');
      setState('failed');
    }
  }, []);

  const _pollStatus = useCallback(
    (orderId: string) => {
      const maxAttempts = 24; // poll for up to 2 minutes (24 × 5s)
      let attempt = 0;

      const poll = async () => {
        attempt++;
        try {
          const data = await paymentsService.getDepositStatus(orderId);
          if (data.status === 'completed') {
            setState('success');
            // Refresh wallet balance
            await queryClient.invalidateQueries({ queryKey: ['wallet'] });
            return;
          }
          if (data.status === 'failed' || data.status === 'cancelled') {
            setErrorMsg('Payment was not completed. Please try again.');
            setState('failed');
            return;
          }
          if (attempt < maxAttempts) {
            setTimeout(poll, 5000); // retry in 5 seconds
          } else {
            setState('idle'); // give up polling — callback will still come
          }
        } catch {
          if (attempt < maxAttempts) setTimeout(poll, 5000);
        }
      };
      setTimeout(poll, 5000);
    },
    [queryClient]
  );

  const reset = () => {
    setState('idle');
    setOrderId(null);
    setErrorMsg('');
  };

  return { state, orderId, errorMsg, initiateDeposit, reset };
}
