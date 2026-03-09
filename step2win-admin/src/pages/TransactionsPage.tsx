import { useEffect, useState } from 'react';
import { adminApi } from '../services/adminApi';
import type { AdminTransaction } from '../types/admin';
import { formatKES } from '../utils/currency';

export function TransactionsPage() {
  const [items, setItems] = useState<AdminTransaction[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    adminApi.getTransactions().then(setItems).catch((err: Error) => setError(err.message));
  }, []);

  if (error) return <p className="error">{error}</p>;

  return (
    <table className="table">
      <thead>
        <tr>
          <th>User</th>
          <th>Type</th>
          <th>Amount</th>
          <th>Description</th>
          <th>Reference</th>
          <th>Created</th>
        </tr>
      </thead>
      <tbody>
        {items.map((tx) => (
          <tr key={tx.id}>
            <td>{tx.user_username || 'System'}</td>
            <td>{tx.type}</td>
            <td>{formatKES(tx.amount)}</td>
            <td>{tx.description}</td>
            <td>{tx.reference_id || '-'}</td>
            <td>{new Date(tx.created_at).toLocaleString()}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
