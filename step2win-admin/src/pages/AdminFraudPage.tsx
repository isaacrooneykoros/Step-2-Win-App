import { useState, useEffect } from 'react';
import { adminApi } from '../services/adminApi';
import { AlertTriangle, SearchX, Check, X, Shield, Lock, Ban, Pause, Eye, Search } from 'lucide-react';
import type { FraudOverview, FraudFlag } from '../types/admin';

export function AdminFraudPage() {
  const [overview, setOverview] = useState<FraudOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [selectedFlag, setSelectedFlag] = useState<FraudFlag | null>(null);
  const [actionInProgress, setActionInProgress] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [filterSeverity, setFilterSeverity] = useState<'all' | 'critical' | 'high' | 'medium' | 'low'>('all');
  
  // Confirmation modal state
  const [confirmModalOpen, setConfirmModalOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState<'unban' | 'unsuspend' | 'unrestrict' | null>(null);
  const [pendingFlagId, setPendingFlagId] = useState<number | null>(null);
  const [pendingUsername, setPendingUsername] = useState<string>('');

  useEffect(() => {
    loadFraudData();
    const interval = setInterval(loadFraudData, 30000);
    return () => clearInterval(interval);
  }, []);

  const loadFraudData = async () => {
    try {
      setLoadError('');
      const data = await adminApi.getFraudOverview();
      setOverview(data);
      setLastUpdated(new Date().toLocaleTimeString());
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Failed to fetch fraud data');
      console.error('Failed to fetch fraud data', error);
    } finally {
      setLoading(false);
    }
  };

  const handleAction = async (
    flagId: number,
    action:
      | 'dismiss'
      | 'warn'
      | 'restrict'
      | 'suspend'
      | 'ban'
      | 'unrestrict'
      | 'unsuspend'
      | 'unban'
  ) => {
    setActionInProgress(true);
    try {
      await adminApi.actionFraudFlag(flagId, action);
      setSelectedFlag(null);
      await loadFraudData();
    } catch (error) {
      console.error('Action failed:', error);
    } finally {
      setActionInProgress(false);
    }
  };

  const openConfirmModal = (action: 'unban' | 'unsuspend' | 'unrestrict', flagId: number, username: string) => {
    setPendingAction(action);
    setPendingFlagId(flagId);
    setPendingUsername(username);
    setConfirmModalOpen(true);
  };

  const confirmAndExecute = async () => {
    if (pendingAction && pendingFlagId !== null) {
      setConfirmModalOpen(false);
      await handleAction(pendingFlagId, pendingAction);
      setPendingAction(null);
      setPendingFlagId(null);
      setPendingUsername('');
    }
  };

  const cancelConfirmModal = () => {
    setConfirmModalOpen(false);
    setPendingAction(null);
    setPendingFlagId(null);
    setPendingUsername('');
  };

  // Filter flags based on search and severity
  const filteredFlags = overview?.recent_flags.filter((flag) => {
    const normalizedUsername = (flag.user_username || '').toLowerCase();
    const normalizedFlagType = (flag.flag_type || '').toLowerCase();
    const normalizedSearch = searchTerm.toLowerCase();

    const matchesSearch =
      normalizedUsername.includes(normalizedSearch) ||
      normalizedFlagType.includes(normalizedSearch);

    const matchesSeverity = filterSeverity === 'all' || flag.severity === filterSeverity;

    return matchesSearch && matchesSeverity;
  }) || [];

  const selectedFlagDetails =
    selectedFlag && selectedFlag.details && typeof selectedFlag.details === 'object'
      ? selectedFlag.details
      : null;

  const selectedFlagNote =
    selectedFlagDetails && typeof selectedFlagDetails.note === 'string'
      ? selectedFlagDetails.note
      : 'No additional details';

  const reviewedFlags = overview?.reviewed_flags || [];

  const getTrustBadgeStyle = (status?: FraudFlag['current_trust_status']) => {
    if (status === 'BAN') return { bg: '#fee2e2', text: '#991b1b' };
    if (status === 'SUSPEND') return { bg: '#ede9fe', text: '#5b21b6' };
    if (status === 'RESTRICT') return { bg: '#dbeafe', text: '#1e40af' };
    if (status === 'REVIEW') return { bg: '#fef3c7', text: '#92400e' };
    if (status === 'WARN') return { bg: '#fef9c3', text: '#854d0e' };
    return { bg: '#dcfce7', text: '#166534' };
  };

  if (loading)
    return <div className="text-center py-8 text-gray-500">Loading fraud data...</div>;

  if (!overview)
    return <div className="text-center py-8 text-red-500">Failed to load fraud data</div>;

  return (
    <div className="space-y-6">
      {/* Header Section */}
      <div style={{ 
        background: 'linear-gradient(135deg, #7C6FF7, #4F9CF9)',
        padding: '24px',
        borderRadius: '12px',
        border: '1px solid #21263A'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '8px' }}>
          <Shield size={32} style={{ color: '#fff' }} />
          <h2 style={{ fontSize: '28px', fontWeight: 700, color: '#fff', margin: 0 }}>
            Anti-Cheat Monitor
          </h2>
        </div>
        <p style={{ color: '#F0F2F8', margin: 0, fontSize: '15px', opacity: 0.9 }}>
          Real-time fraud detection and case management system • Last updated: {lastUpdated || 'Syncing...'}
        </p>
      </div>

      {loadError && (
        <div
          style={{
            padding: '12px 16px',
            background: 'rgba(240, 96, 96, 0.1)',
            color: '#F06060',
            borderRadius: '8px',
            border: '1px solid rgba(240, 96, 96, 0.2)',
            fontSize: '14px',
            fontWeight: 500,
          }}
        >
          {loadError}
        </div>
      )}

      {/* Stats Grid */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <div style={{ 
          background: '#13161F',
          padding: '20px',
          borderRadius: '12px',
          border: '1px solid #21263A',
          boxShadow: '0 1px 3px rgba(0,0,0,0.3)'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '8px' }}>
            <Eye size={20} style={{ color: '#7B82A0' }} />
            <p style={{ color: '#7B82A0', fontSize: '14px', fontWeight: 600, margin: 0 }}>Open Cases</p>
          </div>
          <p style={{ fontSize: '32px', fontWeight: 700, color: '#F0F2F8', margin: 0 }}>{overview.open_flags}</p>
        </div>

        <div style={{ 
          background: '#13161F',
          padding: '20px',
          borderRadius: '12px',
          border: '1px solid rgba(240, 96, 96, 0.3)',
          boxShadow: '0 1px 3px rgba(240,96,96,0.2)'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '8px' }}>
            <AlertTriangle size={20} style={{ color: '#F06060' }} />
            <p style={{ color: '#F06060', fontSize: '14px', fontWeight: 600, margin: 0 }}>Critical</p>
          </div>
          <p style={{ fontSize: '32px', fontWeight: 700, color: '#F0F2F8', margin: 0 }}>{overview.critical_unread}</p>
        </div>

        <div style={{ 
          background: '#13161F',
          padding: '20px',
          borderRadius: '12px',
          border: '1px solid rgba(245, 166, 35, 0.3)',
          boxShadow: '0 1px 3px rgba(245,166,35,0.2)'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '8px' }}>
            <AlertTriangle size={20} style={{ color: '#F5A623' }} />
            <p style={{ color: '#F5A623', fontSize: '14px', fontWeight: 600, margin: 0 }}>High Priority</p>
          </div>
          <p style={{ fontSize: '32px', fontWeight: 700, color: '#F0F2F8', margin: 0 }}>{overview.high_unread}</p>
        </div>

        <div style={{ 
          background: '#13161F',
          padding: '20px',
          borderRadius: '12px',
          border: '1px solid rgba(79, 156, 249, 0.3)',
          boxShadow: '0 1px 3px rgba(79,156,249,0.2)'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '8px' }}>
            <Lock size={20} style={{ color: '#4F9CF9' }} />
            <p style={{ color: '#4F9CF9', fontSize: '14px', fontWeight: 600, margin: 0 }}>Restricted</p>
          </div>
          <p style={{ fontSize: '32px', fontWeight: 700, color: '#F0F2F8', margin: 0 }}>{overview.restricted_users}</p>
        </div>

        <div style={{ 
          background: '#13161F',
          padding: '20px',
          borderRadius: '12px',
          border: '1px solid rgba(124, 111, 247, 0.3)',
          boxShadow: '0 1px 3px rgba(124,111,247,0.2)'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '8px' }}>
            <Pause size={20} style={{ color: '#7C6FF7' }} />
            <p style={{ color: '#7C6FF7', fontSize: '14px', fontWeight: 600, margin: 0 }}>Suspended</p>
          </div>
          <p style={{ fontSize: '32px', fontWeight: 700, color: '#F0F2F8', margin: 0 }}>{overview.suspended_users}</p>
        </div>

        <div style={{ 
          background: '#13161F',
          padding: '20px',
          borderRadius: '12px',
          border: '1px solid rgba(240, 96, 96, 0.4)',
          boxShadow: '0 1px 3px rgba(240,96,96,0.3)'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '8px' }}>
            <Ban size={20} style={{ color: '#F06060' }} />
            <p style={{ color: '#F06060', fontSize: '14px', fontWeight: 600, margin: 0 }}>Banned</p>
          </div>
          <p style={{ fontSize: '32px', fontWeight: 700, color: '#F0F2F8', margin: 0 }}>{overview.banned_users}</p>
        </div>
      </div>

      {/* Filters Section */}
      <div style={{ 
        background: '#0C1117',
        padding: '20px',
        borderRadius: '12px',
        border: '1px solid #1A2430',
        display: 'flex',
        gap: '16px',
        flexWrap: 'wrap',
        alignItems: 'center'
      }}>
        <div style={{ position: 'relative', flex: '1', minWidth: '250px' }}>
          <Search size={18} style={{ 
            position: 'absolute', 
            left: '12px', 
            top: '50%', 
            transform: 'translateY(-50%)', 
            color: '#7B82A0' 
          }} />
          <input
            type="text"
            placeholder="Search by username or flag type..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            style={{
              width: '100%',
              padding: '10px 12px 10px 40px',
              background: '#13161F',
              border: '1px solid #21263A',
              borderRadius: '8px',
              color: '#F0F2F8',
              fontSize: '14px'
            }}
          />
        </div>

        <select
          value={filterSeverity}
          onChange={(e) => setFilterSeverity(e.target.value as 'all' | 'critical' | 'high' | 'medium' | 'low')}
          style={{
            padding: '10px 16px',
            background: '#13161F',
            border: '1px solid #21263A',
            borderRadius: '8px',
            color: '#F0F2F8',
            fontSize: '14px',
            fontWeight: 500,
            cursor: 'pointer'
          }}
        >
          <option value="all">All Severities</option>
          <option value="critical">Critical Only</option>
          <option value="high">High Priority</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
        </select>

        <div style={{ 
          marginLeft: 'auto',
          color: '#7B82A0',
          fontSize: '14px',
          fontWeight: 500
        }}>
          {filteredFlags.length} flag{filteredFlags.length !== 1 ? 's' : ''} found
        </div>
      </div>

      {/* Recent Flags Table */}
      <div style={{ 
        background: '#0C1117',
        borderRadius: '12px',
        border: '1px solid #1A2430',
        overflow: 'hidden'
      }}>
        <div style={{ 
          padding: '20px 24px',
          background: '#13161F',
          borderBottom: '1px solid #21263A'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <AlertTriangle size={20} style={{ color: '#7C6FF7' }} />
            <h2 style={{ fontSize: '18px', fontWeight: 700, color: '#F0F2F8', margin: 0 }}>
              Recent Flags Today
            </h2>
            <span style={{ 
              background: 'linear-gradient(135deg, #7C6FF7, #4F9CF9)',
              color: '#fff',
              padding: '4px 12px',
              borderRadius: '12px',
              fontSize: '13px',
              fontWeight: 700
            }}>
              {overview.flags_today}
            </span>
          </div>
        </div>

        {filteredFlags.length === 0 ? (
          <div style={{ padding: '48px 24px', textAlign: 'center' }}>
            <SearchX size={48} style={{ margin: '0 auto 12px', color: '#21263A' }} />
            <p style={{ color: '#7B82A0', fontSize: '15px' }}>
              {searchTerm || filterSeverity !== 'all' ? 'No flags match your filters' : 'No unreviewed flags'}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead style={{ background: '#13161F', borderBottom: '2px solid #21263A' }}>
                <tr>
                  <th style={{ padding: '16px 24px', textAlign: 'left', fontWeight: 700, color: '#7B82A0', fontSize: '13px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>User</th>
                  <th style={{ padding: '16px 24px', textAlign: 'left', fontWeight: 700, color: '#7B82A0', fontSize: '13px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Flag Type</th>
                  <th style={{ padding: '16px 24px', textAlign: 'left', fontWeight: 700, color: '#7B82A0', fontSize: '13px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Severity</th>
                  <th style={{ padding: '16px 24px', textAlign: 'left', fontWeight: 700, color: '#7B82A0', fontSize: '13px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Date</th>
                  <th style={{ padding: '16px 24px', textAlign: 'center', fontWeight: 700, color: '#7B82A0', fontSize: '13px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {filteredFlags.map((flag, index) => (
                  <tr
                    key={flag.id}
                    style={{
                      borderBottom: index !== filteredFlags.length - 1 ? '1px solid #1C1F2E' : 'none',
                      cursor: 'pointer',
                      transition: 'background 0.2s'
                    }}
                    onClick={() => setSelectedFlag(flag)}
                    onMouseEnter={(e) => e.currentTarget.style.background = '#13161F'}
                    onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                  >
                    <td style={{ padding: '16px 24px', color: '#F0F2F8', fontWeight: 600, fontSize: '14px' }}>
                      {flag.user_username}
                    </td>
                    <td style={{ padding: '16px 24px', color: '#7B82A0', fontSize: '14px' }}>
                      {flag.flag_type}
                    </td>
                    <td style={{ padding: '16px 24px' }}>
                      <span
                        style={{
                          display: 'inline-block',
                          padding: '4px 12px',
                          borderRadius: '6px',
                          fontSize: '12px',
                          fontWeight: 700,
                          textTransform: 'uppercase',
                          letterSpacing: '0.5px',
                          ...(flag.severity === 'critical' && { background: 'rgba(240, 96, 96, 0.2)', color: '#F06060' }),
                          ...(flag.severity === 'high' && { background: 'rgba(245, 166, 35, 0.2)', color: '#F5A623' }),
                          ...(flag.severity === 'medium' && { background: 'rgba(245, 166, 35, 0.1)', color: '#F5A623' }),
                          ...(flag.severity === 'low' && { background: 'rgba(79, 156, 249, 0.2)', color: '#4F9CF9' }),
                        }}
                      >
                        {flag.severity}
                      </span>
                    </td>
                    <td style={{ padding: '16px 24px', color: '#7B82A0', fontSize: '14px' }}>
                      {new Date(flag.date).toLocaleDateString('en-US', { 
                        month: 'short', 
                        day: 'numeric', 
                        year: 'numeric' 
                      })}
                    </td>
                    <td style={{ padding: '16px 24px', textAlign: 'center' }}>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedFlag(flag);
                        }}
                        style={{
                          padding: '8px 16px',
                          background: 'linear-gradient(135deg, #7C6FF7, #4F9CF9)',
                          color: '#fff',
                          border: 'none',
                          borderRadius: '6px',
                          fontSize: '13px',
                          fontWeight: 700,
                          cursor: 'pointer',
                          transition: 'transform 0.2s, box-shadow 0.2s'
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.transform = 'translateY(-1px)';
                          e.currentTarget.style.boxShadow = '0 4px 12px rgba(124, 111, 247, 0.4)';
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.transform = 'translateY(0)';
                          e.currentTarget.style.boxShadow = 'none';
                        }}
                      >
                        Review
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Decision Review */}
      <div
        style={{
          background: '#0C1117',
          borderRadius: '12px',
          border: '1px solid #1A2430',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            padding: '20px 24px',
            background: '#13161F',
            borderBottom: '1px solid #21263A',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <Shield size={20} style={{ color: '#7C6FF7' }} />
              <h2 style={{ fontSize: '18px', fontWeight: 700, color: '#F0F2F8', margin: 0 }}>
                Decision Review
              </h2>
            </div>
            <span style={{ color: '#7B82A0', fontSize: '13px', fontWeight: 600 }}>
              Reverse previous moderation decisions
            </span>
          </div>
        </div>

        {reviewedFlags.length === 0 ? (
          <div style={{ padding: '24px', color: '#7B82A0', fontSize: '14px' }}>
            No reviewed decisions yet.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead style={{ background: '#13161F', borderBottom: '2px solid #21263A' }}>
                <tr>
                  <th style={{ padding: '14px 16px', textAlign: 'left', fontWeight: 700, color: '#7B82A0', fontSize: '12px', textTransform: 'uppercase' }}>User</th>
                  <th style={{ padding: '14px 16px', textAlign: 'left', fontWeight: 700, color: '#7B82A0', fontSize: '12px', textTransform: 'uppercase' }}>Last Decision</th>
                  <th style={{ padding: '14px 16px', textAlign: 'left', fontWeight: 700, color: '#7B82A0', fontSize: '12px', textTransform: 'uppercase' }}>Current Status</th>
                  <th style={{ padding: '14px 16px', textAlign: 'left', fontWeight: 700, color: '#7B82A0', fontSize: '12px', textTransform: 'uppercase' }}>Score</th>
                  <th style={{ padding: '14px 16px', textAlign: 'center', fontWeight: 700, color: '#7B82A0', fontSize: '12px', textTransform: 'uppercase' }}>Reverse Action</th>
                </tr>
              </thead>
              <tbody>
                {reviewedFlags.map((flag, index) => {
                  const trustStyle = getTrustBadgeStyle(flag.current_trust_status);
                  return (
                    <tr key={`review-${flag.id}`} style={{ borderBottom: index !== reviewedFlags.length - 1 ? '1px solid #1C1F2E' : 'none' }}>
                      <td style={{ padding: '14px 16px', color: '#F0F2F8', fontWeight: 600 }}>{flag.user_username}</td>
                      <td style={{ padding: '14px 16px', color: '#7B82A0' }}>{(flag.last_action || 'n/a').replace('_', ' ')}</td>
                      <td style={{ padding: '14px 16px' }}>
                        <span
                          style={{
                            display: 'inline-block',
                            padding: '4px 10px',
                            borderRadius: '9999px',
                            fontSize: '12px',
                            fontWeight: 700,
                            background: trustStyle.bg,
                            color: trustStyle.text,
                          }}
                        >
                          {flag.current_trust_status || 'GOOD'}
                        </span>
                      </td>
                      <td style={{ padding: '14px 16px', color: '#F0F2F8', fontWeight: 600 }}>
                        {flag.current_trust_score ?? 100}/100
                      </td>
                      <td style={{ padding: '14px 16px', textAlign: 'center' }}>
                        <div style={{ display: 'flex', justifyContent: 'center', gap: '8px', flexWrap: 'wrap' }}>
                          {flag.current_trust_status === 'BAN' && (
                            <button
                              onClick={() => openConfirmModal('unban', flag.id, flag.user_username)}
                              disabled={actionInProgress}
                              style={{
                                padding: '6px 10px',
                                borderRadius: '6px',
                                border: 'none',
                                background: 'rgba(34, 211, 160, 0.2)',
                                color: '#22D3A0',
                                fontSize: '12px',
                                fontWeight: 700,
                                cursor: actionInProgress ? 'not-allowed' : 'pointer',
                                opacity: actionInProgress ? 0.6 : 1,
                              }}
                            >
                              Unban
                            </button>
                          )}
                          {flag.current_trust_status === 'SUSPEND' && (
                            <button
                              onClick={() => openConfirmModal('unsuspend', flag.id, flag.user_username)}
                              disabled={actionInProgress}
                              style={{
                                padding: '6px 10px',
                                borderRadius: '6px',
                                border: 'none',
                                background: 'rgba(124, 111, 247, 0.2)',
                                color: '#7C6FF7',
                                fontSize: '12px',
                                fontWeight: 700,
                                cursor: actionInProgress ? 'not-allowed' : 'pointer',
                                opacity: actionInProgress ? 0.6 : 1,
                              }}
                            >
                              Unsuspend
                            </button>
                          )}
                          {flag.current_trust_status === 'RESTRICT' && (
                            <button
                              onClick={() => openConfirmModal('unrestrict', flag.id, flag.user_username)}
                              disabled={actionInProgress}
                              style={{
                                padding: '6px 10px',
                                borderRadius: '6px',
                                border: 'none',
                                background: 'rgba(79, 156, 249, 0.2)',
                                color: '#4F9CF9',
                                fontSize: '12px',
                                fontWeight: 700,
                                cursor: actionInProgress ? 'not-allowed' : 'pointer',
                                opacity: actionInProgress ? 0.6 : 1,
                              }}
                            >
                              Unrestrict
                            </button>
                          )}
                          {!['BAN', 'SUSPEND', 'RESTRICT'].includes(flag.current_trust_status || 'GOOD') && (
                            <span style={{ color: '#7B82A0', fontSize: '12px', fontWeight: 600 }}>No reversal needed</span>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Flag Detail Modal */}
      {selectedFlag && (
        <div style={{ 
          position: 'fixed',
          inset: 0,
          background: 'rgba(0, 0, 0, 0.75)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 50,
          padding: '16px'
        }}>
          <div style={{ 
            background: '#13161F',
            borderRadius: '16px',
            boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)',
            maxWidth: '700px',
            width: '100%',
            maxHeight: '90vh',
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
            border: '1px solid #21263A'
          }}>
            <div style={{ 
              padding: '24px',
              background: 'linear-gradient(135deg, #7C6FF7, #4F9CF9)',
              borderBottom: '1px solid #21263A',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <Shield size={24} style={{ color: '#fff' }} />
                <h3 style={{ fontSize: '20px', fontWeight: 700, color: '#ffffff', margin: 0 }}>
                  Flag Details
                </h3>
              </div>
              <button
                onClick={() => setSelectedFlag(null)}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: 'rgba(255,255,255,0.8)',
                  cursor: 'pointer',
                  padding: '8px',
                  borderRadius: '6px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  transition: 'background 0.2s'
                }}
                onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.1)'}
                onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
              >
                <X size={20} />
              </button>
            </div>

            <div style={{ 
              padding: '24px',
              overflowY: 'auto',
              flex: 1
            }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                <div>
                  <p style={{ fontSize: '12px', color: '#7B82A0', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '6px' }}>
                    User
                  </p>
                  <p style={{ fontSize: '16px', fontWeight: 700, color: '#F0F2F8', margin: 0 }}>
                    {selectedFlag.user_username}
                  </p>
                  <p style={{ fontSize: '14px', color: '#7B82A0', marginTop: '4px' }}>
                    {selectedFlag.user_email}
                  </p>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
                  <div>
                    <p style={{ fontSize: '12px', color: '#7B82A0', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '6px' }}>
                      Flag Type
                    </p>
                    <p style={{ fontSize: '15px', fontWeight: 600, color: '#F0F2F8', margin: 0 }}>
                      {selectedFlag.flag_type}
                    </p>
                  </div>
                  <div>
                    <p style={{ fontSize: '12px', color: '#7B82A0', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '6px' }}>
                      Severity
                    </p>
                    <span
                      style={{
                        display: 'inline-block',
                        padding: '6px 16px',
                        borderRadius: '8px',
                        fontSize: '13px',
                        fontWeight: 700,
                        textTransform: 'uppercase',
                        letterSpacing: '0.5px',
                        ...(selectedFlag.severity === 'critical' && { background: 'rgba(240, 96, 96, 0.2)', color: '#F06060' }),
                        ...(selectedFlag.severity === 'high' && { background: 'rgba(245, 166, 35, 0.2)', color: '#F5A623' }),
                        ...(selectedFlag.severity === 'medium' && { background: 'rgba(245, 166, 35, 0.1)', color: '#F5A623' }),
                        ...(selectedFlag.severity === 'low' && { background: 'rgba(79, 156, 249, 0.2)', color: '#4F9CF9' }),
                      }}
                    >
                      {selectedFlag.severity}
                    </span>
                  </div>
                </div>

                <div>
                  <p style={{ fontSize: '12px', color: '#7B82A0', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px' }}>
                    Details
                  </p>
                  <pre style={{ 
                    background: '#0C1117',
                    padding: '16px',
                    borderRadius: '8px',
                    fontSize: '13px',
                    color: '#F0F2F8',
                    overflowX: 'auto',
                    border: '1px solid #21263A',
                    margin: 0
                  }}>
                    {JSON.stringify(selectedFlagDetails ?? {}, null, 2)}
                  </pre>
                </div>

                <div style={{ 
                  background: 'rgba(79, 156, 249, 0.1)',
                  padding: '16px',
                  borderRadius: '8px',
                  border: '1px solid rgba(79, 156, 249, 0.2)'
                }}>
                  <p style={{ fontSize: '14px', color: '#4F9CF9', margin: 0 }}>
                    <strong style={{ fontWeight: 700 }}>Note:</strong> {selectedFlagNote}
                  </p>
                </div>

                <div style={{ 
                  display: 'flex',
                  gap: '8px',
                  flexWrap: 'wrap',
                  paddingTop: '8px',
                  borderTop: '2px solid #1C1F2E'
                }}>
                  <button
                    onClick={() => handleAction(selectedFlag.id, 'dismiss')}
                    disabled={actionInProgress}
                    style={{
                      flex: '1',
                      minWidth: '120px',
                      padding: '12px 16px',
                      background: 'rgba(34, 211, 160, 0.15)',
                      color: '#22D3A0',
                      border: '1px solid rgba(34, 211, 160, 0.3)',
                      borderRadius: '8px',
                      fontSize: '14px',
                      fontWeight: 700,
                      cursor: actionInProgress ? 'not-allowed' : 'pointer',
                      opacity: actionInProgress ? 0.5 : 1,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: '6px',
                      transition: 'all 0.2s'
                    }}
                    onMouseEnter={(e) => !actionInProgress && (e.currentTarget.style.background = 'rgba(34, 211, 160, 0.25)')}
                    onMouseLeave={(e) => (e.currentTarget.style.background = 'rgba(34, 211, 160, 0.15)')}
                  >
                    <Check size={16} /> Dismiss
                  </button>
                  <button
                    onClick={() => handleAction(selectedFlag.id, 'warn')}
                    disabled={actionInProgress}
                    style={{
                      flex: '1',
                      minWidth: '120px',
                      padding: '12px 16px',
                      background: 'rgba(245, 166, 35, 0.15)',
                      color: '#F5A623',
                      border: '1px solid rgba(245, 166, 35, 0.3)',
                      borderRadius: '8px',
                      fontSize: '14px',
                      fontWeight: 700,
                      cursor: actionInProgress ? 'not-allowed' : 'pointer',
                      opacity: actionInProgress ? 0.5 : 1,
                      transition: 'all 0.2s'
                    }}
                    onMouseEnter={(e) => !actionInProgress && (e.currentTarget.style.background = 'rgba(245, 166, 35, 0.25)')}
                    onMouseLeave={(e) => (e.currentTarget.style.background = 'rgba(245, 166, 35, 0.15)')}
                  >
                    Warn
                  </button>
                  <button
                    onClick={() => handleAction(selectedFlag.id, 'restrict')}
                    disabled={actionInProgress}
                    style={{
                      flex: '1',
                      minWidth: '120px',
                      padding: '12px 16px',
                      background: 'rgba(79, 156, 249, 0.15)',
                      color: '#4F9CF9',
                      border: '1px solid rgba(79, 156, 249, 0.3)',
                      borderRadius: '8px',
                      fontSize: '14px',
                      fontWeight: 700,
                      cursor: actionInProgress ? 'not-allowed' : 'pointer',
                      opacity: actionInProgress ? 0.5 : 1,
                      transition: 'all 0.2s'
                    }}
                    onMouseEnter={(e) => !actionInProgress && (e.currentTarget.style.background = 'rgba(79, 156, 249, 0.25)')}
                    onMouseLeave={(e) => (e.currentTarget.style.background = 'rgba(79, 156, 249, 0.15)')}
                  >
                    Restrict
                  </button>
                  <button
                    onClick={() => handleAction(selectedFlag.id, 'suspend')}
                    disabled={actionInProgress}
                    style={{
                      flex: '1',
                      minWidth: '120px',
                      padding: '12px 16px',
                      background: 'rgba(124, 111, 247, 0.15)',
                      color: '#7C6FF7',
                      border: '1px solid rgba(124, 111, 247, 0.3)',
                      borderRadius: '8px',
                      fontSize: '14px',
                      fontWeight: 700,
                      cursor: actionInProgress ? 'not-allowed' : 'pointer',
                      opacity: actionInProgress ? 0.5 : 1,
                      transition: 'all 0.2s'
                    }}
                    onMouseEnter={(e) => !actionInProgress && (e.currentTarget.style.background = 'rgba(124, 111, 247, 0.25)')}
                    onMouseLeave={(e) => (e.currentTarget.style.background = 'rgba(124, 111, 247, 0.15)')}
                  >
                    Suspend
                  </button>
                  <button
                    onClick={() => handleAction(selectedFlag.id, 'ban')}
                    disabled={actionInProgress}
                    style={{
                      flex: '1',
                      minWidth: '120px',
                      padding: '12px 16px',
                      background: 'rgba(240, 96, 96, 0.15)',
                      color: '#F06060',
                      border: '1px solid rgba(240, 96, 96, 0.3)',
                      borderRadius: '8px',
                      fontSize: '14px',
                      fontWeight: 700,
                      cursor: actionInProgress ? 'not-allowed' : 'pointer',
                      opacity: actionInProgress ? 0.5 : 1,
                      transition: 'all 0.2s'
                    }}
                    onMouseEnter={(e) => !actionInProgress && (e.currentTarget.style.background = 'rgba(240, 96, 96, 0.25)')}
                    onMouseLeave={(e) => (e.currentTarget.style.background = 'rgba(240, 96, 96, 0.15)')}
                  >
                    Ban
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Confirmation Modal for Reversal Actions */}
      {confirmModalOpen && pendingAction && (
        <div style={{ 
          position: 'fixed',
          inset: 0,
          background: 'rgba(0, 0, 0, 0.75)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 50,
          padding: '16px'
        }}>
          <div style={{ 
            background: '#13161F',
            borderRadius: '16px',
            boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)',
            maxWidth: '500px',
            width: '100%',
            overflow: 'hidden',
            border: '1px solid #21263A'
          }}>
            <div style={{ 
              padding: '24px',
              background: 'linear-gradient(135deg, #7C6FF7, #4F9CF9)',
              borderBottom: '1px solid #21263A'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <AlertTriangle size={24} style={{ color: '#fff' }} />
                <h3 style={{ fontSize: '20px', fontWeight: 700, color: '#ffffff', margin: 0 }}>
                  Confirm Action
                </h3>
              </div>
            </div>

            <div style={{ padding: '24px' }}>
              <p style={{ fontSize: '16px', color: '#F0F2F8', marginBottom: '8px', lineHeight: '1.6' }}>
                Are you sure you want to <strong style={{ color: '#fff' }}>{pendingAction}</strong> the user{' '}
                <strong style={{ color: '#fff' }}>{pendingUsername}</strong>?
              </p>
              
              {pendingAction === 'unban' && (
                <p style={{ fontSize: '14px', color: '#7B82A0', margin: '12px 0 0 0', lineHeight: '1.5' }}>
                  This will restore their trust score to 35 and allow them to access the app again.
                </p>
              )}
              {pendingAction === 'unsuspend' && (
                <p style={{ fontSize: '14px', color: '#7B82A0', margin: '12px 0 0 0', lineHeight: '1.5' }}>
                  This will restore their trust score to 45 and allow them to participate in challenges again.
                </p>
              )}
              {pendingAction === 'unrestrict' && (
                <p style={{ fontSize: '14px', color: '#7B82A0', margin: '12px 0 0 0', lineHeight: '1.5' }}>
                  This will restore their trust score to 65 and remove step reduction penalties.
                </p>
              )}

              <div style={{ 
                display: 'flex',
                gap: '12px',
                marginTop: '24px'
              }}>
                <button
                  onClick={cancelConfirmModal}
                  disabled={actionInProgress}
                  style={{
                    flex: '1',
                    padding: '12px 16px',
                    background: '#0C1117',
                    color: '#F0F2F8',
                    border: '1px solid #21263A',
                    borderRadius: '8px',
                    fontSize: '14px',
                    fontWeight: 700,
                    cursor: actionInProgress ? 'not-allowed' : 'pointer',
                    opacity: actionInProgress ? 0.5 : 1,
                    transition: 'all 0.2s'
                  }}
                  onMouseEnter={(e) => !actionInProgress && (e.currentTarget.style.background = '#13161F')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = '#0C1117')}
                >
                  Cancel
                </button>
                <button
                  onClick={confirmAndExecute}
                  disabled={actionInProgress}
                  style={{
                    flex: '1',
                    padding: '12px 16px',
                    background: 'linear-gradient(135deg, #7C6FF7, #4F9CF9)',
                    color: '#fff',
                    border: 'none',
                    borderRadius: '8px',
                    fontSize: '14px',
                    fontWeight: 700,
                    cursor: actionInProgress ? 'not-allowed' : 'pointer',
                    opacity: actionInProgress ? 0.5 : 1,
                    transition: 'all 0.2s'
                  }}
                  onMouseEnter={(e) => !actionInProgress && (e.currentTarget.style.transform = 'translateY(-1px)')}
                  onMouseLeave={(e) => (e.currentTarget.style.transform = 'translateY(0)')}
                >
                  {actionInProgress ? 'Processing...' : `Confirm ${pendingAction}`}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
