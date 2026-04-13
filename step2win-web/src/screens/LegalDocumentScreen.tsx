import { useState, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation } from '@tanstack/react-query';
import { ArrowLeft, Download, RefreshCw, AlertCircle } from 'lucide-react';
import { legalService } from '../services/api/legal';

export default function LegalDocumentScreen() {
  const { slug }     = useParams<{ slug: string }>();
  const navigate     = useNavigate();
  const contentRef   = useRef<HTMLDivElement>(null);
  const [hasScrolled, setHasScrolled] = useState(false);

  const { data: doc, isLoading, error } = useQuery({
    queryKey: ['legal', slug],
    queryFn:  () => legalService.get(slug!),
    enabled:  !!slug,
  });

  const ackMut = useMutation({
    mutationFn: () => legalService.acknowledge(slug!),
  });

  // Acknowledge when user scrolls to bottom
  const handleScroll = () => {
    if (!contentRef.current || hasScrolled) return;
    const { scrollTop, scrollHeight, clientHeight } = contentRef.current;
    if (scrollTop + clientHeight >= scrollHeight - 60) {
      setHasScrolled(true);
      ackMut.mutate();
    }
  };

  return (
    <div className="flex flex-col h-screen bg-bg-page">

      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-4 bg-bg-elevated
                      border-b border-border-light flex-shrink-0"
        style={{ paddingTop: 'calc(env(safe-area-inset-top, 0px) + 16px)' }}>
        <button
          onClick={() => navigate(-1)}
          className="w-9 h-9 rounded-xl flex items-center justify-center"
          style={{ background: 'hsl(var(--bg-input))' }}>
          <ArrowLeft size={18} className="text-text-primary" />
        </button>
        <div className="flex-1 min-w-0">
          <h1 className="text-text-primary text-base font-bold truncate">
            {isLoading ? 'Loading...' : doc?.title}
          </h1>
          {doc && (
            <p className="text-text-muted text-xs">
              Version {doc.version_label}  {' '}
              {doc.published_at
                ? new Date(doc.published_at).toLocaleDateString('en-KE', {
                    day: 'numeric', month: 'short', year: 'numeric'
                  })
                : ''}
            </p>
          )}
        </div>
        {/* Download original */}
        {doc?.uploaded_file && (
          <a
            href={doc.uploaded_file}
            target="_blank"
            rel="noopener noreferrer"
            className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0"
            style={{ background: 'hsl(var(--bg-input))' }}>
            <Download size={16} className="text-accent-blue" />
          </a>
        )}
      </div>

      {/* Update banner */}
      {doc?.has_update && (
        <div className="flex items-center gap-3 px-4 py-3 flex-shrink-0"
          style={{ background: 'hsl(var(--bg-input))', borderBottom: '1px solid hsl(var(--border-light))' }}>
          <AlertCircle size={16} className="text-accent-yellow" />
          <div className="flex-1">
            <p className="text-text-primary text-xs font-bold">
              This document has been updated
            </p>
            {doc.change_summary && (
              <p className="text-text-secondary text-xs">{doc.change_summary}</p>
            )}
          </div>
        </div>
      )}

      {/* Content */}
      <div
        ref={contentRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto px-5 py-5">

        {isLoading && (
          <div className="flex flex-col items-center justify-center py-20">
            <RefreshCw size={24} className="text-accent-blue animate-spin mb-3" />
            <p className="text-text-muted text-sm">Loading document...</p>
          </div>
        )}

        {error && (
          <div className="flex flex-col items-center justify-center py-20">
            <AlertCircle size={32} className="text-error mb-3" />
            <p className="text-text-primary font-semibold mb-1">Failed to load</p>
            <p className="text-text-muted text-sm text-center">
              Could not load this document. Please check your connection and try again.
            </p>
          </div>
        )}

        {doc && (
          <>
            {/* Render HTML content */}
            <div
              className="legal-content"
              dangerouslySetInnerHTML={{ __html: doc.content_html }}
            />

            {/* Scroll prompt */}
            {!hasScrolled && (
              <div className="flex items-center justify-center gap-2 py-6 mt-4
                              border-t border-border-light">
                <p className="text-text-muted text-xs">
                  Scroll to the bottom to mark as read
                </p>
              </div>
            )}

            {hasScrolled && (
              <div className="flex items-center justify-center gap-2 py-6 mt-4
                              rounded-2xl" style={{ background: '#ECFDF5' }}>
                <span style={{ fontSize: '16px' }}></span>
                <p className="text-success text-sm font-semibold">
                  Document read and acknowledged
                </p>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

