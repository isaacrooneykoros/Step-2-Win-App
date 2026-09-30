import { useEffect } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AdminLayout } from './components/AdminLayout';
import { DashboardPage } from './pages/DashboardPage';
import { UsersPage } from './pages/UsersPage';
import { StepsPage } from './pages/StepsPage';
import { ChallengesPage } from './pages/ChallengesPage';
import { TransactionsPage } from './pages/TransactionsPage';
import { AdminWithdrawalsPage } from './pages/AdminWithdrawalsPage';
import { PayoutReviewsPage } from './pages/PayoutReviewsPage';
import { BadgesPage } from './pages/BadgesPage';
import { ModerationPage } from './pages/ModerationPage';
import { ReportsPage } from './pages/ReportsPage';
import { AnalyticsPage } from './pages/AnalyticsPage';
import { SettingsPage } from './pages/SettingsPage';
import { ActivityLogsPage } from './pages/ActivityLogsPage';
import { SupportPage } from './pages/SupportPage';
import { OpsMonitoringPage } from './pages/OpsMonitoringPage';
import LegalDocumentsPage from './pages/LegalDocumentsPage';
import { ProtectedRoute } from './components/auth/ProtectedRoute';
import LoginPage from './pages/auth/LoginPage';
import RegisterPage from './pages/auth/RegisterPage';
import { useAuthStore } from './store/authStore';

import { AdminFraudPage } from './pages/AdminFraudPage';
import SocialModerationPage from './pages/SocialModerationPage';
import { DepositsPage } from './pages/DepositsPage';
import { StaffPage } from './pages/StaffPage';

function App() {
  const loadSession = useAuthStore((state) => state.loadSession);

  useEffect(() => {
    void loadSession();
  }, [loadSession]);

  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/auth/login" element={<Navigate to="/login" replace />} />
      <Route path="/auth/register" element={<Navigate to="/register" replace />} />

      <Route element={<ProtectedRoute />}>
        <Route path="/" element={<AdminLayout />}>
          <Route index element={<DashboardPage />} />
          <Route path="dashboard" element={<DashboardPage />} />
          <Route path="users" element={<UsersPage />} />
          <Route path="steps" element={<StepsPage />} />
          <Route path="challenges" element={<ChallengesPage />} />
          <Route path="transactions" element={<TransactionsPage />} />
          <Route path="withdrawals" element={<AdminWithdrawalsPage />} />
          <Route path="payout-reviews" element={<PayoutReviewsPage />} />
          <Route path="badges" element={<BadgesPage />} />
          <Route path="moderation" element={<ModerationPage />} />
          <Route path="social" element={<SocialModerationPage />} />
          <Route path="fraud" element={<AdminFraudPage />} />
          <Route path="anti-cheat" element={<AdminFraudPage />} />
          <Route path="reports" element={<ReportsPage />} />
          <Route path="analytics" element={<AnalyticsPage />} />
          <Route path="activity" element={<ActivityLogsPage />} />
          <Route path="monitoring/ops" element={<OpsMonitoringPage />} />
          <Route path="support" element={<SupportPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="legal" element={<LegalDocumentsPage />} />
          <Route path="deposits" element={<DepositsPage />} />
          <Route path="staff" element={<StaffPage />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default App;
