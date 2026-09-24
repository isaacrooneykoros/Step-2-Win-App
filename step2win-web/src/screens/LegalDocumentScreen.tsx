import { useState } from "react";
import { createPortal } from "react-dom";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, FileQuestion, Info } from "lucide-react";
import { legalService } from "../services/api/legal";
import { formatShortDate } from "../lib/format";
import { ScreenHeader } from "../components/ui/ScreenHeader";
import Button from "../components/ui/Button";
import { Skeleton } from "../components/ui/Skeleton";
import { EmptyState } from "../components/ui/EmptyState";
import { LoadError } from "../components/ui/ErrorState";
import { useToast } from "../components/ui/Toast";
import { apiErrorMessage } from "../components/settings/apiError";
import { sanitizeHtml } from '../utils/sanitize';

const FALLBACK_TITLES: Record<string, string> = {
  "privacy-policy": "Privacy policy",
  "terms-and-conditions": "Terms of service",
};

export default function LegalDocumentScreen() {
  const { slug } = useParams<{ slug: string }>();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const [acknowledged, setAcknowledged] = useState(false);

  const {
    data: doc,
    isLoading,
    error,
    refetch,
    isFetching,
  } = useQuery({
    queryKey: ["legal", slug],
    queryFn: () => legalService.get(slug!),
    enabled: !!slug,
    retry: (count, err: any) => err?.response?.status !== 404 && count < 2,
  });

  const ackMut = useMutation({
    mutationFn: () => legalService.acknowledge(slug!),
    onSuccess: () => {
      setAcknowledged(true);
      queryClient.invalidateQueries({ queryKey: ["legal", slug] });
      showToast({
        message: "Thanks — we’ve recorded that you’ve read this version.",
        type: "success",
      });
    },
    onError: (err: unknown) =>
      showToast({
        message: apiErrorMessage(
          err,
          "We couldn’t record that. Please try again.",
        ),
        type: "error",
      }),
  });

  const notFound = (error as any)?.response?.status === 404;
  const title = doc?.title ?? FALLBACK_TITLES[slug ?? ""] ?? "Document";
  const showAck = Boolean(doc?.has_update) || acknowledged;

  return (
    <div
      className="pb-nav"
      style={
        showAck
          ? {
              paddingBottom:
                "calc(var(--nav-height) + max(env(safe-area-inset-bottom), 8px) + 96px)",
            }
          : undefined
      }
    >
      <ScreenHeader
        title={title}
        back
        actions={
          doc?.uploaded_file ? (
            <a
              href={doc.uploaded_file}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-11 w-11 items-center justify-center rounded-full text-text-primary hover:bg-bg-input"
              aria-label="Download original document"
              title="Download original"
            >
              <Download size={20} aria-hidden />
            </a>
          ) : undefined
        }
      />

      <article className="mx-auto w-full max-w-prose px-5 pb-10 pt-2">
        {isLoading ? (
          <div
            aria-busy="true"
            aria-label="Loading document"
            className="space-y-3"
          >
            <Skeleton className="h-8 w-2/3 rounded" />
            <Skeleton className="h-3 w-40 rounded" />
            <div className="space-y-2 pt-4">
              {[100, 95, 98, 80, 100, 90, 60].map((w, i) => (
                <Skeleton
                  key={i}
                  className="h-4 rounded"
                  style={{ width: `${w}%` }}
                />
              ))}
            </div>
          </div>
        ) : notFound ? (
          <EmptyState
            icon={FileQuestion}
            title={`${title} isn’t available yet`}
            description="This document hasn’t been published. Please check back later or contact support if you need it now."
          />
        ) : error || !doc ? (
          <LoadError
            resource="this document"
            onRetry={() => refetch()}
            isRetrying={isFetching}
          />
        ) : (
          <>
            <header className="mb-6 border-b border-border-light pb-5">
              <h1 className="text-title-lg text-text-primary">{doc.title}</h1>
              <p className="mt-2 text-caption text-text-muted">
                Version <span className="num">{doc.version_label}</span>
                {doc.published_at ? (
                  <> · Updated {formatShortDate(doc.published_at)}</>
                ) : null}
              </p>
              {doc.has_update && !acknowledged && (
                <div
                  className="mt-4 flex gap-3 rounded-control bg-info-soft px-3 py-3"
                  role="note"
                >
                  <Info
                    size={18}
                    className="mt-0.5 shrink-0 text-info"
                    aria-hidden
                  />
                  <div className="min-w-0">
                    <p className="text-callout font-semibold text-text-primary">
                      This document has changed since you last read it
                    </p>
                    {doc.change_summary && (
                      <p className="mt-0.5 text-callout text-text-secondary">
                        {doc.change_summary}
                      </p>
                    )}
                  </div>
                </div>
              )}
            </header>
            <div
              className="legal-content"
              dangerouslySetInnerHTML={{ __html: sanitizeHtml(doc.content_html) }}
            />
          </>
        )}
      </article>

      {/* Portalled: the route wrapper animates with a transform, which would break position: fixed. */}
      {doc &&
        showAck &&
        createPortal(
          <div
            className="fixed inset-x-0 z-40 border-t border-border-light bg-bg-elevated/95 px-5 py-3 backdrop-blur-md"
            style={{
              bottom:
                "calc(var(--nav-height) + env(safe-area-inset-bottom, 0px))",
            }}
          >
            <div className="mx-auto flex w-full max-w-prose items-center gap-3">
              <p className="min-w-0 flex-1 text-caption text-text-secondary">
                {acknowledged
                  ? "You’ve acknowledged this version."
                  : `Please confirm you’ve read version ${doc.version_label}.`}
              </p>
              <Button
                onClick={() => {
                  if (!acknowledged) ackMut.mutate();
                }}
                isLoading={ackMut.isPending}
                loadingText="Saving"
                isSuccess={acknowledged}
                successText="Acknowledged"
              >
                I’ve read it
              </Button>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
