import { useQuery } from '@tanstack/react-query';
import { Sheet } from '../ui/Sheet';
import { Button } from '../ui/Button';
import { Skeleton } from '../ui/Skeleton';
import { legalService } from '../../services/api/legal';
import { sanitizeHtml } from '../../utils/sanitize';

export type LegalSlug = 'terms-and-conditions' | 'privacy-policy';

const TITLES: Record<LegalSlug, string> = {
  'terms-and-conditions': 'Terms and Conditions',
  'privacy-policy': 'Privacy Policy',
};

/**
 * The /legal/:slug route sits behind sign-in, so signed-out users read the documents here.
 * The legal API itself is public.
 */
export function LegalSheet({ slug, onClose }: { slug: LegalSlug | null; onClose: () => void }) {
  const { data, isLoading, isError, refetch, isFetching } = useQuery({
    queryKey: ['legal', slug],
    queryFn: () => legalService.get(slug as LegalSlug),
    enabled: Boolean(slug),
    retry: false,
    staleTime: 10 * 60 * 1000,
  });

  return (
    <Sheet
      open={Boolean(slug)}
      onClose={onClose}
      title={data?.title ?? (slug ? TITLES[slug] : '')}
      description={data?.version_label ? `Version ${data.version_label}` : undefined}
      size="lg"
      footer={
        <Button fullWidth size="lg" variant="secondary" onClick={onClose}>
          Close
        </Button>
      }
    >
      {isLoading ? (
        <div className="space-y-3 py-2" aria-busy="true">
          <Skeleton className="h-5 w-2/3 rounded" />
          <Skeleton className="h-4 w-full rounded" />
          <Skeleton className="h-4 w-full rounded" />
          <Skeleton className="h-4 w-5/6 rounded" />
          <Skeleton className="h-4 w-full rounded" />
          <Skeleton className="h-4 w-3/4 rounded" />
        </div>
      ) : isError || !data ? (
        <div className="py-6 text-center">
          <p className="text-body font-semibold text-text-primary">This document isn't available right now</p>
          <p className="mt-1 text-callout text-text-secondary">
            Check your connection and try again. You can also read it later from Settings.
          </p>
          <Button className="mt-4" variant="outline" isLoading={isFetching} onClick={() => void refetch()}>
            Try again
          </Button>
        </div>
      ) : (
        // Content is authored by admins in the backend CMS, same as LegalDocumentScreen.
        <div className="legal-content pb-2" dangerouslySetInnerHTML={{ __html: sanitizeHtml(data.content_html) }} />
      )}
    </Sheet>
  );
}
