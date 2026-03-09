import { Link, Outlet, useLocation } from 'react-router-dom';
import { useEffect, useMemo, useState } from 'react';
import { adminApi } from '../services/adminApi';

const navItems = [
  { to: '/', label: 'Overview' },
  { to: '/analytics', label: 'Analytics' },
  { to: '/moderation', label: 'Moderation' },
  { to: '/fraud', label: 'Anti-Cheat' },
  { to: '/reports', label: 'Reports' },
  { to: '/users', label: 'Users' },
  { to: '/challenges', label: 'Challenges' },
  { to: '/transactions', label: 'Transactions' },
  { to: '/withdrawals', label: 'Withdrawals' },
  { to: '/badges', label: 'Badges' },
  { to: '/activity', label: 'Activity Logs' },
  { to: '/support', label: 'Support' },
  { to: '/settings', label: 'Settings' },
];

export function Layout() {
  const location = useLocation();
  const admin = adminApi.getCurrentAdmin();
  const [pendingWithdrawals, setPendingWithdrawals] = useState(0);

  useEffect(() => {
    adminApi
      .getWithdrawalStats()
      .then((stats) => setPendingWithdrawals(stats.pending_count || 0))
      .catch(() => setPendingWithdrawals(0));
  }, [location.pathname]);

  const activeTitle = useMemo(() => {
    const item = navItems.find((entry) => (entry.to === '/' ? location.pathname === '/' : location.pathname.startsWith(entry.to)));
    return item?.label || 'Admin';
  }, [location.pathname]);

  const logout = () => {
    adminApi.adminLogout();
    window.location.href = '/auth/login';
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <h1 className="brand">Step2Win Admin</h1>
        <nav>
          {navItems.map((item) => {
            const isActive = item.to === '/' ? location.pathname === '/' : location.pathname.startsWith(item.to);
            return (
              <Link key={item.to} className={`nav-link ${isActive ? 'active' : ''}`} to={item.to}>
                <span>{item.label}</span>
                {item.to === '/withdrawals' && pendingWithdrawals > 0 && (
                  <span
                    style={{
                      marginLeft: 8,
                      background: 'rgba(255, 196, 71, 0.2)',
                      color: '#ffd888',
                      border: '1px solid rgba(255, 196, 71, 0.3)',
                      borderRadius: 999,
                      fontSize: 11,
                      padding: '2px 8px',
                      fontWeight: 700,
                    }}
                  >
                    {pendingWithdrawals}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>

        <div className="session-box">
          <p className="session-label">Signed in as</p>
          <p className="session-user">{admin?.username || 'Admin'}</p>
          <p className="session-email">{admin?.email || ''}</p>
          <button onClick={logout}>Logout</button>
        </div>
      </aside>

      <main className="content">
        <header className="topbar">
          <h2>{activeTitle}</h2>
        </header>
        <section className="panel">
          <Outlet />
        </section>
      </main>
    </div>
  );
}
