import { useState, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import Link from '@tiptap/extension-link';
import TextAlign from '@tiptap/extension-text-align';
import {
  FileText, Upload, Eye, History, Save, Send,
  AlertCircle, CheckCircle,
  RotateCcw, X, Loader2, Download
} from 'lucide-react';
import { legalAdminService } from '../services/legalApi';
import { formatDistanceToNow } from 'date-fns';
import { sanitizeHtml } from '../utils/sanitize';

type LegalDocument = {
  id: number
  title: string
  status: string
  version_label: string
  content_html: string
  updated_at?: string
  uploaded_file?: string
  last_edited_by_username?: string
}

type LegalHistoryVersion = {
  id: number
  version_label: string
  change_summary?: string
  published_by_username?: string
  published_at: string
}

type LegalHistoryResponse = {
  history: LegalHistoryVersion[]
}

type UploadResponse = {
  content_html: string
}

type PublishResponse = {
  version_label: string
}

// ── Tiptap toolbar button ────────────────────────────────────────────────────
function ToolbarBtn({
  onClick, active = false, disabled = false, children, title
}: {
  onClick: () => void
  active?: boolean
  disabled?: boolean
  children: React.ReactNode
  title?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`px-2.5 py-1.5 rounded text-xs font-semibold transition-colors ${
        active
          ? 'bg-indigo-600 text-white'
          : 'text-slate-300 hover:bg-slate-700 hover:text-white'
      } ${disabled ? 'opacity-40 cursor-not-allowed' : ''}`}>
      {children}
    </button>
  );
}

// ── Rich text editor with toolbar ────────────────────────────────────────────
function RichEditor({
  content, onChange
}: {
  content: string
  onChange: (html: string) => void
}) {
  const editor = useEditor({
    extensions: [
      StarterKit,
      Underline,
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      Link.configure({ openOnClick: false }),
    ],
    content,
    onUpdate: ({ editor }) => onChange(editor.getHTML()),
    editorProps: {
      attributes: {
        class: 'prose prose-invert max-w-none min-h-100 p-4 focus:outline-none text-slate-200',
      },
    },
  });

  if (!editor) return null;

  return (
    <div className="border border-slate-700 rounded-xl overflow-hidden">
      {/* Toolbar */}
      <div className="flex flex-wrap gap-1 p-2 bg-slate-800 border-b border-slate-700">
        <ToolbarBtn onClick={() => editor.chain().focus().toggleBold().run()}
          active={editor.isActive('bold')} title="Bold">B</ToolbarBtn>
        <ToolbarBtn onClick={() => editor.chain().focus().toggleItalic().run()}
          active={editor.isActive('italic')} title="Italic"><em>I</em></ToolbarBtn>
        <ToolbarBtn onClick={() => editor.chain().focus().toggleUnderline().run()}
          active={editor.isActive('underline')} title="Underline"><u>U</u></ToolbarBtn>
        <div className="w-px bg-slate-600 mx-1" />
        <ToolbarBtn onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
          active={editor.isActive('heading', { level: 1 })} title="Heading 1">H1</ToolbarBtn>
        <ToolbarBtn onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
          active={editor.isActive('heading', { level: 2 })} title="Heading 2">H2</ToolbarBtn>
        <ToolbarBtn onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
          active={editor.isActive('heading', { level: 3 })} title="Heading 3">H3</ToolbarBtn>
        <div className="w-px bg-slate-600 mx-1" />
        <ToolbarBtn onClick={() => editor.chain().focus().toggleBulletList().run()}
          active={editor.isActive('bulletList')} title="Bullet List">• List</ToolbarBtn>
        <ToolbarBtn onClick={() => editor.chain().focus().toggleOrderedList().run()}
          active={editor.isActive('orderedList')} title="Numbered List">1. List</ToolbarBtn>
        <div className="w-px bg-slate-600 mx-1" />
        <ToolbarBtn onClick={() => editor.chain().focus().setTextAlign('left').run()}
          active={editor.isActive({ textAlign: 'left' })} title="Align Left">≡</ToolbarBtn>
        <ToolbarBtn onClick={() => editor.chain().focus().setTextAlign('center').run()}
          active={editor.isActive({ textAlign: 'center' })} title="Center">≡</ToolbarBtn>
        <div className="w-px bg-slate-600 mx-1" />
        <ToolbarBtn onClick={() => editor.chain().focus().toggleBlockquote().run()}
          active={editor.isActive('blockquote')} title="Quote">" "</ToolbarBtn>
        <ToolbarBtn onClick={() => editor.chain().focus().setHorizontalRule().run()}
          title="Divider">—</ToolbarBtn>
        <ToolbarBtn onClick={() => editor.chain().focus().undo().run()}
          disabled={!editor.can().undo()} title="Undo">↩</ToolbarBtn>
        <ToolbarBtn onClick={() => editor.chain().focus().redo().run()}
          disabled={!editor.can().redo()} title="Redo">↪</ToolbarBtn>
      </div>

      {/* Editor area */}
      <div className="bg-slate-900 min-h-100">
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}

// ── File upload drop zone ─────────────────────────────────────────────────────
function FileDropZone({
  onFile, loading
}: {
  onFile: (file: File) => void
  loading: boolean
}) {
  const [dragging, setDragging] = useState(false);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) onFile(file);
  }, [onFile]);

  return (
    <div
      onDragOver={e => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
      className={`relative border-2 border-dashed rounded-xl p-8 text-center transition-all ${
        dragging
          ? 'border-indigo-500 bg-indigo-950/30'
          : 'border-slate-600 hover:border-slate-500 bg-slate-800/50'
      }`}>
      {loading ? (
        <div className="flex flex-col items-center gap-3">
          <Loader2 size={28} className="text-indigo-400 animate-spin" />
          <p className="text-slate-400 text-sm">Converting file...</p>
        </div>
      ) : (
        <>
          <Upload size={28} className="text-slate-500 mx-auto mb-3" />
          <p className="text-slate-300 text-sm font-semibold mb-1">
            Drop your file here
          </p>
          <p className="text-slate-500 text-xs mb-4">
            Supports .docx, .pdf, .html
          </p>
          <label className="cursor-pointer inline-flex items-center gap-2 px-4 py-2
                            bg-indigo-600 hover:bg-indigo-500 rounded-lg text-white
                            text-sm font-semibold transition-colors">
            <Upload size={14} />
            Browse File
            <input
              type="file"
              accept=".docx,.pdf,.html"
              className="hidden"
              onChange={e => {
                const f = e.target.files?.[0];
                if (f) onFile(f);
              }}
            />
          </label>
          <p className="text-slate-600 text-xs mt-3">
            DOCX recommended — preserves all formatting
          </p>
        </>
      )}
    </div>
  );
}

// ── History panel ─────────────────────────────────────────────────────────────
function HistoryPanel({
  docId, onRestore, onClose
}: {
  docId: number
  onRestore: () => void
  onClose: () => void
}) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<LegalHistoryResponse>({
    queryKey: ['legal', 'history', docId],
    queryFn:  () => legalAdminService.history(docId),
  });
  const restoreMut = useMutation({
    mutationFn: ({ versionId }: { versionId: number }) =>
      legalAdminService.restore(docId, versionId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['legal', 'admin'] });
      onRestore();
      onClose();
    },
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.7)' }}>
      <div className="bg-slate-800 rounded-2xl p-6 w-full max-w-lg max-h-[80vh]
                      overflow-y-auto border border-slate-700">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-white font-bold text-lg">Version History</h3>
          <button onClick={onClose}
            className="w-8 h-8 rounded-lg bg-slate-700 flex items-center justify-center">
            <X size={16} className="text-slate-400" />
          </button>
        </div>
        {isLoading ? (
          <div className="flex justify-center py-8">
            <Loader2 size={24} className="text-indigo-400 animate-spin" />
          </div>
        ) : (
          <div className="space-y-3">
            {(data?.history || []).map((v) => (
              <div key={v.id}
                className="flex items-center gap-3 p-3 rounded-xl bg-slate-900
                           border border-slate-700">
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-indigo-400 font-mono text-sm font-bold">
                      v{v.version_label}
                    </span>
                    {v.change_summary && (
                      <span className="text-slate-400 text-xs">
                        — {v.change_summary}
                      </span>
                    )}
                  </div>
                  <p className="text-slate-500 text-xs mt-0.5">
                    {v.published_by_username} · {' '}
                    {formatDistanceToNow(new Date(v.published_at),
                      { addSuffix: true })}
                  </p>
                </div>
                <button
                  onClick={() => restoreMut.mutate({ versionId: v.id })}
                  disabled={restoreMut.isPending}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg
                             bg-slate-700 hover:bg-slate-600 text-slate-300
                             text-xs font-semibold transition-colors">
                  <RotateCcw size={12} />
                  Restore
                </button>
              </div>
            ))}
            {data?.history?.length === 0 && (
              <p className="text-slate-500 text-sm text-center py-4">
                No version history yet. Publish the document to start tracking versions.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function LegalDocumentsPage() {
  const qc = useQueryClient();
  const [selectedId,    setSelectedId]    = useState<number | null>(null);
  const [editorContent, setEditorContent] = useState('');
  const [showHistory,   setShowHistory]   = useState(false);
  const [showPublish,   setShowPublish]   = useState(false);
  const [notifyUsers,   setNotifyUsers]   = useState(false);
  const [changeSummary, setChangeSummary] = useState('');
  const [uploadLoading, setUploadLoading] = useState(false);
  const [toast,         setToast]         = useState<{type:'success'|'error'; msg:string}|null>(null);
  const [previewMode,   setPreviewMode]   = useState(false);

  const showToast = (type: 'success' | 'error', msg: string) => {
    setToast({ type, msg });
    setTimeout(() => setToast(null), 3500);
  };

  // ── Fetch all docs ──────────────────────────────────────────────────────
  const { data: docs = [], isLoading } = useQuery<LegalDocument[]>({
    queryKey: ['legal', 'admin'],
    queryFn:  () => legalAdminService.list(),
  });

  const selectedDoc = docs.find((d) => d.id === selectedId);

  // ── Save draft ──────────────────────────────────────────────────────────
  const saveMut = useMutation({
    mutationFn: () => legalAdminService.updateContent(selectedId!, {
      content_html: editorContent,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['legal', 'admin'] });
      showToast('success', 'Draft saved.');
    },
    onError: () => showToast('error', 'Save failed. Try again.'),
  });

  // ── File upload ─────────────────────────────────────────────────────────
  const handleFileUpload = async (file: File) => {
    if (!selectedId) return;
    setUploadLoading(true);
    try {
      const result = await legalAdminService.uploadFile(selectedId, file) as UploadResponse;
      setEditorContent(result.content_html);
      qc.invalidateQueries({ queryKey: ['legal', 'admin'] });
      showToast('success', `${file.name} uploaded and converted successfully.`);
    } catch (err: unknown) {
      showToast('error', err instanceof Error ? err.message : 'Upload failed.');
    } finally {
      setUploadLoading(false);
    }
  };

  // ── Publish ─────────────────────────────────────────────────────────────
  const publishMut = useMutation({
    mutationFn: () => legalAdminService.publish(selectedId!, {
      notify_users:   notifyUsers,
      change_summary: changeSummary,
    }),
    onSuccess: (data: PublishResponse) => {
      qc.invalidateQueries({ queryKey: ['legal', 'admin'] });
      setShowPublish(false);
      setChangeSummary('');
      showToast('success',
        `Published as v${data.version_label}${notifyUsers ? ' — users will be notified.' : '.'}`
      );
    },
    onError: () => showToast('error', 'Publish failed. Try again.'),
  });

  const openDoc = (doc: LegalDocument) => {
    setSelectedId(doc.id);
    setEditorContent(doc.content_html || '');
    setPreviewMode(false);
    setShowHistory(false);
    setShowPublish(false);
  };

  const statusColor = (s: string) =>
    s === 'published' ? 'text-emerald-400' :
    s === 'draft'     ? 'text-yellow-400'  : 'text-slate-500';

  return (
    <div className="p-6 min-h-screen" style={{ background: '#13151F' }}>

      {/* Toast */}
      {toast && (
        <div className={`fixed top-4 right-4 z-100 flex items-center gap-3
                         px-4 py-3 rounded-xl shadow-lg border text-sm font-semibold
                         ${toast.type === 'success'
                           ? 'bg-emerald-950 border-emerald-700 text-emerald-300'
                           : 'bg-red-950 border-red-700 text-red-300'}`}>
          {toast.type === 'success'
            ? <CheckCircle size={16} />
            : <AlertCircle size={16} />}
          {toast.msg}
        </div>
      )}

      {/* History modal */}
      {showHistory && selectedId && (
        <HistoryPanel
          docId={selectedId}
          onRestore={() => {
            const doc = docs.find((d) => d.id === selectedId);
            if (doc) setEditorContent(doc.content_html);
          }}
          onClose={() => setShowHistory(false)}
        />
      )}

      {/* Publish confirm modal */}
      {showPublish && (
        <div className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ background: 'rgba(0,0,0,0.7)' }}>
          <div className="bg-slate-800 rounded-2xl p-6 w-full max-w-md
                          border border-slate-700">
            <h3 className="text-white font-bold text-lg mb-1">Publish Document</h3>
            <p className="text-slate-400 text-sm mb-5">
              This will make the document live to all users immediately.
            </p>

            <label className="block text-slate-400 text-xs font-semibold
                               uppercase tracking-wider mb-1.5">
              What changed? (optional)
            </label>
            <input
              value={changeSummary}
              onChange={e => setChangeSummary(e.target.value)}
              placeholder="e.g. Updated Section 5 — withdrawal limits"
              className="w-full px-3 py-2.5 rounded-xl bg-slate-900 border
                         border-slate-700 text-slate-200 text-sm mb-4
                         focus:outline-none focus:border-indigo-500"
            />

            <label className="flex items-center gap-3 cursor-pointer mb-5">
              <div
                onClick={() => setNotifyUsers(v => !v)}
                className={`w-11 h-6 rounded-full transition-colors shrink-0
                            flex items-center px-0.5 ${
                  notifyUsers ? 'bg-indigo-600' : 'bg-slate-600'
                }`}>
                <div className={`w-5 h-5 rounded-full bg-white shadow transition-transform ${
                  notifyUsers ? 'translate-x-5' : 'translate-x-0'
                }`} />
              </div>
              <div>
                <p className="text-slate-200 text-sm font-semibold">
                  Notify users of changes
                </p>
                <p className="text-slate-500 text-xs">
                  Shows "Updated" badge to users who haven't re-read this version
                </p>
              </div>
            </label>

            <div className="flex gap-3">
              <button onClick={() => setShowPublish(false)}
                className="flex-1 py-2.5 rounded-xl bg-slate-700 text-slate-300
                           text-sm font-semibold hover:bg-slate-600 transition-colors">
                Cancel
              </button>
              <button
                onClick={() => publishMut.mutate()}
                disabled={publishMut.isPending}
                className="flex-1 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500
                           text-white text-sm font-semibold transition-colors
                           flex items-center justify-center gap-2">
                {publishMut.isPending
                  ? <Loader2 size={16} className="animate-spin" />
                  : <Send size={16} />}
                Publish Now
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Page header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-white text-2xl font-bold">Legal Documents</h1>
          <p className="text-slate-400 text-sm mt-0.5">
            Manage Privacy Policy, Terms and Conditions, and other legal documents
          </p>
        </div>
      </div>

      <div className="grid grid-cols-12 gap-6">

        {/* ── Left: document list ── */}
        <div className="col-span-4">
          <div className="rounded-2xl overflow-hidden"
            style={{ background: '#1A1D2E', border: '1px solid #252840' }}>
            <div className="px-4 py-3 border-b border-slate-700/50">
              <p className="text-slate-400 text-xs font-semibold uppercase tracking-wider">
                Documents
              </p>
            </div>
            {isLoading ? (
              <div className="flex justify-center py-12">
                <Loader2 size={24} className="text-indigo-400 animate-spin" />
              </div>
            ) : (
              docs.map((doc) => (
                <button
                  key={doc.id}
                  onClick={() => openDoc(doc)}
                  className={`w-full flex items-start gap-3 px-4 py-4 text-left
                              transition-colors border-b border-slate-700/30
                              hover:bg-slate-700/30 ${
                    selectedId === doc.id ? 'bg-indigo-950/40' : ''
                  }`}>
                  <div className="w-9 h-9 rounded-xl flex items-center justify-center
                                  shrink-0 bg-indigo-950">
                    <FileText size={16} className="text-indigo-400" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-slate-200 text-sm font-semibold truncate">
                      {doc.title}
                    </p>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className={`text-xs font-medium capitalize ${statusColor(doc.status)}`}>
                        {doc.status}
                      </span>
                      <span className="text-slate-600 text-xs">·</span>
                      <span className="text-slate-500 text-xs font-mono">
                        v{doc.version_label}
                      </span>
                    </div>
                    {doc.updated_at && (
                      <p className="text-slate-600 text-xs mt-0.5">
                        {formatDistanceToNow(new Date(doc.updated_at), { addSuffix: true })}
                      </p>
                    )}
                  </div>
                </button>
              ))
            )}
          </div>
        </div>

        {/* ── Right: editor ── */}
        <div className="col-span-8">
          {!selectedDoc ? (
            <div className="flex flex-col items-center justify-center h-64
                            rounded-2xl border border-dashed border-slate-700">
              <FileText size={32} className="text-slate-600 mb-3" />
              <p className="text-slate-400 text-sm">
                Select a document to edit
              </p>
            </div>
          ) : (
            <div className="rounded-2xl overflow-hidden"
              style={{ background: '#1A1D2E', border: '1px solid #252840' }}>

              {/* Editor header */}
              <div className="flex items-center justify-between px-5 py-4
                              border-b border-slate-700/50">
                <div>
                  <h2 className="text-white font-bold text-base">
                    {selectedDoc.title}
                  </h2>
                  <p className="text-slate-500 text-xs mt-0.5">
                    {selectedDoc.status === 'published'
                      ? `Published · v${selectedDoc.version_label}`
                      : 'Draft — not visible to users yet'
                    }
                    {selectedDoc.last_edited_by_username &&
                      ` · Last edited by ${selectedDoc.last_edited_by_username}`}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {/* Download original */}
                  {selectedDoc.uploaded_file && (
                    <a
                      href={selectedDoc.uploaded_file}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1.5 px-3 py-2 rounded-lg
                                 bg-slate-700 hover:bg-slate-600 text-slate-300
                                 text-xs font-semibold transition-colors">
                      <Download size={13} />
                      Original
                    </a>
                  )}
                  {/* Preview toggle */}
                  <button
                    onClick={() => setPreviewMode(v => !v)}
                    className={`flex items-center gap-1.5 px-3 py-2 rounded-lg
                                text-xs font-semibold transition-colors ${
                      previewMode
                        ? 'bg-indigo-600 text-white'
                        : 'bg-slate-700 hover:bg-slate-600 text-slate-300'
                    }`}>
                    <Eye size={13} />
                    Preview
                  </button>
                  {/* History */}
                  <button
                    onClick={() => setShowHistory(true)}
                    className="flex items-center gap-1.5 px-3 py-2 rounded-lg
                               bg-slate-700 hover:bg-slate-600 text-slate-300
                               text-xs font-semibold transition-colors">
                    <History size={13} />
                    History
                  </button>
                </div>
              </div>

              <div className="p-5">
                {previewMode ? (
                  /* Preview mode — render HTML */
                  <div className="bg-slate-900 rounded-xl p-6 min-h-100
                                  prose prose-invert prose-sm max-w-none"
                    dangerouslySetInnerHTML={{ __html: sanitizeHtml(editorContent) }} />
                ) : (
                  <>
                    {/* File upload section */}
                    <div className="mb-5">
                      <p className="text-slate-400 text-xs font-semibold uppercase
                                    tracking-wider mb-2">
                        Upload Document File
                      </p>
                      <FileDropZone
                        onFile={handleFileUpload}
                        loading={uploadLoading}
                      />
                      <p className="text-slate-600 text-xs mt-2">
                        Uploading a file will replace the editor content below.
                        The original file is stored for download.
                      </p>
                    </div>

                    {/* Divider */}
                    <div className="flex items-center gap-3 mb-5">
                      <div className="flex-1 h-px bg-slate-700" />
                      <span className="text-slate-500 text-xs font-medium">
                        OR EDIT DIRECTLY
                      </span>
                      <div className="flex-1 h-px bg-slate-700" />
                    </div>

                    {/* Rich text editor */}
                    <div className="mb-5">
                      <p className="text-slate-400 text-xs font-semibold uppercase
                                    tracking-wider mb-2">
                        Document Content
                      </p>
                      <RichEditor
                        content={editorContent}
                        onChange={setEditorContent}
                      />
                    </div>
                  </>
                )}

                {/* Action buttons */}
                <div className="flex items-center gap-3 pt-4 border-t border-slate-700/50">
                  <button
                    onClick={() => saveMut.mutate()}
                    disabled={saveMut.isPending || previewMode}
                    className="flex items-center gap-2 px-4 py-2.5 rounded-xl
                               bg-slate-700 hover:bg-slate-600 text-slate-200
                               text-sm font-semibold transition-colors
                               disabled:opacity-50 disabled:cursor-not-allowed">
                    {saveMut.isPending
                      ? <Loader2 size={15} className="animate-spin" />
                      : <Save size={15} />}
                    Save Draft
                  </button>
                  <button
                    onClick={() => setShowPublish(true)}
                    disabled={!editorContent.trim()}
                    className="flex items-center gap-2 px-5 py-2.5 rounded-xl
                               bg-indigo-600 hover:bg-indigo-500 text-white
                               text-sm font-semibold transition-colors
                               disabled:opacity-50 disabled:cursor-not-allowed"
                    style={{ boxShadow: '0 4px 14px rgba(99,102,241,0.3)' }}>
                    <Send size={15} />
                    Publish
                  </button>
                  <p className="text-slate-500 text-xs ml-auto">
                    Drafts are not visible to users until published
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
