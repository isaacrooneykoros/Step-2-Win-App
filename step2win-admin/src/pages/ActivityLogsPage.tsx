import { useCallback, useEffect, useState } from 'react';
import { adminApi } from '../services/adminApi';
import { History, Search, Filter, Calendar, User, Activity } from 'lucide-react';

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

  const getActionColor = (action: string) => {
    const colors: Record<string, { bg: string; color: string }> = {
      create: { bg: '#065f46', color: '#6ee7b7' },
      update: { bg: '#0e7490', color: '#67e8f9' },
      delete: { bg: '#7f1d1d', color: '#fca5a5' },
      login: { bg: '#1e40af', color: '#93c5fd' },
      logout: { bg: '#4c1d95', color: '#c4b5fd' },
      ban: { bg: '#991b1b', color: '#fecaca' },
      unban: { bg: '#065f46', color: '#86efac' },
      approve: { bg: '#166534', color: '#86efac' },
      reject: { bg: '#991b1b', color: '#fca5a5' },
      cancel: { bg: '#7c2d12', color: '#fdba74' },
      promote: { bg: '#6b21a8', color: '#e9d5ff' },
      demote: { bg: '#7c2d12', color: '#fed7aa' },
      reset_password: { bg: '#7c2d12', color: '#fcd34d' },
      settings_change: { bg: '#0e7490', color: '#a5f3fc' },
    };
    return colors[action] || { bg: '#2d3748', color: '#94a3b8' };
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

  const currentPage = Math.floor(offset / limit) + 1;
  const totalPages = Math.ceil(total / limit);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h1 style={{ fontSize: '24px', fontWeight: 600, color: '#fff', marginBottom: '4px' }}>
            <History size={24} style={{ display: 'inline', marginRight: '8px', verticalAlign: 'middle' }} />
            Activity Logs
          </h1>
          <p style={{ color: '#64748b', fontSize: '14px' }}>
            {total} total activities • Page {currentPage} of {totalPages || 1}
          </p>
        </div>
      </div>

      {/* Error Message */}
      {error && (
        <div style={{ padding: '12px', background: '#7f1d1d', borderRadius: '6px', color: '#fca5a5' }}>
          {error}
        </div>
      )}

      {/* Filters */}
      <div className="stat-card">
        <h3 style={{ fontSize: '16px', fontWeight: 600, marginBottom: '16px', color: '#fff', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Filter size={18} />
          Filters
        </h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '16px' }}>
          {/* Search by Admin */}
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
                  background: '#1a2332',
                  border: '1px solid #2d3748',
                  borderRadius: '6px',
                  color: '#fff',
                }}
              />
            </div>
          </div>

          {/* Action Filter */}
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
                background: '#1a2332',
                border: '1px solid #2d3748',
                borderRadius: '6px',
                color: '#fff',
                cursor: 'pointer',
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

          {/* Resource Filter */}
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
                background: '#1a2332',
                border: '1px solid #2d3748',
                borderRadius: '6px',
                color: '#fff',
                cursor: 'pointer',
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
                  background: '#1a2332',
                  border: '1px solid #2d3748',
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
                  background: '#1a2332',
                  border: '1px solid #2d3748',
                  borderRadius: '6px',
                  color: '#fff',
                }}
              />
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '12px', marginTop: '16px' }}>
          <button
            onClick={handleSearch}
            style={{
              padding: '8px 16px',
              background: '#00f5e9',
              color: '#091120',
              border: 'none',
              borderRadius: '6px',
              cursor: 'pointer',
              fontWeight: 600,
            }}
          >
            Apply Filters
          </button>
          <button
            onClick={handleClearFilters}
            style={{
              padding: '8px 16px',
              background: '#2d3748',
              color: '#fff',
              border: 'none',
              borderRadius: '6px',
              cursor: 'pointer',
            }}
          >
            Clear All
          </button>
        </div>
      </div>

      {/* Activity Logs Table */}
      <div className="stat-card" style={{ padding: 0, overflow: 'auto' }}>
        {loading ? (
          <div style={{ padding: '40px', textAlign: 'center', color: '#64748b' }}>
            Loading logs...
          </div>
        ) : logs.length === 0 ? (
          <div style={{ padding: '40px', textAlign: 'center', color: '#64748b' }}>
            No activity logs found
          </div>
        ) : (
          <table className="table" style={{ width: '100%' }}>
            <thead>
              <tr style={{ background: '#1a2332' }}>
                <th>Timestamp</th>
                <th>Admin</th>
                <th>Action</th>
                <th>Resource</th>
                <th>Description</th>
                <th>IP Address</th>
                <th style={{ textAlign: 'center' }}>Details</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log) => (
                <tr key={log.id} style={{ borderBottom: '1px solid #2d3748' }}>
                  <td style={{ color: '#64748b', fontSize: '13px', whiteSpace: 'nowrap' }}>
                    {formatDate(log.created_at)}
                  </td>
                  <td style={{ fontWeight: 600, color: '#fff' }}>{log.admin_username}</td>
                  <td>
                    <span
                      style={{
                        padding: '4px 8px',
                        borderRadius: '4px',
                        fontSize: '12px',
                        fontWeight: 600,
                        background: getActionColor(log.action).bg,
                        color: getActionColor(log.action).color,
                        textTransform: 'capitalize',
                      }}
                    >
                      {log.action.replace('_', ' ')}
                    </span>
                  </td>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#94a3b8' }}>
                      {getResourceIcon(log.resource_type)}
                      <span style={{ textTransform: 'capitalize' }}>{log.resource_type}</span>
                      {log.resource_id && <span style={{ color: '#64748b' }}>#{log.resource_id}</span>}
                    </div>
                  </td>
                  <td style={{ color: '#94a3b8', maxWidth: '300px' }}>
                    {log.description}
                    {log.resource_name && (
                      <span style={{ color: '#64748b', fontStyle: 'italic' }}> ({log.resource_name})</span>
                    )}
                  </td>
                  <td style={{ color: '#64748b', fontSize: '13px' }}>
                    {log.ip_address || '-'}
                  </td>
                  <td style={{ textAlign: 'center' }}>
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
                        }}
                      >
                        View Changes
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
              background: offset === 0 ? '#2d3748' : '#0e7490',
              color: '#fff',
              border: 'none',
              borderRadius: '6px',
              cursor: offset === 0 ? 'not-allowed' : 'pointer',
              opacity: offset === 0 ? 0.5 : 1,
            }}
          >
            Previous
          </button>
          <span style={{ color: '#64748b' }}>
            Page {currentPage} of {totalPages}
          </span>
          <button
            onClick={() => setOffset(offset + limit)}
            disabled={offset + limit >= total}
            style={{
              padding: '8px 16px',
              background: offset + limit >= total ? '#2d3748' : '#0e7490',
              color: '#fff',
              border: 'none',
              borderRadius: '6px',
              cursor: offset + limit >= total ? 'not-allowed' : 'pointer',
              opacity: offset + limit >= total ? 0.5 : 1,
            }}
          >
            Next
          </button>
        </div>
      )}

      {/* Changes Details Modal */}
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
            className="auth-card"
            style={{ width: '600px', maxWidth: '90%', maxHeight: '80vh', overflow: 'auto' }}
            onClick={(e) => e.stopPropagation()}
          >
            <h2 style={{ fontSize: '20px', marginBottom: '20px', color: '#fff' }}>Activity Details</h2>
            <div style={{ marginBottom: '20px' }}>
              <p style={{ color: '#64748b', marginBottom: '4px' }}>Admin</p>
              <p style={{ color: '#fff', fontWeight: 600 }}>{selectedLog.admin_username}</p>
            </div>
            <div style={{ marginBottom: '20px' }}>
              <p style={{ color: '#64748b', marginBottom: '4px' }}>Action</p>
              <p style={{ color: '#fff' }}>{selectedLog.description}</p>
            </div>
            <div style={{ marginBottom: '20px' }}>
              <p style={{ color: '#64748b', marginBottom: '4px' }}>Timestamp</p>
              <p style={{ color: '#fff' }}>{formatDate(selectedLog.created_at)}</p>
            </div>
            {selectedLog.changes && (
              <div>
                <h3 style={{ fontSize: '16px', fontWeight: 600, marginBottom: '12px', color: '#fff' }}>
                  Changes Made
                </h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  {Object.entries(selectedLog.changes).map(([field, change]) => (
                    <div
                      key={field}
                      style={{
                        padding: '12px',
                        background: '#1a2332',
                        borderRadius: '6px',
                      }}
                    >
                      <p style={{ color: '#00f5e9', fontWeight: 600, marginBottom: '8px', textTransform: 'capitalize' }}>
                        {field.replace(/_/g, ' ')}
                      </p>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                        <div>
                          <p style={{ color: '#64748b', fontSize: '12px', marginBottom: '4px' }}>Old Value</p>
                          <p style={{ color: '#fca5a5', fontFamily: 'monospace', fontSize: '14px' }}>
                            {change.old || '(empty)'}
                          </p>
                        </div>
                        <div>
                          <p style={{ color: '#64748b', fontSize: '12px', marginBottom: '4px' }}>New Value</p>
                          <p style={{ color: '#6ee7b7', fontFamily: 'monospace', fontSize: '14px' }}>
                            {change.new || '(empty)'}
                          </p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div style={{ marginTop: '20px', display: 'flex', justifyContent: 'flex-end' }}>
              <button
                onClick={() => setSelectedLog(null)}
                style={{
                  padding: '10px 20px',
                  background: '#2d3748',
                  color: '#fff',
                  border: 'none',
                  borderRadius: '6px',
                  cursor: 'pointer',
                }}
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
