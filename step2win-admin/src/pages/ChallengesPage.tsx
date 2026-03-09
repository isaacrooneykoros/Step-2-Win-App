import { useEffect, useState } from 'react';
import { adminApi } from '../services/adminApi';
import type { AdminChallenge } from '../types/admin';
import { Edit2, Trash2, CheckCircle2, XCircle, Search, Calendar, Users, DollarSign } from 'lucide-react';
import { formatKES } from '../utils/currency';

export function ChallengesPage() {
  const [items, setItems] = useState<AdminChallenge[]>([]);
  const [filteredChallenges, setFilteredChallenges] = useState<AdminChallenge[]>([]);
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [filterStatus, setFilterStatus] = useState<'all' | 'pending' | 'active' | 'completed' | 'cancelled'>('all');
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  
  // Modals state
  const [editingChallenge, setEditingChallenge] = useState<AdminChallenge | null>(null);
  const [deletingChallenge, setDeletingChallenge] = useState<AdminChallenge | null>(null);
  
  // Form state
  const [editForm, setEditForm] = useState({
    name: '',
    milestone: 0,
    max_participants: 0,
    end_date: '',
  });

  const load = () => {
    adminApi.getChallenges().then((data) => {
      setItems(data);
      setFilteredChallenges(data);
    }).catch((err: Error) => setError(err.message));
  };

  useEffect(() => {
    load();
  }, []);

  // Apply filters
  useEffect(() => {
    let filtered = items;

    // Search filter
    if (searchTerm) {
      filtered = filtered.filter(
        (c) =>
          c.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
          c.created_by_username.toLowerCase().includes(searchTerm.toLowerCase())
      );
    }

    // Status filter
    if (filterStatus !== 'all') {
      filtered = filtered.filter((c) => c.status === filterStatus);
    }

    setFilteredChallenges(filtered);
  }, [searchTerm, filterStatus, items]);

  const showSuccess = (msg: string) => {
    setSuccessMsg(msg);
    setTimeout(() => setSuccessMsg(''), 3000);
  };

  const approve = async (id: number) => {
    try {
      await adminApi.approveChallenge(id);
      showSuccess('Challenge approved');
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const cancel = async (id: number) => {
    try {
      await adminApi.cancelChallenge(id);
      showSuccess('Challenge cancelled');
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const openEditModal = (challenge: AdminChallenge) => {
    setEditingChallenge(challenge);
    setEditForm({
      name: challenge.name,
      milestone: challenge.milestone,
      max_participants: challenge.max_participants,
      end_date: challenge.end_date.split('T')[0], // Extract date part
    });
  };

  const handleEdit = async () => {
    if (!editingChallenge) return;
    
    try {
      await adminApi.updateChallenge(editingChallenge.id, editForm);
      showSuccess(`Challenge ${editForm.name} updated successfully`);
      setEditingChallenge(null);
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleDelete = async () => {
    if (!deletingChallenge) return;

    try {
      await adminApi.deleteChallenge(deletingChallenge.id);
      showSuccess(`Challenge ${deletingChallenge.name} has been deleted`);
      setDeletingChallenge(null);
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const toggleSelection = (id: number) => {
    setSelectedIds(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    );
  };

  const toggleSelectAll = () => {
    if (selectedIds.length === filteredChallenges.length) {
      setSelectedIds([]);
    } else {
      setSelectedIds(filteredChallenges.map(c => c.id));
    }
  };

  const handleBulkCancel = async () => {
    if (selectedIds.length === 0) return;
    
    try {
      await adminApi.bulkCancelChallenges(selectedIds);
      showSuccess(`${selectedIds.length} challenge(s) cancelled`);
      setSelectedIds([]);
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleBulkDelete = async () => {
    if (selectedIds.length === 0) return;
    
    if (!confirm(`Delete ${selectedIds.length} challenge(s)? This cannot be undone.`)) {
      return;
    }
    
    try {
      await adminApi.bulkDeleteChallenges(selectedIds);
      showSuccess(`${selectedIds.length} challenge(s) deleted`);
      setSelectedIds([]);
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'pending': return { bg: '#7c2d12', color: '#fdba74' };
      case 'active': return { bg: '#065f46', color: '#6ee7b7' };
      case 'completed': return { bg: '#1e40af', color: '#93c5fd' };
      case 'cancelled': return { bg: '#7f1d1d', color: '#fca5a5' };
      default: return { bg: '#2d3748', color: '#94a3b8' };
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '16px' }}>
        <h1 style={{ fontSize: '24px', fontWeight: 600, color: '#fff' }}>Challenge Management</h1>
        <div style={{ color: '#64748b' }}>{filteredChallenges.length} challenges</div>
      </div>

      {/* Messages */}
      {error && <div className="error" style={{ padding: '12px', background: '#7f1d1d', borderRadius: '6px', color: '#fca5a5' }}>{error}</div>}
      {successMsg && <div className="success" style={{ padding: '12px', background: '#065f46', borderRadius: '6px', color: '#6ee7b7' }}>{successMsg}</div>}

      {/* Filters and Bulk Actions */}
      <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', alignItems: 'center', flex: 1 }}>
          {/* Search */}
          <div style={{ position: 'relative', flex: '1', minWidth: '250px' }}>
            <Search size={18} style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: '#64748b' }} />
            <input
              type="text"
              placeholder="Search by name or creator..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              style={{
                width: '100%',
                padding: '10px 12px 10px 40px',
                background: '#1a2332',
                border: '1px solid #2d3748',
                borderRadius: '6px',
                color: '#fff',
              }}
            />
          </div>

          {/* Status Filter */}
          <select
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value as typeof filterStatus)}
            style={{
              padding: '10px 12px',
              background: '#1a2332',
              border: '1px solid #2d3748',
              borderRadius: '6px',
              color: '#fff',
              cursor: 'pointer',
            }}
          >
            <option value="all">All Status</option>
            <option value="pending">Pending</option>
            <option value="active">Active</option>
            <option value="completed">Completed</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </div>

        {/* Bulk Actions */}
        {selectedIds.length > 0 && (
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              onClick={handleBulkCancel}
              style={{
                padding: '10px 16px',
                background: '#7c2d12',
                color: '#fff',
                border: 'none',
                borderRadius: '6px',
                cursor: 'pointer',
                fontWeight: 600,
              }}
            >
              Cancel Selected ({selectedIds.length})
            </button>
            <button
              onClick={handleBulkDelete}
              style={{
                padding: '10px 16px',
                background: '#7f1d1d',
                color: '#fff',
                border: 'none',
                borderRadius: '6px',
                cursor: 'pointer',
                fontWeight: 600,
              }}
            >
              Delete Selected ({selectedIds.length})
            </button>
          </div>
        )}
      </div>

      {/* Challenges Table */}
      <div className="stat-card" style={{ padding: 0, overflow: 'auto' }}>
        <table className="table" style={{ width: '100%' }}>
          <thead>
            <tr style={{ background: '#1a2332' }}>
              <th style={{ width: '40px' }}>
                <input
                  type="checkbox"
                  checked={selectedIds.length === filteredChallenges.length && filteredChallenges.length > 0}
                  onChange={toggleSelectAll}
                  style={{ cursor: 'pointer' }}
                />
              </th>
              <th>Name</th>
              <th>Status</th>
              <th>Creator</th>
              <th>Participants</th>
              <th>Pool</th>
              <th>Fee</th>
              <th>Milestone</th>
              <th>End Date</th>
              <th style={{ textAlign: 'center' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filteredChallenges.map((challenge) => (
              <tr key={challenge.id} style={{ borderBottom: '1px solid #2d3748' }}>
                <td>
                  <input
                    type="checkbox"
                    checked={selectedIds.includes(challenge.id)}
                    onChange={() => toggleSelection(challenge.id)}
                    style={{ cursor: 'pointer' }}
                  />
                </td>
                <td style={{ fontWeight: 600, color: '#fff' }}>{challenge.name}</td>
                <td>
                  <span
                    style={{
                      padding: '4px 8px',
                      borderRadius: '4px',
                      fontSize: '12px',
                      fontWeight: 600,
                      background: getStatusColor(challenge.status).bg,
                      color: getStatusColor(challenge.status).color,
                    }}
                  >
                    {challenge.status}
                  </span>
                </td>
                <td style={{ color: '#64748b' }}>{challenge.created_by_username}</td>
                <td>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <Users size={14} color="#64748b" />
                    <span>{challenge.current_entries}/{challenge.max_participants}</span>
                  </div>
                </td>
                <td>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <DollarSign size={14} color="#22c55e" />
                    <span>{formatKES(challenge.total_pool)}</span>
                  </div>
                </td>
                <td>{formatKES(challenge.entry_fee)}</td>
                <td>{challenge.milestone.toLocaleString()} steps</td>
                <td>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px', color: '#64748b' }}>
                    <Calendar size={14} />
                    <span>{new Date(challenge.end_date).toLocaleDateString()}</span>
                  </div>
                </td>
                <td>
                  <div style={{ display: 'flex', gap: '8px', justifyContent: 'center' }}>
                    {challenge.status === 'pending' && (
                      <button
                        onClick={() => approve(challenge.id)}
                        style={{
                          padding: '6px 10px',
                          background: '#065f46',
                          color: '#fff',
                          border: 'none',
                          borderRadius: '4px',
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '4px',
                        }}
                        title="Approve Challenge"
                      >
                        <CheckCircle2 size={14} />
                      </button>
                    )}
                    <button
                      onClick={() => openEditModal(challenge)}
                      style={{
                        padding: '6px 10px',
                        background: '#0e7490',
                        color: '#fff',
                        border: 'none',
                        borderRadius: '4px',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '4px',
                      }}
                      title="Edit Challenge"
                    >
                      <Edit2 size={14} />
                    </button>
                    {(challenge.status === 'pending' || challenge.status === 'active') && (
                      <button
                        onClick={() => cancel(challenge.id)}
                        style={{
                          padding: '6px 10px',
                          background: '#7c2d12',
                          color: '#fff',
                          border: 'none',
                          borderRadius: '4px',
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '4px',
                        }}
                        title="Cancel Challenge"
                      >
                        <XCircle size={14} />
                      </button>
                    )}
                    {(challenge.status === 'cancelled' || challenge.status === 'completed') && (
                      <button
                        onClick={() => setDeletingChallenge(challenge)}
                        style={{
                          padding: '6px 10px',
                          background: '#7f1d1d',
                          color: '#fff',
                          border: 'none',
                          borderRadius: '4px',
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '4px',
                        }}
                        title="Delete Challenge"
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Edit Challenge Modal */}
      {editingChallenge && (
        <div style={{
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
        }}>
          <div className="auth-card" style={{ width: '500px', maxWidth: '90%' }}>
            <h2 style={{ fontSize: '20px', marginBottom: '20px', color: '#fff' }}>Edit Challenge</h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <div>
                <label style={{ display: 'block', marginBottom: '8px', color: '#64748b' }}>Challenge Name</label>
                <input
                  type="text"
                  value={editForm.name}
                  onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
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
                <label style={{ display: 'block', marginBottom: '8px', color: '#64748b' }}>Milestone (steps)</label>
                <input
                  type="number"
                  value={editForm.milestone}
                  onChange={(e) => setEditForm({ ...editForm, milestone: parseInt(e.target.value) || 0 })}
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
                <label style={{ display: 'block', marginBottom: '8px', color: '#64748b' }}>Max Participants</label>
                <input
                  type="number"
                  value={editForm.max_participants}
                  onChange={(e) => setEditForm({ ...editForm, max_participants: parseInt(e.target.value) || 0 })}
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
                <label style={{ display: 'block', marginBottom: '8px', color: '#64748b' }}>End Date</label>
                <input
                  type="date"
                  value={editForm.end_date}
                  onChange={(e) => setEditForm({ ...editForm, end_date: e.target.value })}
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
              <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
                <button onClick={() => setEditingChallenge(null)} style={{ padding: '10px 20px', background: '#2d3748', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer' }}>
                  Cancel
                </button>
                <button onClick={handleEdit} style={{ padding: '10px 20px', background: '#00f5e9', color: '#091120', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 600 }}>
                  Save Changes
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deletingChallenge && (
        <div style={{
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
        }}>
          <div className="auth-card" style={{ width: '500px', maxWidth: '90%' }}>
            <h2 style={{ fontSize: '20px', marginBottom: '20px', color: '#ef4444' }}>Delete Challenge</h2>
            <p style={{ color: '#64748b', marginBottom: '20px' }}>
              Are you sure you want to permanently delete challenge <strong style={{ color: '#fff' }}>{deletingChallenge.name}</strong>? This action cannot be undone.
            </p>
            <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
              <button onClick={() => setDeletingChallenge(null)} style={{ padding: '10px 20px', background: '#2d3748', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer' }}>
                Cancel
              </button>
              <button onClick={handleDelete} style={{ padding: '10px 20px', background: '#7f1d1d', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 600 }}>
                Delete Challenge
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
