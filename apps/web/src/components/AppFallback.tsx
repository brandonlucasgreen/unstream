import { Skeleton } from './Skeleton';
import { PageSkeleton } from './PageSkeleton';
import { ArticleListSkeleton } from './LoadingSkeletons';

/** Shown while a lazily-loaded page chunk downloads. */
export function AppLoadingFallback() {
  return (
    <PageSkeleton label="Loading page" maxWidth="max-w-4xl">
      <div className="space-y-8">
        <Skeleton className="h-7 w-48" />
        <ArticleListSkeleton count={3} />
      </div>
    </PageSkeleton>
  );
}

/**
 * Shown when a render throws. This sits outside the router, so it can't use
 * <Link> — a plain link back to the homepage is the way out.
 */
export function AppErrorFallback() {
  return (
    <div className="min-h-screen bg-bg-primary text-text-primary flex flex-col items-center justify-center gap-4 p-6 text-center">
      <h1 className="font-display text-2xl font-semibold">Something went wrong</h1>
      <p className="text-text-muted max-w-md">
        Unstream hit an unexpected error. Reloading usually clears it.
      </p>
      <a
        href="/"
        className="px-4 py-2 rounded-lg bg-accent-primary text-white text-sm font-medium hover:bg-accent-primary/90 transition-colors"
      >
        Back to Unstream
      </a>
    </div>
  );
}
