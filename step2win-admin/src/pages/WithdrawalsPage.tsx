import { useEffect, useState } from 'react';
import { adminApi } from '../services/adminApi';
import type { AdminWithdrawal } from '../types/admin';
import { formatKES } from '../utils/currency';

export function WithdrawalsPage() {
  const [items, setItems] = useState<AdminWithdrawal[]>([]);
  const [error, setError] = useState('');

  const load = () => {
    adminApi.getWithdrawals().then(setItems).catch((err: Error) => setError(err.message));
  };

  useEffect(() => {
    load();
  }, []);

  const approve = async (id: number) => {
    try {
      await adminApi.approveWithdrawal(id);
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const reject = async (id: number) => {
    try {
      await adminApi.rejectWithdrawal(id, 'Rejected by admin dashboard');
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  if (error) return <p className="error">{error}</p>;

  return (
    <table className="table">
      <thead>
        <tr>
          <th>User</th>
          <th>Amount</th>
          <th>Status</th>
          <th>Reference</th>
          <th>Created</th>
          <th>Action</th>
        </tr>
      </thead>
      <tbody>
        {items.map((w) => (
          <tr key={w.id}>
            <td>{w.user_username}</td>
            <td>{formatKES(w.amount)}</td>
            <td>{w.status}</td>
            <td>{w.reference_number}</td>
            <td>{new Date(w.created_at).toLocaleString()}</td>
            <td className="actions">
              <button disabled={w.status !== 'pending'} onClick={() => approve(w.id)}>
                Approve
              </button>
              <button disabled={w.status !== 'pending'} onClick={() => reject(w.id)}>
                Reject
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
