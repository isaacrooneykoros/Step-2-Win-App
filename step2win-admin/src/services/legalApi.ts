import { useAuthStore } from '../store/authStore';

const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:8000';

export type LegalDocument = {
  id: number
  title: string
  document_type?: string
  status: string
  version_label: string
  content_html: string
  updated_at?: string
  uploaded_file?: string
  last_edited_by_username?: string
}

export type LegalHistoryVersion = {
  id: number
  version_label: string
  change_summary?: string
  published_by_username?: string
  published_at: string
}

export type LegalHistoryResponse = {
  history: LegalHistoryVersion[]
}

export type LegalPublishResponse = {
  version_label: string
}

function getAuthToken(): string | null {
  return useAuthStore.getState().accessToken;
}

async function request<T>(
  path: string,
  options?: RequestInit
): Promise<T> {
  const token = getAuthToken();
  const mergedHeaders: Record<string, string> = {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...((options?.headers as Record<string, string> | undefined) || {}),
  };

  // Only set Content-Type if not using FormData
  if (!(options?.body instanceof FormData)) {
    mergedHeaders['Content-Type'] = 'application/json';
  }

  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: mergedHeaders,
  });

  if (!response.ok) {
    const text = await response.text();
    let errorMessage = 'Request failed';
    try {
      const errorData = JSON.parse(text);
      errorMessage = errorData.error || errorData.detail || errorMessage;
    } catch {
      errorMessage = text || errorMessage;
    }
    throw new Error(errorMessage);
  }

  return response.json();
}

export const legalAdminService = {
  list: () =>
    request<LegalDocument[]>('/api/legal/admin/documents/'),

  get: (id: number) =>
    request<LegalDocument>(`/api/legal/admin/documents/${id}/`),

  create: (data: { document_type: string; title: string }) =>
    request<LegalDocument>('/api/legal/admin/documents/create/', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  // Update with text content (JSON)
  updateContent: (id: number, data: {
    content_html?: string
    notify_users?: boolean
    change_summary?: string
  }) =>
    request<LegalDocument>(`/api/legal/admin/documents/${id}/`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),

  // Update with file upload (multipart)
  uploadFile: (id: number, file: File) => {
    const form = new FormData();
    form.append('uploaded_file', file);
    return request<LegalDocument>(`/api/legal/admin/documents/${id}/`, {
      method: 'PATCH',
      body: form,
    });
  },

  publish: (id: number, data: {
    notify_users: boolean
    change_summary: string
  }) =>
    request<LegalPublishResponse>(`/api/legal/admin/documents/${id}/publish/`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  history: (id: number) =>
    request<LegalHistoryResponse>(`/api/legal/admin/documents/${id}/history/`),

  restore: (id: number, versionId: number) =>
    request<LegalDocument>(`/api/legal/admin/documents/${id}/restore/${versionId}/`, {
      method: 'POST',
    }),
};
