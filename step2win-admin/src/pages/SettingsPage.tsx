import { useEffect, useState } from 'react';
import { adminApi } from '../services/adminApi';
import { Settings, DollarSign, Award, Bell, Shield, Zap, Save } from 'lucide-react';

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
    return <p>Loading settings...</p>;
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h1 style={{ fontSize: '24px', fontWeight: 600, color: '#fff', marginBottom: '4px' }}>
            <Settings size={24} style={{ display: 'inline', marginRight: '8px', verticalAlign: 'middle' }} />
            System Settings
          </h1>
          {settings.updated_at && (
            <p style={{ color: '#64748b', fontSize: '14px' }}>
              Last updated {new Date(settings.updated_at).toLocaleString()}
              {settings.updated_by && ` by ${settings.updated_by}`}
            </p>
          )}
        </div>
        <button
          onClick={handleSave}
          disabled={saving}
          style={{
            padding: '12px 24px',
            background: '#00f5e9',
            color: '#091120',
            border: 'none',
            borderRadius: '6px',
            cursor: saving ? 'not-allowed' : 'pointer',
            fontWeight: 600,
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            opacity: saving ? 0.6 : 1,
          }}
        >
          <Save size={18} />
          {saving ? 'Saving...' : 'Save Changes'}
        </button>
      </div>

      {/* Messages */}
      {error && (
        <div style={{ padding: '12px', background: '#7f1d1d', borderRadius: '6px', color: '#fca5a5' }}>
          {error}
        </div>
      )}
      {successMsg && (
        <div style={{ padding: '12px', background: '#065f46', borderRadius: '6px', color: '#6ee7b7' }}>
          {successMsg}
        </div>
      )}

      {/* Platform Fees Section */}
      <div className="stat-card">
        <h2 style={{ fontSize: '18px', fontWeight: 600, marginBottom: '20px', color: '#fff', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <DollarSign size={20} color="#22c55e" />
          Platform Fees & Payments
        </h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '20px' }}>
          <div>
            <label style={{ display: 'block', marginBottom: '8px', color: '#64748b', fontSize: '14px' }}>
              Platform Fee Percentage (%)
            </label>
            <input
              type="number"
              step="0.01"
              value={formData.platform_fee_percentage}
              onChange={(e) => updateField('platform_fee_percentage', parseFloat(e.target.value) || 0)}
              style={{
                width: '100%',
                padding: '10px 12px',
                background: '#1a2332',
                border: '1px solid #2d3748',
                borderRadius: '6px',
                color: '#fff',
              }}
            />
          </div>
          <div>
            <label style={{ display: 'block', marginBottom: '8px', color: '#64748b', fontSize: '14px' }}>
              Minimum Withdrawal Amount (KSh)
            </label>
            <input
              type="number"
              step="0.01"
              value={formData.minimum_withdrawal_amount}
              onChange={(e) => updateField('minimum_withdrawal_amount', parseFloat(e.target.value) || 0)}
              style={{
                width: '100%',
                padding: '10px 12px',
                background: '#1a2332',
                border: '1px solid #2d3748',
                borderRadius: '6px',
                color: '#fff',
              }}
            />
          </div>
          <div>
            <label style={{ display: 'block', marginBottom: '8px', color: '#64748b', fontSize: '14px' }}>
              Withdrawal Processing Time (hours)
            </label>
            <input
              type="number"
              value={formData.withdrawal_processing_time}
              onChange={(e) => updateField('withdrawal_processing_time', parseInt(e.target.value) || 0)}
              style={{
                width: '100%',
                padding: '10px 12px',
                background: '#1a2332',
                border: '1px solid #2d3748',
                borderRadius: '6px',
                color: '#fff',
              }}
            />
          </div>
        </div>
      </div>

      {/* Challenge Settings Section */}
      <div className="stat-card">
        <h2 style={{ fontSize: '18px', fontWeight: 600, marginBottom: '20px', color: '#fff', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Zap size={20} color="#fbbf24" />
          Challenge Configuration
        </h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '20px' }}>
          <div>
            <label style={{ display: 'block', marginBottom: '8px', color: '#64748b', fontSize: '14px' }}>
              Minimum Entry Fee (KSh)
            </label>
            <input
              type="number"
              step="0.01"
              value={formData.min_challenge_entry_fee}
              onChange={(e) => updateField('min_challenge_entry_fee', parseFloat(e.target.value) || 0)}
              style={{
                width: '100%',
                padding: '10px 12px',
                background: '#1a2332',
                border: '1px solid #2d3748',
                borderRadius: '6px',
                color: '#fff',
              }}
            />
          </div>
          <div>
            <label style={{ display: 'block', marginBottom: '8px', color: '#64748b', fontSize: '14px' }}>
              Maximum Entry Fee (KSh)
            </label>
            <input
              type="number"
              step="0.01"
              value={formData.max_challenge_entry_fee}
              onChange={(e) => updateField('max_challenge_entry_fee', parseFloat(e.target.value) || 0)}
              style={{
                width: '100%',
                padding: '10px 12px',
                background: '#1a2332',
                border: '1px solid #2d3748',
                borderRadius: '6px',
                color: '#fff',
              }}
            />
          </div>
          <div>
            <label style={{ display: 'block', marginBottom: '8px', color: '#64748b', fontSize: '14px' }}>
              Minimum Milestone (steps)
            </label>
            <input
              type="number"
              value={formData.min_challenge_milestone}
              onChange={(e) => updateField('min_challenge_milestone', parseInt(e.target.value) || 0)}
              style={{
                width: '100%',
                padding: '10px 12px',
                background: '#1a2332',
                border: '1px solid #2d3748',
                borderRadius: '6px',
                color: '#fff',
              }}
            />
          </div>
          <div>
            <label style={{ display: 'block', marginBottom: '8px', color: '#64748b', fontSize: '14px' }}>
              Maximum Milestone (steps)
            </label>
            <input
              type="number"
              value={formData.max_challenge_milestone}
              onChange={(e) => updateField('max_challenge_milestone', parseInt(e.target.value) || 0)}
              style={{
                width: '100%',
                padding: '10px 12px',
                background: '#1a2332',
                border: '1px solid #2d3748',
                borderRadius: '6px',
                color: '#fff',
              }}
            />
          </div>
          <div>
            <label style={{ display: 'block', marginBottom: '8px', color: '#64748b', fontSize: '14px' }}>
              Maximum Participants
            </label>
            <input
              type="number"
              value={formData.max_challenge_participants}
              onChange={(e) => updateField('max_challenge_participants', parseInt(e.target.value) || 0)}
              style={{
                width: '100%',
                padding: '10px 12px',
                background: '#1a2332',
                border: '1px solid #2d3748',
                borderRadius: '6px',
                color: '#fff',
              }}
            />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 0' }}>
            <input
              type="checkbox"
              id="challenge_approval"
              checked={formData.challenge_approval_required}
              onChange={(e) => updateField('challenge_approval_required', e.target.checked)}
              style={{ width: '20px', height: '20px', cursor: 'pointer' }}
            />
            <label htmlFor="challenge_approval" style={{ color: '#fff', cursor: 'pointer' }}>
              Require Admin Approval for Challenges
            </label>
          </div>
        </div>
      </div>

      {/* Gamification Settings Section */}
      <div className="stat-card">
        <h2 style={{ fontSize: '18px', fontWeight: 600, marginBottom: '20px', color: '#fff', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Award size={20} color="#a78bfa" />
          Gamification Settings
        </h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '20px' }}>
          <div>
            <label style={{ display: 'block', marginBottom: '8px', color: '#64748b', fontSize: '14px' }}>
              XP Per Step
            </label>
            <input
              type="number"
              step="0.01"
              value={formData.xp_per_step}
              onChange={(e) => updateField('xp_per_step', parseFloat(e.target.value) || 0)}
              style={{
                width: '100%',
                padding: '10px 12px',
                background: '#1a2332',
                border: '1px solid #2d3748',
                borderRadius: '6px',
                color: '#fff',
              }}
            />
          </div>
          <div>
            <label style={{ display: 'block', marginBottom: '8px', color: '#64748b', fontSize: '14px' }}>
              Daily Goal Bonus XP
            </label>
            <input
              type="number"
              value={formData.daily_goal_bonus_xp}
              onChange={(e) => updateField('daily_goal_bonus_xp', parseInt(e.target.value) || 0)}
              style={{
                width: '100%',
                padding: '10px 12px',
                background: '#1a2332',
                border: '1px solid #2d3748',
                borderRadius: '6px',
                color: '#fff',
              }}
            />
          </div>
        </div>
      </div>

      {/* Feature Toggles Section */}
      <div className="stat-card">
        <h2 style={{ fontSize: '18px', fontWeight: 600, marginBottom: '20px', color: '#fff', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Shield size={20} color="#60a5fa" />
          Feature Toggles
        </h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '12px', background: '#1a2332', borderRadius: '6px' }}>
            <input
              type="checkbox"
              id="registrations_enabled"
              checked={formData.registrations_enabled}
              onChange={(e) => updateField('registrations_enabled', e.target.checked)}
              style={{ width: '20px', height: '20px', cursor: 'pointer' }}
            />
            <label htmlFor="registrations_enabled" style={{ color: '#fff', cursor: 'pointer', flex: 1 }}>
              User Registrations Enabled
            </label>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '12px', background: '#1a2332', borderRadius: '6px' }}>
            <input
              type="checkbox"
              id="challenges_enabled"
              checked={formData.challenges_enabled}
              onChange={(e) => updateField('challenges_enabled', e.target.checked)}
              style={{ width: '20px', height: '20px', cursor: 'pointer' }}
            />
            <label htmlFor="challenges_enabled" style={{ color: '#fff', cursor: 'pointer', flex: 1 }}>
              Challenge Creation Enabled
            </label>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '12px', background: '#1a2332', borderRadius: '6px' }}>
            <input
              type="checkbox"
              id="withdrawals_enabled"
              checked={formData.withdrawals_enabled}
              onChange={(e) => updateField('withdrawals_enabled', e.target.checked)}
              style={{ width: '20px', height: '20px', cursor: 'pointer' }}
            />
            <label htmlFor="withdrawals_enabled" style={{ color: '#fff', cursor: 'pointer', flex: 1 }}>
              Withdrawals Enabled
            </label>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '12px', background: '#1a2332', borderRadius: '6px' }}>
            <input
              type="checkbox"
              id="referral_program_enabled"
              checked={formData.referral_program_enabled}
              onChange={(e) => updateField('referral_program_enabled', e.target.checked)}
              style={{ width: '20px', height: '20px', cursor: 'pointer' }}
            />
            <label htmlFor="referral_program_enabled" style={{ color: '#fff', cursor: 'pointer', flex: 1 }}>
              Referral Program Enabled
            </label>
          </div>
        </div>
      </div>

      {/* Notifications Section */}
      <div className="stat-card">
        <h2 style={{ fontSize: '18px', fontWeight: 600, marginBottom: '20px', color: '#fff', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Bell size={20} color="#f59e0b" />
          Notifications & Contact
        </h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '20px' }}>
          <div>
            <label style={{ display: 'block', marginBottom: '8px', color: '#64748b', fontSize: '14px' }}>
              Admin Email
            </label>
            <input
              type="email"
              value={formData.admin_email}
              onChange={(e) => updateField('admin_email', e.target.value)}
              style={{
                width: '100%',
                padding: '10px 12px',
                background: '#1a2332',
                border: '1px solid #2d3748',
                borderRadius: '6px',
                color: '#fff',
              }}
            />
          </div>
          <div>
            <label style={{ display: 'block', marginBottom: '8px', color: '#64748b', fontSize: '14px' }}>
              Support Email
            </label>
            <input
              type="email"
              value={formData.support_email}
              onChange={(e) => updateField('support_email', e.target.value)}
              style={{
                width: '100%',
                padding: '10px 12px',
                background: '#1a2332',
                border: '1px solid #2d3748',
                borderRadius: '6px',
                color: '#fff',
              }}
            />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 0' }}>
            <input
              type="checkbox"
              id="email_notifications"
              checked={formData.email_notifications_enabled}
              onChange={(e) => updateField('email_notifications_enabled', e.target.checked)}
              style={{ width: '20px', height: '20px', cursor: 'pointer' }}
            />
            <label htmlFor="email_notifications" style={{ color: '#fff', cursor: 'pointer' }}>
              Email Notifications Enabled
            </label>
          </div>
        </div>
      </div>

      {/* Maintenance Mode Section */}
      <div className="stat-card" style={{ borderLeft: formData.maintenance_mode ? '4px solid #ef4444' : 'none' }}>
        <h2 style={{ fontSize: '18px', fontWeight: 600, marginBottom: '20px', color: formData.maintenance_mode ? '#ef4444' : '#fff', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Shield size={20} color="#ef4444" />
          Maintenance Mode {formData.maintenance_mode && '(ACTIVE)'}
        </h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '12px', background: formData.maintenance_mode ? '#7f1d1d' : '#1a2332', borderRadius: '6px' }}>
            <input
              type="checkbox"
              id="maintenance_mode"
              checked={formData.maintenance_mode}
              onChange={(e) => updateField('maintenance_mode', e.target.checked)}
              style={{ width: '20px', height: '20px', cursor: 'pointer' }}
            />
            <label htmlFor="maintenance_mode" style={{ color: '#fff', cursor: 'pointer', flex: 1 }}>
              Enable Maintenance Mode (Blocks all user access)
            </label>
          </div>
          {formData.maintenance_mode && (
            <div>
              <label style={{ display: 'block', marginBottom: '8px', color: '#64748b', fontSize: '14px' }}>
                Maintenance Message
              </label>
              <textarea
                value={formData.maintenance_message}
                onChange={(e) => updateField('maintenance_message', e.target.value)}
                rows={3}
                placeholder="Message to display to users during maintenance..."
                style={{
                  width: '100%',
                  padding: '10px 12px',
                  background: '#1a2332',
                  border: '1px solid #2d3748',
                  borderRadius: '6px',
                  color: '#fff',
                  resize: 'vertical',
                  fontFamily: 'inherit',
                }}
              />
            </div>
          )}
        </div>
      </div>

      {/* Save Button (Bottom) */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', paddingTop: '16px' }}>
        <button
          onClick={handleSave}
          disabled={saving}
          style={{
            padding: '14px 28px',
            background: '#00f5e9',
            color: '#091120',
            border: 'none',
            borderRadius: '6px',
            cursor: saving ? 'not-allowed' : 'pointer',
            fontWeight: 600,
            fontSize: '16px',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            opacity: saving ? 0.6 : 1,
          }}
        >
          <Save size={20} />
          {saving ? 'Saving Settings...' : 'Save All Changes'}
        </button>
      </div>
    </div>
  );
}
