import { Navigate, Route, Routes } from 'react-router-dom';
import { AdminLayout } from './components/AdminLayout';
import { DashboardPage } from './pages/DashboardPage';
import { UsersPage } from './pages/UsersPage';
import { ChallengesPage } from './pages/ChallengesPage';
import { TransactionsPage } from './pages/TransactionsPage';
import { AdminWithdrawalsPage } from './pages/AdminWithdrawalsPage';
import { BadgesPage } from './pages/BadgesPage';
import { ModerationPage } from './pages/ModerationPage';
import { ReportsPage } from './pages/ReportsPage';
import { AnalyticsPage } from './pages/AnalyticsPage';
import { SettingsPage } from './pages/SettingsPage';
import { ActivityLogsPage } from './pages/ActivityLogsPage';
import { SupportPage } from './pages/SupportPage';
import { AdminRouteGuard } from './components/AdminRouteGuard';
import { AdminLoginPage } from './pages/AdminLoginPage';
import { AdminRegisterPage } from './pages/AdminRegisterPage';
import LegalDocumentsPage from './pages/LegalDocumentsPage';

import { AdminFraudPage } from './pages/AdminFraudPage';

function App() {
  return (
    <Routes>
      <Route path="/auth/login" element={<AdminLoginPage />} />
      <Route path="/auth/register" element={<AdminRegisterPage />} />
      <Route path="/" element={<AdminLayout />}>
        <Route element={<AdminRouteGuard />}>
          <Route index element={<DashboardPage />} />
          <Route path="users" element={<UsersPage />} />
          <Route path="challenges" element={<ChallengesPage />} />
          <Route path="transactions" element={<TransactionsPage />} />
          <Route path="withdrawals" element={<AdminWithdrawalsPage />} />
          <Route path="badges" element={<BadgesPage />} />
          <Route path="moderation" element={<ModerationPage />} />
          <Route path="fraud" element={<AdminFraudPage />} />
          <Route path="anti-cheat" element={<AdminFraudPage />} />
          <Route path="reports" element={<ReportsPage />} />
          <Route path="analytics" element={<AnalyticsPage />} />
          <Route path="activity" element={<ActivityLogsPage />} />
          <Route path="support" element={<SupportPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="legal" element={<LegalDocumentsPage />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default App;
