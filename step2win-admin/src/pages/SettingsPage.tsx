import { useEffect, useState } from 'react';
import { adminApi } from '../services/adminApi';
import { Settings, DollarSign, Award, Bell, Shield, Zap, Save, AlertTriangle } from 'lucide-react';

interface SystemSettings {
  // Platform Fees
  platform_fee_percentage: number;
  
  // Withdrawal Settings
  minimum_withdrawal_amount: number;
  withdrawal_processing_time: number;
  
  // Challenge Settings
  min_challenge_entry_fee: number;
  max_challenge_entry_fee: number;
  min_challenge_milestone: number;
  max_challenge_milestone: number;
  max_challenge_participants: number;
  challenge_approval_required: boolean;
  
  // Feature Toggles
  registrations_enabled: boolean;
  challenges_enabled: boolean;
  withdrawals_enabled: boolean;
  referral_program_enabled: boolean;
  
  // Gamification Settings
  xp_per_step: number;
  daily_goal_bonus_xp: number;
  
  // Notifications
  admin_email: string;
  support_email: string;
  email_notifications_enabled: boolean;
  
  // Maintenance
  maintenance_mode: boolean;
  maintenance_message: string;
  
  // Metadata
  updated_at?: string;
  updated_by?: string;
  
  [key: string]: unknown;
}

export function SettingsPage() {
  const [settings, setSettings] = useState<SystemSettings | null>(null);
  const [formData, setFormData] = useState<SystemSettings | null>(null);
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    try {
      const data = await adminApi.getSettings() as SystemSettings;
      setSettings(data);
      setFormData(data);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const showSuccess = (msg: string) => {
    setSuccessMsg(msg);
    setTimeout(() => setSuccessMsg(''), 3000);
  };

  const handleSave = async () => {
    if (!formData) return;
    
    setSaving(true);
    setError('');
    
    try {
      const updated = await adminApi.updateSettings(formData as Record<string, unknown>) as SystemSettings;
      setSettings(updated);
      setFormData(updated);
      showSuccess('Settings saved successfully');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const updateField = (field: keyof SystemSettings, value: unknown) => {
    if (!formData) return;
    setFormData({ ...formData, [field]: value });
  };

  if (!settings || !formData) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-ink-secondary">Loading settings...</div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div
        className="rounded-2xl p-8"
        style={{
          background: 'linear-gradient(135deg, #7C6FF7 0%, #4F9CF9 100%)',
          boxShadow: '0 8px 32px rgba(79,156,249,0.25)',
        }}
      >
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-xl bg-white/20 backdrop-blur-sm flex items-center justify-center">
              <Settings size={24} className="text-white" />
            </div>
            <div>
              <h1 className="text-3xl font-bold text-white">System Settings</h1>
              {settings.updated_at && (
                <p className="text-white/70 text-sm mt-1">
                  Last updated {new Date(settings.updated_at).toLocaleString()}
                  {settings.updated_by && ` by ${settings.updated_by}`}
                </p>
              )}
            </div>
          </div>
          <button
            onClick={handleSave}
            disabled={saving}
            className="bg-white text-info px-6 py-3 rounded-xl font-semibold flex items-center gap-2 hover:bg-white/90 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            style={{ boxShadow: '0 4px 12px rgba(255,255,255,0.2)' }}
          >
            <Save size={20} />
            {saving ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </div>

      {/* Messages */}
      {error && (
        <div className="bg-down/10 border border-down/30 rounded-xl p-4">
          <p className="text-down font-medium">{error}</p>
        </div>
      )}
      {successMsg && (
        <div className="bg-up/10 border border-up/30 rounded-xl p-4">
          <p className="text-up font-medium">{successMsg}</p>
        </div>
      )}

      {/* Platform Fees Section */}
      <div className="bg-surface-card border border-surface-border rounded-2xl p-6">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-lg bg-prime/10 flex items-center justify-center">
            <DollarSign size={20} className="text-prime" />
          </div>
          <h2 className="text-xl font-bold text-ink-primary">Platform Fees & Payments</h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          <div>
            <label className="block text-sm font-medium text-ink-secondary mb-2">
              Platform Fee Percentage (%)
            </label>
            <input
              type="number"
              step="0.01"
              value={formData.platform_fee_percentage}
              onChange={(e) => updateField('platform_fee_percentage', parseFloat(e.target.value) || 0)}
              className="w-full px-4 py-2.5 bg-surface-input border border-surface-border rounded-xl text-ink-primary focus:outline-none focus:border-info transition-colors"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-ink-secondary mb-2">
              Minimum Withdrawal Amount (KSh)
            </label>
            <input
              type="number"
              step="0.01"
              value={formData.minimum_withdrawal_amount}
              onChange={(e) => updateField('minimum_withdrawal_amount', parseFloat(e.target.value) || 0)}
              className="w-full px-4 py-2.5 bg-surface-input border border-surface-border rounded-xl text-ink-primary focus:outline-none focus:border-info transition-colors"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-ink-secondary mb-2">
              Withdrawal Processing Time (hours)
            </label>
            <input
              type="number"
              value={formData.withdrawal_processing_time}
              onChange={(e) => updateField('withdrawal_processing_time', parseInt(e.target.value) || 0)}
              className="w-full px-4 py-2.5 bg-surface-input border border-surface-border rounded-xl text-ink-primary focus:outline-none focus:border-info transition-colors"
            />
          </div>
        </div>
      </div>

      {/* Challenge Settings Section */}
      <div className="bg-surface-card border border-surface-border rounded-2xl p-6">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-lg bg-warn/10 flex items-center justify-center">
            <Zap size={20} className="text-warn" />
          </div>
          <h2 className="text-xl font-bold text-ink-primary">Challenge Configuration</h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          <div>
            <label className="block text-sm font-medium text-ink-secondary mb-2">
              Minimum Entry Fee (KSh)
            </label>
            <input
              type="number"
              step="0.01"
              value={formData.min_challenge_entry_fee}
              onChange={(e) => updateField('min_challenge_entry_fee', parseFloat(e.target.value) || 0)}
              className="w-full px-4 py-2.5 bg-surface-input border border-surface-border rounded-xl text-ink-primary focus:outline-none focus:border-info transition-colors"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-ink-secondary mb-2">
              Maximum Entry Fee (KSh)
            </label>
            <input
              type="number"
              step="0.01"
              value={formData.max_challenge_entry_fee}
              onChange={(e) => updateField('max_challenge_entry_fee', parseFloat(e.target.value) || 0)}
              className="w-full px-4 py-2.5 bg-surface-input border border-surface-border rounded-xl text-ink-primary focus:outline-none focus:border-info transition-colors"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-ink-secondary mb-2">
              Minimum Milestone (steps)
            </label>
            <input
              type="number"
              value={formData.min_challenge_milestone}
              onChange={(e) => updateField('min_challenge_milestone', parseInt(e.target.value) || 0)}
              className="w-full px-4 py-2.5 bg-surface-input border border-surface-border rounded-xl text-ink-primary focus:outline-none focus:border-info transition-colors"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-ink-secondary mb-2">
              Maximum Milestone (steps)
            </label>
            <input
              type="number"
              value={formData.max_challenge_milestone}
              onChange={(e) => updateField('max_challenge_milestone', parseInt(e.target.value) || 0)}
              className="w-full px-4 py-2.5 bg-surface-input border border-surface-border rounded-xl text-ink-primary focus:outline-none focus:border-info transition-colors"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-ink-secondary mb-2">
              Maximum Participants
            </label>
            <input
              type="number"
              value={formData.max_challenge_participants}
              onChange={(e) => updateField('max_challenge_participants', parseInt(e.target.value) || 0)}
              className="w-full px-4 py-2.5 bg-surface-input border border-surface-border rounded-xl text-ink-primary focus:outline-none focus:border-info transition-colors"
            />
          </div>
          <div className="flex items-center gap-3 p-4 bg-surface-input rounded-xl">
            <input
              type="checkbox"
              id="challenge_approval"
              checked={formData.challenge_approval_required}
              onChange={(e) => updateField('challenge_approval_required', e.target.checked)}
              className="w-5 h-5 rounded cursor-pointer accent-info"
            />
            <label htmlFor="challenge_approval" className="text-ink-primary font-medium cursor-pointer select-none">
              Require Admin Approval for Challenges
            </label>
          </div>
        </div>
      </div>

      {/* Gamification Settings Section */}
      <div className="bg-surface-card border border-surface-border rounded-2xl p-6">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-lg" style={{ background: 'linear-gradient(135deg, #7C6FF7 0%, #A78BFA 100%)' }}>
            <Award size={20} className="text-white m-2" />
          </div>
          <h2 className="text-xl font-bold text-ink-primary">Gamification Settings</h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-ink-secondary mb-2">
              XP Per Step
            </label>
            <input
              type="number"
              step="0.01"
              value={formData.xp_per_step}
              onChange={(e) => updateField('xp_per_step', parseFloat(e.target.value) || 0)}
              className="w-full px-4 py-2.5 bg-surface-input border border-surface-border rounded-xl text-ink-primary focus:outline-none focus:border-info transition-colors"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-ink-secondary mb-2">
              Daily Goal Bonus XP
            </label>
            <input
              type="number"
              value={formData.daily_goal_bonus_xp}
              onChange={(e) => updateField('daily_goal_bonus_xp', parseInt(e.target.value) || 0)}
              className="w-full px-4 py-2.5 bg-surface-input border border-surface-border rounded-xl text-ink-primary focus:outline-none focus:border-info transition-colors"
            />
          </div>
        </div>
      </div>

      {/* Feature Toggles Section */}
      <div className="bg-surface-card border border-surface-border rounded-2xl p-6">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-lg bg-info/10 flex items-center justify-center">
            <Shield size={20} className="text-info" />
          </div>
          <h2 className="text-xl font-bold text-ink-primary">Feature Toggles</h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="flex items-center gap-3 p-4 bg-surface-input rounded-xl hover:bg-surface-elevated transition-colors">
            <input
              type="checkbox"
              id="registrations_enabled"
              checked={formData.registrations_enabled}
              onChange={(e) => updateField('registrations_enabled', e.target.checked)}
              className="w-5 h-5 rounded cursor-pointer accent-info"
            />
            <label htmlFor="registrations_enabled" className="text-ink-primary font-medium cursor-pointer select-none flex-1">
              User Registrations Enabled
            </label>
          </div>
          <div className="flex items-center gap-3 p-4 bg-surface-input rounded-xl hover:bg-surface-elevated transition-colors">
            <input
              type="checkbox"
              id="challenges_enabled"
              checked={formData.challenges_enabled}
              onChange={(e) => updateField('challenges_enabled', e.target.checked)}
              className="w-5 h-5 rounded cursor-pointer accent-info"
            />
            <label htmlFor="challenges_enabled" className="text-ink-primary font-medium cursor-pointer select-none flex-1">
              Challenge Creation Enabled
            </label>
          </div>
          <div className="flex items-center gap-3 p-4 bg-surface-input rounded-xl hover:bg-surface-elevated transition-colors">
            <input
              type="checkbox"
              id="withdrawals_enabled"
              checked={formData.withdrawals_enabled}
              onChange={(e) => updateField('withdrawals_enabled', e.target.checked)}
              className="w-5 h-5 rounded cursor-pointer accent-info"
            />
            <label htmlFor="withdrawals_enabled" className="text-ink-primary font-medium cursor-pointer select-none flex-1">
              Withdrawals Enabled
            </label>
          </div>
          <div className="flex items-center gap-3 p-4 bg-surface-input rounded-xl hover:bg-surface-elevated transition-colors">
            <input
              type="checkbox"
              id="referral_program_enabled"
              checked={formData.referral_program_enabled}
              onChange={(e) => updateField('referral_program_enabled', e.target.checked)}
              className="w-5 h-5 rounded cursor-pointer accent-info"
            />
            <label htmlFor="referral_program_enabled" className="text-ink-primary font-medium cursor-pointer select-none flex-1">
              Referral Program Enabled
            </label>
          </div>
        </div>
      </div>

      {/* Notifications Section */}
      <div className="bg-surface-card border border-surface-border rounded-2xl p-6">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-lg bg-warn/10 flex items-center justify-center">
            <Bell size={20} className="text-warn" />
          </div>
          <h2 className="text-xl font-bold text-ink-primary">Notifications & Contact</h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-ink-secondary mb-2">
              Admin Email
            </label>
            <input
              type="email"
              value={formData.admin_email}
              onChange={(e) => updateField('admin_email', e.target.value)}
              className="w-full px-4 py-2.5 bg-surface-input border border-surface-border rounded-xl text-ink-primary focus:outline-none focus:border-info transition-colors"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-ink-secondary mb-2">
              Support Email
            </label>
            <input
              type="email"
              value={formData.support_email}
              onChange={(e) => updateField('support_email', e.target.value)}
              className="w-full px-4 py-2.5 bg-surface-input border border-surface-border rounded-xl text-ink-primary focus:outline-none focus:border-info transition-colors"
            />
          </div>
          <div className="md:col-span-2">
            <div className="flex items-center gap-3 p-4 bg-surface-input rounded-xl">
              <input
                type="checkbox"
                id="email_notifications"
                checked={formData.email_notifications_enabled}
                onChange={(e) => updateField('email_notifications_enabled', e.target.checked)}
                className="w-5 h-5 rounded cursor-pointer accent-info"
              />
              <label htmlFor="email_notifications" className="text-ink-primary font-medium cursor-pointer select-none">
                Email Notifications Enabled
              </label>
            </div>
          </div>
        </div>
      </div>

      {/* Maintenance Mode Section */}
      <div 
        className={`bg-surface-card border-2 rounded-2xl p-6 ${
          formData.maintenance_mode ? 'border-down' : 'border-surface-border'
        }`}
      >
        <div className="flex items-center gap-3 mb-6">
          <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${
            formData.maintenance_mode ? 'bg-down/20' : 'bg-down/10'
          }`}>
            <AlertTriangle size={20} className="text-down" />
          </div>
          <div className="flex-1">
            <h2 className="text-xl font-bold text-ink-primary flex items-center gap-2">
              Maintenance Mode
              {formData.maintenance_mode && (
                <span className="text-sm font-semibold px-3 py-1 bg-down/20 text-down rounded-full">
                  ACTIVE
                </span>
              )}
            </h2>
          </div>
        </div>
        <div className="space-y-4">
          <div className={`flex items-center gap-3 p-4 rounded-xl ${
            formData.maintenance_mode ? 'bg-down/10 border border-down/30' : 'bg-surface-input'
          }`}>
            <input
              type="checkbox"
              id="maintenance_mode"
              checked={formData.maintenance_mode}
              onChange={(e) => updateField('maintenance_mode', e.target.checked)}
              className="w-5 h-5 rounded cursor-pointer accent-down"
            />
            <label htmlFor="maintenance_mode" className="text-ink-primary font-medium cursor-pointer select-none flex-1">
              Enable Maintenance Mode (Blocks all user access)
            </label>
          </div>
          {formData.maintenance_mode && (
            <div>
              <label className="block text-sm font-medium text-ink-secondary mb-2">
                Maintenance Message
              </label>
              <textarea
                value={formData.maintenance_message}
                onChange={(e) => updateField('maintenance_message', e.target.value)}
                rows={3}
                placeholder="Message to display to users during maintenance..."
                className="w-full px-4 py-3 bg-surface-input border border-surface-border rounded-xl text-ink-primary focus:outline-none focus:border-down resize-none transition-colors"
              />
            </div>
          )}
        </div>
      </div>

      {/* Save Button (Bottom) */}
      <div className="flex justify-end">
        <button
          onClick={handleSave}
          disabled={saving}
          className="bg-prime text-white px-8 py-4 rounded-xl font-bold text-lg flex items-center gap-3 hover:bg-prime/90 transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-glow"
        >
          <Save size={24} />
          {saving ? 'Saving Settings...' : 'Save All Changes'}
        </button>
      </div>
    </div>
  );
}
