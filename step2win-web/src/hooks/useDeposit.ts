import { useState, useCallback, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { paymentsService } from '../services/api/payments';

/**
 * UI-facing deposit lifecycle.
 * - `sending`: STK push request in flight
 * - `waiting`: prompt sent, polling for M-Pesa confirmation
 * - `success` / `failed`: final answer from the backend
 * - `timeout`: polling window ended without a final answer (the callback may still credit the wallet)
 */
export type DepositState = 'idle' | 'sending' | 'waiting' | 'success' | 'failed' | 'timeout';

/** Where a failure happened — decides the copy ("request not sent" vs "payment not completed"). */
export type DepositFailureStage = 'initiate' | 'payment' | null;

export interface DepositAttempt {
  amount: number;
  phone: string;
  /** When the request was started (ms epoch) — drives the "waiting for" timer. */
  startedAt: number;
}

export function useDeposit() {
  const [state, setState] = useState<DepositState>('idle');
  const [orderId, setOrderId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string>('');
  const [failureStage, setFailureStage] = useState<DepositFailureStage>(null);
  const [mpesaRef, setMpesaRef] = useState<string | null>(null);
  const [attempt, setAttempt] = useState<DepositAttempt | null>(null);
  /** Last status string reported by the backend while polling (e.g. "initiated", "pending"). */
  const [remoteStatus, setRemoteStatus] = useState<string | null>(null);
  const queryClient = useQueryClient();
  // Each initiated deposit gets a flow id; a reset or a newer deposit makes older polls stop
  // updating UI state (they still refresh balances if the old payment completes).
  const flowRef = useRef(0);

  const refreshMoney = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['wallet'] });
    queryClient.invalidateQueries({ queryKey: ['transactions'] });
    queryClient.invalidateQueries({ queryKey: ['profile'] });
  }, [queryClient]);

  const _pollStatus = useCallback(
    (orderId: string, flow: number) => {
      const maxAttempts = 24; // poll for up to 2 minutes (24 × 5s)
      let attempt = 0;
      const isCurrent = () => flowRef.current === flow;

      const poll = async () => {
        attempt++;
        try {
          const data = await paymentsService.getDepositStatus(orderId);
          if (data.status === 'completed') {
            // Refresh wallet balance
            await queryClient.invalidateQueries({ queryKey: ['wallet'] });
            refreshMoney();
            if (isCurrent()) {
              setMpesaRef(data.mpesa_ref || null);
              setState('success');
            }
            return;
          }
          if (data.status === 'failed' || data.status === 'cancelled') {
            if (isCurrent()) {
              setErrorMsg(
                data.status === 'cancelled'
                  ? 'The M-Pesa prompt was cancelled on your phone.'
                  : 'M-Pesa reported that the payment did not go through.',
              );
              setFailureStage('payment');
              setState('failed');
            }
            return;
          }
          if (isCurrent()) setRemoteStatus(data.status ?? null);
          if (attempt < maxAttempts) {
            setTimeout(poll, 5000); // retry in 5 seconds
          } else if (isCurrent()) {
            setState('timeout'); // give up polling — callback will still come
          }
        } catch {
          if (attempt < maxAttempts) setTimeout(poll, 5000);
          else if (isCurrent()) setState('timeout');
        }
      };
      setTimeout(poll, 5000);
    },
    [queryClient, refreshMoney],
  );

  const initiateDeposit = useCallback(
    async (amount: number, phone: string) => {
      const flow = ++flowRef.current;
      setAttempt({ amount, phone, startedAt: Date.now() });
      setState('sending');
      setErrorMsg('');
      setFailureStage(null);
      setMpesaRef(null);
      setRemoteStatus(null);
      try {
        const result = await paymentsService.initiateDeposit({ amount, phone_number: phone });
        if (flowRef.current !== flow) return;
        setOrderId(result.order_id);
        setState('waiting');
        // Start polling for status
        _pollStatus(result.order_id, flow);
      } catch (err: any) {
        if (flowRef.current !== flow) return;
        setErrorMsg(err?.response?.data?.error || err?.message || 'Failed to initiate payment');
        setFailureStage('initiate');
        setState('failed');
      }
    },
    [_pollStatus],
  );

  const reset = useCallback(() => {
    flowRef.current++;
    setState('idle');
    setOrderId(null);
    setErrorMsg('');
    setFailureStage(null);
    setMpesaRef(null);
    setRemoteStatus(null);
    setAttempt(null);
  }, []);

  return { state, orderId, errorMsg, failureStage, mpesaRef, attempt, remoteStatus, initiateDeposit, reset };
}
