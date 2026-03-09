import { useState, useEffect } from 'react';
import { adminApi } from '../services/adminApi';
import { AlertTriangle, SearchX, Check, X, Shield, Lock, Ban, Pause, Eye, Search } from 'lucide-react';
import type { FraudOverview, FraudFlag } from '../types/admin';

export function AdminFraudPage() {
  const [overview, setOverview] = useState<FraudOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedFlag, setSelectedFlag] = useState<FraudFlag | null>(null);
  const [actionInProgress, setActionInProgress] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [filterSeverity, setFilterSeverity] = useState<'all' | 'critical' | 'high' | 'medium' | 'low'>('all');

  useEffect(() => {
    loadFraudData();
    const interval = setInterval(loadFraudData, 30000);
    return () => clearInterval(interval);
  }, []);

  const loadFraudData = async () => {
    try {
      const data = await adminApi.getFraudOverview();
      setOverview(data);
    } catch (error) {
      console.error('Failed to fetch fraud data', error);
    } finally {
      setLoading(false);
    }
  };

  const handleAction = async (
    flagId: number,
    action: 'dismiss' | 'warn' | 'restrict' | 'suspend' | 'ban'
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

  // Filter flags based on search and severity
  const filteredFlags = overview?.recent_flags.filter((flag) => {
    const matchesSearch = !searchTerm || 
      flag.user_username.toLowerCase().includes(searchTerm.toLowerCase()) ||
      flag.flag_type.toLowerCase().includes(searchTerm.toLowerCase());
    
    const matchesSeverity = filterSeverity === 'all' || flag.severity === filterSeverity;
    
    return matchesSearch && matchesSeverity;
  }) || [];

  if (loading)
    return <div className="text-center py-8 text-gray-500">Loading fraud data...</div>;

  if (!overview)
    return <div className="text-center py-8 text-red-500">Failed to load fraud data</div>;

  return (
    <div className="space-y-6">
      {/* Header Section */}
      <div style={{ 
        background: 'linear-gradient(135deg, #1e293b 0%, #0f172a 100%)',
        padding: '24px',
        borderRadius: '12px',
        border: '1px solid #334155'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '8px' }}>
          <Shield size={32} style={{ color: '#00f5e9' }} />
          <h2 style={{ fontSize: '28px', fontWeight: 700, color: '#fff', margin: 0 }}>
            Anti-Cheat Monitor
          </h2>
        </div>
        <p style={{ color: '#94a3b8', margin: 0, fontSize: '15px' }}>
          Real-time fraud detection and case management system • Last updated: {new Date().toLocaleTimeString()}
        </p>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <div style={{ 
          background: 'linear-gradient(135deg, #ffffff 0%, #f8fafc 100%)',
          padding: '20px',
          borderRadius: '12px',
          border: '1px solid #e2e8f0',
          boxShadow: '0 1px 3px rgba(0,0,0,0.1)'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '8px' }}>
            <Eye size={20} style={{ color: '#64748b' }} />
            <p style={{ color: '#64748b', fontSize: '14px', fontWeight: 600, margin: 0 }}>Open Cases</p>
          </div>
          <p style={{ fontSize: '32px', fontWeight: 700, color: '#0f172a', margin: 0 }}>{overview.open_flags}</p>
        </div>

        <div style={{ 
          background: 'linear-gradient(135deg, #fef2f2 0%, #fee2e2 100%)',
          padding: '20px',
          borderRadius: '12px',
          border: '1px solid #fecaca',
          boxShadow: '0 1px 3px rgba(239,68,68,0.1)'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '8px' }}>
            <AlertTriangle size={20} style={{ color: '#dc2626' }} />
            <p style={{ color: '#991b1b', fontSize: '14px', fontWeight: 600, margin: 0 }}>Critical</p>
          </div>
          <p style={{ fontSize: '32px', fontWeight: 700, color: '#7f1d1d', margin: 0 }}>{overview.critical_unread}</p>
        </div>

        <div style={{ 
          background: 'linear-gradient(135deg, #fff7ed 0%, #fed7aa 100%)',
          padding: '20px',
          borderRadius: '12px',
          border: '1px solid #fdba74',
          boxShadow: '0 1px 3px rgba(249,115,22,0.1)'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '8px' }}>
            <AlertTriangle size={20} style={{ color: '#ea580c' }} />
            <p style={{ color: '#9a3412', fontSize: '14px', fontWeight: 600, margin: 0 }}>High Priority</p>
          </div>
          <p style={{ fontSize: '32px', fontWeight: 700, color: '#7c2d12', margin: 0 }}>{overview.high_unread}</p>
        </div>

        <div style={{ 
          background: 'linear-gradient(135deg, #eff6ff 0%, #dbeafe 100%)',
          padding: '20px',
          borderRadius: '12px',
          border: '1px solid #bfdbfe',
          boxShadow: '0 1px 3px rgba(59,130,246,0.1)'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '8px' }}>
            <Lock size={20} style={{ color: '#2563eb' }} />
            <p style={{ color: '#1e40af', fontSize: '14px', fontWeight: 600, margin: 0 }}>Restricted</p>
          </div>
          <p style={{ fontSize: '32px', fontWeight: 700, color: '#1e3a8a', margin: 0 }}>{overview.restricted_users}</p>
        </div>

        <div style={{ 
          background: 'linear-gradient(135deg, #faf5ff 0%, #e9d5ff 100%)',
          padding: '20px',
          borderRadius: '12px',
          border: '1px solid #d8b4fe',
          boxShadow: '0 1px 3px rgba(168,85,247,0.1)'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '8px' }}>
            <Pause size={20} style={{ color: '#9333ea' }} />
            <p style={{ color: '#6b21a8', fontSize: '14px', fontWeight: 600, margin: 0 }}>Suspended</p>
          </div>
          <p style={{ fontSize: '32px', fontWeight: 700, color: '#581c87', margin: 0 }}>{overview.suspended_users}</p>
        </div>

        <div style={{ 
          background: 'linear-gradient(135deg, #1e293b 0%, #0f172a 100%)',
          padding: '20px',
          borderRadius: '12px',
          border: '1px solid #334155',
          boxShadow: '0 1px 3px rgba(0,0,0,0.3)'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '8px' }}>
            <Ban size={20} style={{ color: '#ef4444' }} />
            <p style={{ color: '#94a3b8', fontSize: '14px', fontWeight: 600, margin: 0 }}>Banned</p>
          </div>
          <p style={{ fontSize: '32px', fontWeight: 700, color: '#ffffff', margin: 0 }}>{overview.banned_users}</p>
        </div>
      </div>

      {/* Filters Section */}
      <div style={{ 
        background: '#ffffff',
        padding: '20px',
        borderRadius: '12px',
        border: '1px solid #e2e8f0',
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
            color: '#64748b' 
          }} />
          <input
            type="text"
            placeholder="Search by username or flag type..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            style={{
              width: '100%',
              padding: '10px 12px 10px 40px',
              background: '#f8fafc',
              border: '1px solid #cbd5e1',
              borderRadius: '8px',
              color: '#0f172a',
              fontSize: '14px'
            }}
          />
        </div>

        <select
          value={filterSeverity}
          onChange={(e) => setFilterSeverity(e.target.value as 'all' | 'critical' | 'high' | 'medium' | 'low')}
          style={{
            padding: '10px 16px',
            background: '#f8fafc',
            border: '1px solid #cbd5e1',
            borderRadius: '8px',
            color: '#0f172a',
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
          color: '#64748b',
          fontSize: '14px',
          fontWeight: 500
        }}>
          {filteredFlags.length} flag{filteredFlags.length !== 1 ? 's' : ''} found
        </div>
      </div>

      {/* Recent Flags Table */}
      <div style={{ 
        background: '#ffffff',
        borderRadius: '12px',
        border: '1px solid #e2e8f0',
        overflow: 'hidden'
      }}>
        <div style={{ 
          padding: '20px 24px',
          background: 'linear-gradient(135deg, #f8fafc 0%, #f1f5f9 100%)',
          borderBottom: '1px solid #e2e8f0'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <AlertTriangle size={20} style={{ color: '#0f172a' }} />
            <h2 style={{ fontSize: '18px', fontWeight: 700, color: '#0f172a', margin: 0 }}>
              Recent Flags Today
            </h2>
            <span style={{ 
              background: '#00f5e9',
              color: '#0f172a',
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
            <SearchX size={48} style={{ margin: '0 auto 12px', color: '#cbd5e1' }} />
            <p style={{ color: '#64748b', fontSize: '15px' }}>
              {searchTerm || filterSeverity !== 'all' ? 'No flags match your filters' : 'No unreviewed flags'}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead style={{ background: '#f8fafc', borderBottom: '2px solid #e2e8f0' }}>
                <tr>
                  <th style={{ padding: '16px 24px', textAlign: 'left', fontWeight: 700, color: '#475569', fontSize: '13px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>User</th>
                  <th style={{ padding: '16px 24px', textAlign: 'left', fontWeight: 700, color: '#475569', fontSize: '13px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Flag Type</th>
                  <th style={{ padding: '16px 24px', textAlign: 'left', fontWeight: 700, color: '#475569', fontSize: '13px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Severity</th>
                  <th style={{ padding: '16px 24px', textAlign: 'left', fontWeight: 700, color: '#475569', fontSize: '13px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Date</th>
                  <th style={{ padding: '16px 24px', textAlign: 'center', fontWeight: 700, color: '#475569', fontSize: '13px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {filteredFlags.map((flag, index) => (
                  <tr
                    key={flag.id}
                    style={{
                      borderBottom: index !== filteredFlags.length - 1 ? '1px solid #f1f5f9' : 'none',
                      cursor: 'pointer',
                      transition: 'background 0.2s'
                    }}
                    onClick={() => setSelectedFlag(flag)}
                    onMouseEnter={(e) => e.currentTarget.style.background = '#f8fafc'}
                    onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                  >
                    <td style={{ padding: '16px 24px', color: '#0f172a', fontWeight: 600, fontSize: '14px' }}>
                      {flag.user_username}
                    </td>
                    <td style={{ padding: '16px 24px', color: '#475569', fontSize: '14px' }}>
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
                          ...(flag.severity === 'critical' && { background: '#fee2e2', color: '#991b1b' }),
                          ...(flag.severity === 'high' && { background: '#fed7aa', color: '#9a3412' }),
                          ...(flag.severity === 'medium' && { background: '#fef3c7', color: '#92400e' }),
                          ...(flag.severity === 'low' && { background: '#dbeafe', color: '#1e40af' }),
                        }}
                      >
                        {flag.severity}
                      </span>
                    </td>
                    <td style={{ padding: '16px 24px', color: '#64748b', fontSize: '14px' }}>
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
                          background: 'linear-gradient(135deg, #00f5e9 0%, #00d4c7 100%)',
                          color: '#0f172a',
                          border: 'none',
                          borderRadius: '6px',
                          fontSize: '13px',
                          fontWeight: 700,
                          cursor: 'pointer',
                          transition: 'transform 0.2s, box-shadow 0.2s'
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.transform = 'translateY(-1px)';
                          e.currentTarget.style.boxShadow = '0 4px 12px rgba(0,245,233,0.3)';
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
            background: '#ffffff',
            borderRadius: '16px',
            boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)',
            maxWidth: '700px',
            width: '100%',
            maxHeight: '90vh',
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column'
          }}>
            <div style={{ 
              padding: '24px',
              background: 'linear-gradient(135deg, #1e293b 0%, #0f172a 100%)',
              borderBottom: '1px solid #334155',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <Shield size={24} style={{ color: '#00f5e9' }} />
                <h3 style={{ fontSize: '20px', fontWeight: 700, color: '#ffffff', margin: 0 }}>
                  Flag Details
                </h3>
              </div>
              <button
                onClick={() => setSelectedFlag(null)}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: '#94a3b8',
                  cursor: 'pointer',
                  padding: '8px',
                  borderRadius: '6px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  transition: 'background 0.2s'
                }}
                onMouseEnter={(e) => e.currentTarget.style.background = '#334155'}
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
                  <p style={{ fontSize: '12px', color: '#64748b', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '6px' }}>
                    User
                  </p>
                  <p style={{ fontSize: '16px', fontWeight: 700, color: '#0f172a', margin: 0 }}>
                    {selectedFlag.user_username}
                  </p>
                  <p style={{ fontSize: '14px', color: '#64748b', marginTop: '4px' }}>
                    {selectedFlag.user_email}
                  </p>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
                  <div>
                    <p style={{ fontSize: '12px', color: '#64748b', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '6px' }}>
                      Flag Type
                    </p>
                    <p style={{ fontSize: '15px', fontWeight: 600, color: '#0f172a', margin: 0 }}>
                      {selectedFlag.flag_type}
                    </p>
                  </div>
                  <div>
                    <p style={{ fontSize: '12px', color: '#64748b', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '6px' }}>
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
                        ...(selectedFlag.severity === 'critical' && { background: '#fee2e2', color: '#991b1b' }),
                        ...(selectedFlag.severity === 'high' && { background: '#fed7aa', color: '#9a3412' }),
                        ...(selectedFlag.severity === 'medium' && { background: '#fef3c7', color: '#92400e' }),
                        ...(selectedFlag.severity === 'low' && { background: '#dbeafe', color: '#1e40af' }),
                      }}
                    >
                      {selectedFlag.severity}
                    </span>
                  </div>
                </div>

                <div>
                  <p style={{ fontSize: '12px', color: '#64748b', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px' }}>
                    Details
                  </p>
                  <pre style={{ 
                    background: '#f8fafc',
                    padding: '16px',
                    borderRadius: '8px',
                    fontSize: '13px',
                    color: '#475569',
                    overflowX: 'auto',
                    border: '1px solid #e2e8f0',
                    margin: 0
                  }}>
                    {JSON.stringify(selectedFlag.details, null, 2)}
                  </pre>
                </div>

                <div style={{ 
                  background: 'linear-gradient(135deg, #eff6ff 0%, #dbeafe 100%)',
                  padding: '16px',
                  borderRadius: '8px',
                  border: '1px solid #bfdbfe'
                }}>
                  <p style={{ fontSize: '14px', color: '#1e40af', margin: 0 }}>
                    <strong style={{ fontWeight: 700 }}>Note:</strong> {selectedFlag.details.note || 'No additional details'}
                  </p>
                </div>

                <div style={{ 
                  display: 'flex',
                  gap: '8px',
                  flexWrap: 'wrap',
                  paddingTop: '8px',
                  borderTop: '2px solid #f1f5f9'
                }}>
                  <button
                    onClick={() => handleAction(selectedFlag.id, 'dismiss')}
                    disabled={actionInProgress}
                    style={{
                      flex: '1',
                      minWidth: '120px',
                      padding: '12px 16px',
                      background: '#f1f5f9',
                      color: '#0f172a',
                      border: 'none',
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
                    onMouseEnter={(e) => !actionInProgress && (e.currentTarget.style.background = '#e2e8f0')}
                    onMouseLeave={(e) => (e.currentTarget.style.background = '#f1f5f9')}
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
                      background: 'linear-gradient(135deg, #fef3c7 0%, #fde68a 100%)',
                      color: '#92400e',
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
                    Warn
                  </button>
                  <button
                    onClick={() => handleAction(selectedFlag.id, 'restrict')}
                    disabled={actionInProgress}
                    style={{
                      flex: '1',
                      minWidth: '120px',
                      padding: '12px 16px',
                      background: 'linear-gradient(135deg, #dbeafe 0%, #bfdbfe 100%)',
                      color: '#1e40af',
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
                    Restrict
                  </button>
                  <button
                    onClick={() => handleAction(selectedFlag.id, 'suspend')}
                    disabled={actionInProgress}
                    style={{
                      flex: '1',
                      minWidth: '120px',
                      padding: '12px 16px',
                      background: 'linear-gradient(135deg, #e9d5ff 0%, #d8b4fe 100%)',
                      color: '#6b21a8',
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
                    Suspend
                  </button>
                  <button
                    onClick={() => handleAction(selectedFlag.id, 'ban')}
                    disabled={actionInProgress}
                    style={{
                      flex: '1',
                      minWidth: '120px',
                      padding: '12px 16px',
                      background: 'linear-gradient(135deg, #fee2e2 0%, #fecaca 100%)',
                      color: '#991b1b',
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
                    Ban
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
