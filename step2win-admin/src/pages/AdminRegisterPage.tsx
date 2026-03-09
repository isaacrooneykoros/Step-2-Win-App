import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { adminApi } from '../services/adminApi';

export function AdminRegisterPage() {
  const navigate = useNavigate();
  const [form, setForm] = useState({
    username: '',
    email: '',
    password: '',
    confirm_password: '',
    admin_code: '',
  });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError('');

    try {
      await adminApi.adminRegister(form);
      navigate('/', { replace: true });
    } catch (err) {
      setError((err as Error).message || 'Registration failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-shell">
      <form className="auth-card" onSubmit={handleSubmit}>
        <h1>Admin Register</h1>
        <p>Create a new admin account using the registration code.</p>

        <label htmlFor="username">Username</label>
        <input
          id="username"
          value={form.username}
          onChange={(event) => setForm({ ...form, username: event.target.value })}
          required
        />

        <label htmlFor="email">Email</label>
        <input
          id="email"
          type="email"
          value={form.email}
          onChange={(event) => setForm({ ...form, email: event.target.value })}
          required
        />

        <label htmlFor="password">Password</label>
        <input
          id="password"
          type="password"
          value={form.password}
          onChange={(event) => setForm({ ...form, password: event.target.value })}
          required
        />

        <label htmlFor="confirm_password">Confirm Password</label>
        <input
          id="confirm_password"
          type="password"
          value={form.confirm_password}
          onChange={(event) => setForm({ ...form, confirm_password: event.target.value })}
          required
        />

        <label htmlFor="admin_code">Admin Registration Code</label>
        <input
          id="admin_code"
          value={form.admin_code}
          onChange={(event) => setForm({ ...form, admin_code: event.target.value })}
          placeholder="Enter the Admin provided to you"
          required
        />

        {error && <p className="error">{error}</p>}

        <button type="submit" disabled={loading}>
          {loading ? 'Creating account...' : 'Create Admin Account'}
        </button>

        <p className="auth-switch">
          Already have an admin account? <Link to="/auth/login">Sign In</Link>
        </p>
      </form>
    </div>
  );
}
