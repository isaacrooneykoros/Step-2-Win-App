import { Outlet, NavLink } from 'react-router-dom';
import { Home, Footprints, Trophy, Wallet, User } from 'lucide-react';
import { useStepsWebSocket } from '../../hooks/useStepsWebSocket';
import { useAutoHealthSync } from '../../hooks/useHealthSync';

const navItems = [
  { to: '/', icon: Home, label: 'Home' },
  { to: '/steps', icon: Footprints, label: 'Steps' },
  { to: '/challenges', icon: Trophy, label: 'Challenges' },
  { to: '/wallet', icon: Wallet, label: 'Wallet' },
  { to: '/profile', icon: User, label: 'Profile' },
];

export default function MainLayout() {
  useStepsWebSocket();
  useAutoHealthSync(180000);

  return (
    <div className="app-shell min-h-screen flex flex-col">
      {/* Main content area */}
      <div className="flex-1 overflow-y-auto pb-20">
        <Outlet />
      </div>

      {/* Bottom nav */}
      <nav 
        className="app-bottom-nav fixed bottom-0 left-0 right-0 bg-bg-card border-t border-border safe-bottom"
        style={{ boxShadow: '0 -1px 0 #E5E7EB' }}
      >
        <div className="flex justify-around items-center h-16">
          {navItems.map(({ to, icon: Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) => `
                flex flex-col items-center gap-1 px-5 py-2 rounded-xl
                ${isActive ? 'text-accent-blue' : 'text-text-muted'}
              `}
            >
              {({ isActive }) => (
                <>
                  <Icon size={22} strokeWidth={isActive ? 2.5 : 1.8} />
                  <span className="text-xs font-medium">{label}</span>
                </>
              )}
            </NavLink>
          ))}
        </div>
      </nav>
    </div>
  );
}
