import { useEffect, useState } from 'react';
import { adminApi } from '../services/adminApi';
import type { AdminUser } from '../types/admin';
import { Edit2, Trash2, Shield, ShieldOff, Key, Search, Ban, CheckCircle2, UserCog } from 'lucide-react';
import { formatKES } from '../utils/currency';

export function UsersPage() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [filteredUsers, setFilteredUsers] = useState<AdminUser[]>([]);
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [filterStatus, setFilterStatus] = useState<'all' | 'active' | 'banned'>('all');
  const [filterRole, setFilterRole] = useState<'all' | 'admin' | 'user'>('all');
  
  // Modals state
  const [editingUser, setEditingUser] = useState<AdminUser | null>(null);
  const [resettingPassword, setResettingPassword] = useState<AdminUser | null>(null);
  const [deletingUser, setDeletingUser] = useState<AdminUser | null>(null);
  
  // Form states
  const [editForm, setEditForm] = useState({ username: '', email: '', phone_number: '' });
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  const load = () => {
    adminApi.getUsers().then((data) => {
      setUsers(data);
      setFilteredUsers(data);
    }).catch((err: Error) => setError(err.message));
  };

  useEffect(() => {
    load();
  }, []);

  // Apply filters
  useEffect(() => {
    let filtered = users;

    // Search filter
    if (searchTerm) {
      filtered = filtered.filter(
        (u) =>
          u.username.toLowerCase().includes(searchTerm.toLowerCase()) ||
          u.email.toLowerCase().includes(searchTerm.toLowerCase())
      );
    }

    // Status filter
    if (filterStatus === 'active') {
      filtered = filtered.filter((u) => u.is_active);
    } else if (filterStatus === 'banned') {
      filtered = filtered.filter((u) => !u.is_active);
    }

    // Role filter
    if (filterRole === 'admin') {
      filtered = filtered.filter((u) => u.is_staff);
    } else if (filterRole === 'user') {
      filtered = filtered.filter((u) => !u.is_staff);
    }

    setFilteredUsers(filtered);
  }, [searchTerm, filterStatus, filterRole, users]);

  const showSuccess = (msg: string) => {
    setSuccessMsg(msg);
    setTimeout(() => setSuccessMsg(''), 3000);
  };

  const toggleBan = async (user: AdminUser) => {
    try {
      if (user.is_active) {
        await adminApi.banUser(user.id);
        showSuccess(`${user.username} has been banned`);
      } else {
        await adminApi.unbanUser(user.id);
        showSuccess(`${user.username} has been unbanned`);
      }
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const toggleStaff = async (user: AdminUser) => {
    try {
      if (user.is_staff) {
        await adminApi.removeStaff(user.id);
        showSuccess(`${user.username} is no longer an admin`);
      } else {
        await adminApi.makeStaff(user.id);
        showSuccess(`${user.username} is now an admin`);
      }
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const openEditModal = (user: AdminUser) => {
    setEditingUser(user);
    setEditForm({
      username: user.username,
      email: user.email,
      phone_number: user.phone_number || '',
    });
  };

  const handleEdit = async () => {
    if (!editingUser) return;
    
    try {
      await adminApi.updateUser(editingUser.id, editForm);
      showSuccess(`User ${editForm.username} updated successfully`);
      setEditingUser(null);
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const openResetPasswordModal = (user: AdminUser) => {
    setResettingPassword(user);
    setNewPassword('');
    setConfirmPassword('');
  };

  const handleResetPassword = async () => {
    if (!resettingPassword) return;
    
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    if (newPassword.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }

    try {
      await adminApi.resetPassword(resettingPassword.id, newPassword);
      showSuccess(`Password reset for ${resettingPassword.username}`);
      setResettingPassword(null);
      setNewPassword('');
      setConfirmPassword('');
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleDelete = async () => {
    if (!deletingUser) return;

    try {
      await adminApi.deleteUser(deletingUser.id);
      showSuccess(`User ${deletingUser.username} has been deleted`);
      setDeletingUser(null);
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 style={{ fontSize: '24px', fontWeight: 600, color: '#fff' }}>User Management</h1>
        <div style={{ color: '#64748b' }}>{filteredUsers.length} users</div>
      </div>

      {/* Messages */}
      {error && <div className="error" style={{ padding: '12px', background: '#7f1d1d', borderRadius: '6px', color: '#fca5a5' }}>{error}</div>}
      {successMsg && <div className="success" style={{ padding: '12px', background: '#065f46', borderRadius: '6px', color: '#6ee7b7' }}>{successMsg}</div>}

      {/* Filters */}
      <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', alignItems: 'center' }}>
        {/* Search */}
        <div style={{ position: 'relative', flex: '1', minWidth: '250px' }}>
          <Search size={18} style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: '#64748b' }} />
          <input
            type="text"
            placeholder="Search by username or email..."
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
          onChange={(e) => setFilterStatus(e.target.value as 'all' | 'active' | 'banned')}
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
          <option value="active">Active Only</option>
          <option value="banned">Banned Only</option>
        </select>

        {/* Role Filter */}
        <select
          value={filterRole}
          onChange={(e) => setFilterRole(e.target.value as 'all' | 'admin' | 'user')}
          style={{
            padding: '10px 12px',
            background: '#1a2332',
            border: '1px solid #2d3748',
            borderRadius: '6px',
            color: '#fff',
            cursor: 'pointer',
          }}
        >
          <option value="all">All Roles</option>
          <option value="admin">Admins Only</option>
          <option value="user">Users Only</option>
        </select>
      </div>

      {/* Users Table */}
      <div className="stat-card" style={{ padding: 0, overflow: 'hidden' }}>
        <table className="table" style={{ width: '100%' }}>
          <thead>
            <tr style={{ background: '#1a2332' }}>
              <th>Username</th>
              <th>Email</th>
              <th>Phone</th>
              <th>Wallet</th>
              <th>Steps</th>
              <th>Earned</th>
              <th>Role</th>
              <th>Status</th>
              <th style={{ textAlign: 'center' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filteredUsers.map((user) => (
              <tr key={user.id} style={{ borderBottom: '1px solid #2d3748' }}>
                <td>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    {user.is_staff && <UserCog size={16} color="#fbbf24" />}
                    <span style={{ fontWeight: user.is_staff ? 600 : 400 }}>{user.username}</span>
                  </div>
                </td>
                <td style={{ color: '#64748b' }}>{user.email}</td>
                <td style={{ color: '#64748b' }}>{user.phone_number || '-'}</td>
                <td>{formatKES(user.wallet_balance)}</td>
                <td>{user.total_steps?.toLocaleString() || 0}</td>
                <td>{formatKES(user.total_earned)}</td>
                <td>
                  <span
                    style={{
                      padding: '4px 8px',
                      borderRadius: '4px',
                      fontSize: '12px',
                      fontWeight: 600,
                      background: user.is_staff ? '#7c2d12' : '#1e3a8a',
                      color: user.is_staff ? '#fdba74' : '#93c5fd',
                    }}
                  >
                    {user.is_staff ? 'Admin' : 'User'}
                  </span>
                </td>
                <td>
                  <span
                    style={{
                      padding: '4px 8px',
                      borderRadius: '4px',
                      fontSize: '12px',
                      fontWeight: 600,
                      background: user.is_active ? '#065f46' : '#7f1d1d',
                      color: user.is_active ? '#6ee7b7' : '#fca5a5',
                    }}
                  >
                    {user.is_active ? 'Active' : 'Banned'}
                  </span>
                </td>
                <td>
                  <div style={{ display: 'flex', gap: '8px', justifyContent: 'center' }}>
                    <button
                      onClick={() => openEditModal(user)}
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
                      title="Edit User"
                    >
                      <Edit2 size={14} />
                    </button>
                    <button
                      onClick={() => openResetPasswordModal(user)}
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
                      title="Reset Password"
                    >
                      <Key size={14} />
                    </button>
                    <button
                      onClick={() => toggleStaff(user)}
                      style={{
                        padding: '6px 10px',
                        background: user.is_staff ? '#6b21a8' : '#065f46',
                        color: '#fff',
                        border: 'none',
                        borderRadius: '4px',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '4px',
                      }}
                      title={user.is_staff ? 'Demote from Admin' : 'Promote to Admin'}
                    >
                      {user.is_staff ? <ShieldOff size={14} /> : <Shield size={14} />}
                    </button>
                    <button
                      onClick={() => toggleBan(user)}
                      style={{
                        padding: '6px 10px',
                        background: user.is_active ? '#991b1b' : '#065f46',
                        color: '#fff',
                        border: 'none',
                        borderRadius: '4px',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '4px',
                      }}
                      title={user.is_active ? 'Ban User' : 'Unban User'}
                    >
                      {user.is_active ? <Ban size={14} /> : <CheckCircle2 size={14} />}
                    </button>
                    <button
                      onClick={() => setDeletingUser(user)}
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
                      title="Delete User"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Edit User Modal */}
      {editingUser && (
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
            <h2 style={{ fontSize: '20px', marginBottom: '20px', color: '#fff' }}>Edit User</h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <div>
                <label style={{ display: 'block', marginBottom: '8px', color: '#64748b' }}>Username</label>
                <input
                  type="text"
                  value={editForm.username}
                  onChange={(e) => setEditForm({ ...editForm, username: e.target.value })}
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
                <label style={{ display: 'block', marginBottom: '8px', color: '#64748b' }}>Email</label>
                <input
                  type="email"
                  value={editForm.email}
                  onChange={(e) => setEditForm({ ...editForm, email: e.target.value })}
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
                <label style={{ display: 'block', marginBottom: '8px', color: '#64748b' }}>Phone Number</label>
                <input
                  type="text"
                  value={editForm.phone_number}
                  onChange={(e) => setEditForm({ ...editForm, phone_number: e.target.value })}
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
                <button onClick={() => setEditingUser(null)} style={{ padding: '10px 20px', background: '#2d3748', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer' }}>
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

      {/* Reset Password Modal */}
      {resettingPassword && (
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
            <h2 style={{ fontSize: '20px', marginBottom: '20px', color: '#fff' }}>Reset Password for {resettingPassword.username}</h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <div>
                <label style={{ display: 'block', marginBottom: '8px', color: '#64748b' }}>New Password</label>
                <input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="At least 8 characters"
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
                <label style={{ display: 'block', marginBottom: '8px', color: '#64748b' }}>Confirm Password</label>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Re-enter password"
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
                <button onClick={() => setResettingPassword(null)} style={{ padding: '10px 20px', background: '#2d3748', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer' }}>
                  Cancel
                </button>
                <button onClick={handleResetPassword} style={{ padding: '10px 20px', background: '#00f5e9', color: '#091120', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 600 }}>
                  Reset Password
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deletingUser && (
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
            <h2 style={{ fontSize: '20px', marginBottom: '20px', color: '#ef4444' }}>Delete User</h2>
            <p style={{ color: '#64748b', marginBottom: '20px' }}>
              Are you sure you want to permanently delete <strong style={{ color: '#fff' }}>{deletingUser.username}</strong>? This action cannot be undone.
            </p>
            <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
              <button onClick={() => setDeletingUser(null)} style={{ padding: '10px 20px', background: '#2d3748', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer' }}>
                Cancel
              </button>
              <button onClick={handleDelete} style={{ padding: '10px 20px', background: '#7f1d1d', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 600 }}>
                Delete User
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
