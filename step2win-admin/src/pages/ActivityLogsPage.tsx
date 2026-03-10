import { useCallback, useEffect, useState } from 'react';
import { adminApi } from '../services/adminApi';
import { History, Search, Filter, Calendar, User, Activity, AlertCircle, X } from 'lucide-react';
import { PageHeader } from '../components/PageHeader';
import { StatCard } from '../components/StatCard';
import { StatusBadge } from '../components/StatusBadge';

interface AuditLog {
  id: number;
  admin_username: string;
  action: string;
  resource_type: string;
  resource_id: number | null;
  resource_name: string;
  description: string;
  changes: Record<string, { old: string; new: string }> | null;
  ip_address: string | null;
  created_at: string;
}

interface AuditLogsParams {
  limit: number;
  offset: number;
  admin_username?: string;
  action?: string;
  resource_type?: string;
  from_date?: string;
  to_date?: string;
}

interface AuditLogsResponse {
  results: AuditLog[];
  total: number;
}

export function ActivityLogsPage() {
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  
  // Filters
  const [searchTerm, setSearchTerm] = useState('');
  const [actionFilter, setActionFilter] = useState('');
  const [resourceFilter, setResourceFilter] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [offset, setOffset] = useState(0);
  const [limit] = useState(50);
  
  // Selected log for viewing details
  const [selectedLog, setSelectedLog] = useState<AuditLog | null>(null);

  const loadLogs = useCallback(async () => {
    setLoading(true);
    try {
      const params: AuditLogsParams = { limit, offset };
      
      if (searchTerm) params.admin_username = searchTerm;
      if (actionFilter) params.action = actionFilter;
      if (resourceFilter) params.resource_type = resourceFilter;
      if (fromDate) params.from_date = fromDate;
      if (toDate) params.to_date = toDate;
      
      const data = (await adminApi.getAuditLogs(params)) as AuditLogsResponse;
      setLogs(data.results);
      setTotal(data.total);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [limit, offset, searchTerm, actionFilter, resourceFilter, fromDate, toDate]);

  useEffect(() => {
    void loadLogs();
  }, [loadLogs]);

  const handleSearch = () => {
    setOffset(0);
    loadLogs();
  };

  const handleClearFilters = () => {
    setSearchTerm('');
    setActionFilter('');
    setResourceFilter('');
    setFromDate('');
    setToDate('');
    setOffset(0);
  };

  const getResourceIcon = (resourceType: string) => {
    switch (resourceType) {
      case 'user': return <User size={14} />;
      case 'auth': return <User size={14} />;
      default: return <Activity size={14} />;
    }
  };

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  // Calculate stats for StatCards
  const currentPage = Math.floor(offset / limit) + 1;
  const totalPages = Math.ceil(total / limit);
  
  const uniqueAdmins = new Set(logs.map(log => log.admin_username)).size;
  const actionCounts = logs.reduce((acc, log) => {
    acc[log.action] = (acc[log.action] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  const mostCommonAction = Object.entries(actionCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'N/A';

  const getActionBadgeVariant = (action: string): 'active' | 'completed' | 'cancelled' | 'pending' | 'warning' | 'info' | 'banned' | 'failed' => {
    const variantMap: Record<string, 'active' | 'completed' | 'cancelled' | 'pending' | 'warning' | 'info' | 'banned' | 'failed'> = {
      create: 'completed',
      update: 'active',
      delete: 'cancelled',
      login: 'active',
      logout: 'info',
      ban: 'banned',
      unban: 'completed',
      approve: 'completed',
      reject: 'cancelled',
      cancel: 'cancelled',
      promote: 'active',
      demote: 'warning',
      reset_password: 'warning',
      settings_change: 'active',
    };
    return variantMap[action] || 'info';
  };

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <PageHeader
        title="Activity Logs"
        subtitle={`${total} total activities`}
      />

      {/* Error Message */}
      {error && (
        <div style={{ padding: '12px 16px', background: '#7f1d1d', borderRadius: '6px', color: '#fca5a5', display: 'flex', alignItems: 'center', gap: '12px' }}>
          <AlertCircle size={18} />
          {error}
        </div>
      )}

      {/* Stats Grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: '16px' }}>
        <StatCard
          title="Total Activities"
          value={total.toLocaleString()}
          icon={Activity}
          color="teal"
          trend={logs.length}
          trendLabel="on this page"
        />
        <StatCard
          title="Active Admins"
          value={uniqueAdmins.toString()}
          icon={User}
          color="blue"
          trend={uniqueAdmins}
          trendLabel="admins acting"
        />
        <StatCard
          title="Most Common Action"
          value={mostCommonAction.replace(/_/g, ' ')}
          icon={Filter}
          color="purple"
          trend={actionCounts[mostCommonAction] || 0}
          trendLabel="occurrences"
        />
        <StatCard
          title="Recent Timespan"
          value={logs.length > 0 ? logs.length + ' entries' : 'No data'}
          icon={Calendar}
          color="amber"
          trend={logs.length > 0 ? Math.round((logs.length / limit) * 10) : 0}
          trendLabel="% of page"
        />
      </div>

      {/* Filters Section */}
      <div style={{
        background: '#0C1117',
        border: '1px solid #21263A',
        borderRadius: '8px',
        padding: '20px',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
          <Filter size={18} style={{ color: '#00f5e9' }} />
          <h3 style={{ fontSize: '16px', fontWeight: 600, color: '#fff' }}>Filters</h3>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '16px', marginBottom: '16px' }}>
          {/* Admin Username */}
          <div>
            <label style={{ display: 'block', marginBottom: '8px', color: '#64748b', fontSize: '14px' }}>
              Admin Username
            </label>
            <div style={{ position: 'relative' }}>
              <Search size={16} style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: '#64748b' }} />
              <input
                type="text"
                placeholder="Search admin..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                onKeyPress={(e) => e.key === 'Enter' && handleSearch()}
                style={{
                  width: '100%',
                  padding: '8px 12px 8px 36px',
                  background: '#13161F',
                  border: '1px solid #21263A',
                  borderRadius: '6px',
                  color: '#fff',
                  fontSize: '14px',
                }}
              />
            </div>
          </div>

          {/* Action */}
          <div>
            <label style={{ display: 'block', marginBottom: '8px', color: '#64748b', fontSize: '14px' }}>
              Action
            </label>
            <select
              value={actionFilter}
              onChange={(e) => setActionFilter(e.target.value)}
              style={{
                width: '100%',
                padding: '8px 12px',
                background: '#13161F',
                border: '1px solid #21263A',
                borderRadius: '6px',
                color: '#fff',
                fontSize: '14px',
              }}
            >
              <option value="">All Actions</option>
              <option value="create">Create</option>
              <option value="update">Update</option>
              <option value="delete">Delete</option>
              <option value="login">Login</option>
              <option value="logout">Logout</option>
              <option value="ban">Ban</option>
              <option value="unban">Unban</option>
              <option value="approve">Approve</option>
              <option value="reject">Reject</option>
              <option value="cancel">Cancel</option>
              <option value="promote">Promote</option>
              <option value="demote">Demote</option>
              <option value="reset_password">Reset Password</option>
              <option value="settings_change">Settings Change</option>
            </select>
          </div>

          {/* Resource Type */}
          <div>
            <label style={{ display: 'block', marginBottom: '8px', color: '#64748b', fontSize: '14px' }}>
              Resource Type
            </label>
            <select
              value={resourceFilter}
              onChange={(e) => setResourceFilter(e.target.value)}
              style={{
                width: '100%',
                padding: '8px 12px',
                background: '#13161F',
                border: '1px solid #21263A',
                borderRadius: '6px',
                color: '#fff',
                fontSize: '14px',
              }}
            >
              <option value="">All Resources</option>
              <option value="user">User</option>
              <option value="challenge">Challenge</option>
              <option value="transaction">Transaction</option>
              <option value="withdrawal">Withdrawal</option>
              <option value="badge">Badge</option>
              <option value="settings">System Settings</option>
              <option value="auth">Authentication</option>
            </select>
          </div>

          {/* From Date */}
          <div>
            <label style={{ display: 'block', marginBottom: '8px', color: '#64748b', fontSize: '14px' }}>
              From Date
            </label>
            <div style={{ position: 'relative' }}>
              <Calendar size={16} style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: '#64748b' }} />
              <input
                type="date"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
                style={{
                  width: '100%',
                  padding: '8px 12px 8px 36px',
                  background: '#13161F',
                  border: '1px solid #21263A',
                  borderRadius: '6px',
                  color: '#fff',
                }}
              />
            </div>
          </div>

          {/* To Date */}
          <div>
            <label style={{ display: 'block', marginBottom: '8px', color: '#64748b', fontSize: '14px' }}>
              To Date
            </label>
            <div style={{ position: 'relative' }}>
              <Calendar size={16} style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: '#64748b' }} />
              <input
                type="date"
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
                style={{
                  width: '100%',
                  padding: '8px 12px 8px 36px',
                  background: '#13161F',
                  border: '1px solid #21263A',
                  borderRadius: '6px',
                  color: '#fff',
                }}
              />
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', gap: '12px' }}>
          <button
            onClick={handleSearch}
            style={{
              padding: '8px 16px',
              background: 'linear-gradient(135deg, #00f5e9 0%, #0e7490 100%)',
              color: '#091120',
              border: 'none',
              borderRadius: '6px',
              cursor: 'pointer',
              fontWeight: 600,
              fontSize: '14px',
            }}
          >
            Apply Filters
          </button>
          <button
            onClick={handleClearFilters}
            style={{
              padding: '8px 16px',
              background: '#21263A',
              color: '#fff',
              border: '1px solid #2d3748',
              borderRadius: '6px',
              cursor: 'pointer',
              fontSize: '14px',
            }}
          >
            Clear All
          </button>
        </div>
      </div>

      {/* Activity Logs Table */}
      <div style={{
        background: '#0C1117',
        border: '1px solid #21263A',
        borderRadius: '8px',
        overflow: 'hidden',
      }}>
        {loading ? (
          <div style={{ padding: '40px', textAlign: 'center', color: '#64748b' }}>
            Loading logs...
          </div>
        ) : logs.length === 0 ? (
          <div style={{ padding: '40px', textAlign: 'center', color: '#64748b' }}>
            No activity logs found
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: '#13161F', borderBottom: '1px solid #21263A' }}>
                <th style={{ padding: '12px 16px', textAlign: 'left', color: '#64748b', fontWeight: 600, fontSize: '12px' }}>Timestamp</th>
                <th style={{ padding: '12px 16px', textAlign: 'left', color: '#64748b', fontWeight: 600, fontSize: '12px' }}>Admin</th>
                <th style={{ padding: '12px 16px', textAlign: 'left', color: '#64748b', fontWeight: 600, fontSize: '12px' }}>Action</th>
                <th style={{ padding: '12px 16px', textAlign: 'left', color: '#64748b', fontWeight: 600, fontSize: '12px' }}>Resource</th>
                <th style={{ padding: '12px 16px', textAlign: 'left', color: '#64748b', fontWeight: 600, fontSize: '12px' }}>Description</th>
                <th style={{ padding: '12px 16px', textAlign: 'left', color: '#64748b', fontWeight: 600, fontSize: '12px' }}>IP Address</th>
                <th style={{ padding: '12px 16px', textAlign: 'center', color: '#64748b', fontWeight: 600, fontSize: '12px' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log) => (
                <tr key={log.id} style={{ borderBottom: '1px solid #21263A', transition: 'background 0.2s' }} onMouseEnter={(e) => e.currentTarget.style.background = '#13161F'} onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}>
                  <td style={{ padding: '12px 16px', color: '#94a3b8', fontSize: '13px', whiteSpace: 'nowrap' }}>
                    {formatDate(log.created_at)}
                  </td>
                  <td style={{ padding: '12px 16px', color: '#fff', fontWeight: 500, fontSize: '13px' }}>
                    {log.admin_username}
                  </td>
                  <td style={{ padding: '12px 16px' }}>
                    <StatusBadge 
                      variant={getActionBadgeVariant(log.action)}
                      label={log.action.replace(/_/g, ' ')}
                    />
                  </td>
                  <td style={{ padding: '12px 16px', color: '#94a3b8', fontSize: '13px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      {getResourceIcon(log.resource_type)}
                      <span style={{ textTransform: 'capitalize' }}>{log.resource_type}</span>
                      {log.resource_id && <span style={{ color: '#64748b' }}>#{log.resource_id}</span>}
                    </div>
                  </td>
                  <td style={{ padding: '12px 16px', color: '#94a3b8', fontSize: '13px', maxWidth: '300px' }}>
                    {log.description}
                    {log.resource_name && (
                      <span style={{ color: '#64748b', fontStyle: 'italic' }}> ({log.resource_name})</span>
                    )}
                  </td>
                  <td style={{ padding: '12px 16px', color: '#64748b', fontSize: '12px', fontFamily: 'monospace' }}>
                    {log.ip_address || '-'}
                  </td>
                  <td style={{ padding: '12px 16px', textAlign: 'center' }}>
                    {log.changes && (
                      <button
                        onClick={() => setSelectedLog(log)}
                        style={{
                          padding: '4px 12px',
                          background: '#0e7490',
                          color: '#fff',
                          border: 'none',
                          borderRadius: '4px',
                          cursor: 'pointer',
                          fontSize: '12px',
                          fontWeight: 500,
                          transition: 'background 0.2s',
                        }}
                        onMouseEnter={(e) => e.currentTarget.style.background = '#0891b2'}
                        onMouseLeave={(e) => e.currentTarget.style.background = '#0e7490'}
                      >
                        Details
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '12px' }}>
          <button
            onClick={() => setOffset(Math.max(0, offset - limit))}
            disabled={offset === 0}
            style={{
              padding: '8px 16px',
              background: offset === 0 ? '#2d3748' : 'linear-gradient(135deg, #00f5e9 0%, #0e7490 100%)',
              color: '#fff',
              border: 'none',
              borderRadius: '6px',
              cursor: offset === 0 ? 'not-allowed' : 'pointer',
              opacity: offset === 0 ? 0.5 : 1,
              fontSize: '14px',
              fontWeight: 500,
            }}
          >
            Previous
          </button>
          <span style={{ color: '#64748b', fontSize: '14px', fontWeight: 500 }}>
            Page {currentPage} of {totalPages}
          </span>
          <button
            onClick={() => setOffset(offset + limit)}
            disabled={offset + limit >= total}
            style={{
              padding: '8px 16px',
              background: offset + limit >= total ? '#2d3748' : 'linear-gradient(135deg, #00f5e9 0%, #0e7490 100%)',
              color: '#fff',
              border: 'none',
              borderRadius: '6px',
              cursor: offset + limit >= total ? 'not-allowed' : 'pointer',
              opacity: offset + limit >= total ? 0.5 : 1,
              fontSize: '14px',
              fontWeight: 500,
            }}
          >
            Next
          </button>
        </div>
      )}

      {/* Activity Details Modal */}
      {selectedLog && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(0, 0, 0, 0.8)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
          }}
          onClick={() => setSelectedLog(null)}
        >
          <div
            style={{
              background: '#0C1117',
              border: '1px solid #21263A',
              borderRadius: '8px',
              width: '600px',
              maxWidth: '90%',
              maxHeight: '80vh',
              overflow: 'auto',
              boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.5)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div style={{
              background: 'linear-gradient(135deg, #00f5e9 0%, #0e7490 100%)',
              padding: '20px',
              borderBottom: '1px solid #21263A',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <History size={20} style={{ color: '#091120' }} />
                <h2 style={{ fontSize: '18px', fontWeight: 600, color: '#091120' }}>Activity Details</h2>
              </div>
              <button
                onClick={() => setSelectedLog(null)}
                style={{
                  background: 'rgba(0, 0, 0, 0.2)',
                  border: 'none',
                  color: '#091120',
                  cursor: 'pointer',
                  padding: '4px',
                  borderRadius: '4px',
                }}
              >
                <X size={20} />
              </button>
            </div>

            {/* Modal Content */}
            <div style={{ padding: '24px', color: '#fff' }}>
              <div style={{ marginBottom: '24px' }}>
                <p style={{ color: '#64748b', marginBottom: '8px', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Admin</p>
                <p style={{ color: '#fff', fontWeight: 600, fontSize: '16px' }}>{selectedLog.admin_username}</p>
              </div>

              <div style={{ marginBottom: '24px' }}>
                <p style={{ color: '#64748b', marginBottom: '8px', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Action</p>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <StatusBadge 
                    variant={getActionBadgeVariant(selectedLog.action)}
                    label={selectedLog.action.replace(/_/g, ' ')}
                  />
                </div>
              </div>

              <div style={{ marginBottom: '24px' }}>
                <p style={{ color: '#64748b', marginBottom: '8px', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Description</p>
                <p style={{ color: '#94a3b8', fontSize: '14px' }}>{selectedLog.description}</p>
              </div>

              <div style={{ marginBottom: '24px' }}>
                <p style={{ color: '#64748b', marginBottom: '8px', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Timestamp</p>
                <p style={{ color: '#fff', fontFamily: 'monospace', fontSize: '13px' }}>{formatDate(selectedLog.created_at)}</p>
              </div>

              <div style={{ marginBottom: '24px' }}>
                <p style={{ color: '#64748b', marginBottom: '8px', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>IP Address</p>
                <p style={{ color: '#fff', fontFamily: 'monospace', fontSize: '13px' }}>{selectedLog.ip_address || '-'}</p>
              </div>

              {selectedLog.resource_name && (
                <div style={{ marginBottom: '24px' }}>
                  <p style={{ color: '#64748b', marginBottom: '8px', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Resource</p>
                  <p style={{ color: '#fff', fontWeight: 500, fontSize: '14px' }}>{selectedLog.resource_name}</p>
                </div>
              )}

              {selectedLog.changes && (
                <div style={{ marginTop: '24px' }}>
                  <p style={{ color: '#64748b', marginBottom: '16px', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '0.5px', fontWeight: 600 }}>Changes</p>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                    {Object.entries(selectedLog.changes).map(([field, change]) => (
                      <div
                        key={field}
                        style={{
                          padding: '16px',
                          background: '#13161F',
                          borderRadius: '6px',
                          border: '1px solid #21263A',
                        }}
                      >
                        <p style={{ color: '#00f5e9', fontWeight: 600, marginBottom: '12px', textTransform: 'capitalize' }}>
                          {field.replace(/_/g, ' ')}
                        </p>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
                          <div>
                            <p style={{ color: '#64748b', fontSize: '12px', marginBottom: '8px' }}>Old Value</p>
                            <p style={{ color: '#fca5a5', fontFamily: 'monospace', fontSize: '13px', wordBreak: 'break-all' }}>
                              {change.old || '(empty)'}
                            </p>
                          </div>
                          <div>
                            <p style={{ color: '#64748b', fontSize: '12px', marginBottom: '8px' }}>New Value</p>
                            <p style={{ color: '#6ee7b7', fontFamily: 'monospace', fontSize: '13px', wordBreak: 'break-all' }}>
                              {change.new || '(empty)'}
                            </p>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Modal Footer */}
            <div style={{
              padding: '16px 24px',
              borderTop: '1px solid #21263A',
              display: 'flex',
              justifyContent: 'flex-end',
              gap: '12px',
            }}>
              <button
                onClick={() => setSelectedLog(null)}
                style={{
                  padding: '10px 20px',
                  background: '#21263A',
                  color: '#fff',
                  border: '1px solid #2d3748',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  fontWeight: 500,
                  transition: 'background 0.2s',
                }}
                onMouseEnter={(e) => e.currentTarget.style.background = '#2d3748'}
                onMouseLeave={(e) => e.currentTarget.style.background = '#21263A'}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
