/**
 * Page-shaped loading skeletons.
 *
 * Each one mirrors the layout of the content it stands in for, so the page
 * doesn't jump around when the real data lands. Built from the primitives in
 * Skeleton.tsx.
 */

import { Skeleton, SkeletonCircle, SkeletonText } from './Skeleton';

/** Search results — matches the ResultCard header, platform badges and actions. */
export function SearchResultsSkeleton({ count = 3 }: { count?: number }) {
  return (
    <div className="space-y-4">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="result-card">
          <div className="flex gap-4 p-4">
            <Skeleton className="w-16 h-16 flex-shrink-0 rounded" />
            <div className="flex-1 min-w-0 space-y-2">
              <Skeleton className="h-4 w-16 rounded" />
              <Skeleton className="h-5 w-1/2" />
              <Skeleton className="h-3 w-1/3" />
            </div>
          </div>
          <div className="px-4 pb-4 flex flex-wrap gap-2">
            {Array.from({ length: 4 - (i % 2) }, (_, j) => (
              <Skeleton key={j} className="h-8 w-28 rounded" />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Artist profile hero, bio and platform links. */
export function ArtistProfileSkeleton() {
  return (
    <div>
      <div className="pt-12 pb-8 flex flex-col items-center">
        <SkeletonCircle className="w-32 h-32 mb-4" />
        <Skeleton className="h-8 w-48 mb-3" />
        <Skeleton className="h-3 w-32 mb-6" />
        <SkeletonText lines={2} className="w-full max-w-md" />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="source-card flex items-center gap-3">
            <SkeletonCircle className="w-8 h-8 flex-shrink-0" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-3 w-16" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** One saved/claimed artist card, as shown on the dashboard. */
function ArtistCardSkeleton() {
  return (
    <div className="p-4 rounded-lg bg-bg-secondary border border-border">
      <div className="flex gap-4">
        <SkeletonCircle className="w-16 h-16 flex-shrink-0" />
        <div className="flex-1 min-w-0 space-y-2">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-3 w-1/2" />
          <div className="flex gap-2 pt-2">
            <Skeleton className="h-8 w-16 rounded-lg" />
            <Skeleton className="h-8 w-24 rounded-lg" />
          </div>
        </div>
      </div>
    </div>
  );
}

/** The signed-in dashboard: claimed profiles above a grid of saved artists. */
export function DashboardSkeleton() {
  return (
    <div className="space-y-8">
      <Skeleton className="h-7 w-40" />

      <section>
        <Skeleton className="h-5 w-32 mb-4" />
        <ArtistCardSkeleton />
      </section>

      <section>
        <Skeleton className="h-5 w-36 mb-4" />
        <Skeleton className="h-12 w-full rounded-lg mb-4" />
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 6 }, (_, i) => (
            <ArtistCardSkeleton key={i} />
          ))}
        </div>
      </section>
    </div>
  );
}

/** A compact list of artist rows — the directory and public saved-artist lists. */
export function ArtistRowsSkeleton({ count = 8 }: { count?: number }) {
  return (
    <div className="grid gap-0.5">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="flex items-center gap-3 px-3.5 py-2.5">
          <SkeletonCircle className="w-9 h-9 flex-shrink-0" />
          <Skeleton className={`h-4 ${i % 3 === 0 ? 'w-40' : i % 3 === 1 ? 'w-28' : 'w-52'}`} />
        </div>
      ))}
    </div>
  );
}

/** Cards in a vertical list — guides index and changelog entries. */
export function ArticleListSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="space-y-4">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="bg-surface-secondary rounded-xl p-6 border border-border space-y-3">
          <Skeleton className="h-5 w-2/3" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-4/5" />
        </div>
      ))}
    </div>
  );
}

/** Long-form article body. */
export function ArticleSkeleton() {
  return (
    <div className="space-y-6">
      <SkeletonText lines={4} />
      <Skeleton className="h-5 w-1/3" />
      <SkeletonText lines={5} />
      <SkeletonText lines={3} />
    </div>
  );
}

/** Stacked form sections — settings, profile editing, admin queues. */
export function FormSkeleton({ sections = 2, fields = 3 }: { sections?: number; fields?: number }) {
  return (
    <div className="space-y-8">
      <Skeleton className="h-7 w-40" />
      {Array.from({ length: sections }, (_, i) => (
        <section key={i} className="p-6 rounded-lg bg-bg-secondary border border-border space-y-4">
          <Skeleton className="h-5 w-32" />
          {Array.from({ length: fields }, (_, j) => (
            <div key={j} className="space-y-2">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-10 w-full rounded-lg" />
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}

/** Three stat tiles over a short bar breakdown — the analytics panels. */
export function StatTilesSkeleton({ bars = 3 }: { bars?: number }) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-2">
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="p-2 rounded bg-bg-primary border border-border/50 flex flex-col items-center gap-1.5">
            <Skeleton className="h-5 w-10" />
            <Skeleton className="h-2.5 w-14" />
          </div>
        ))}
      </div>
      <div className="space-y-1.5">
        {Array.from({ length: bars }, (_, i) => (
          <div key={i} className="flex items-center gap-2">
            <Skeleton className="h-3 w-20" />
            <Skeleton className={`h-4 flex-1 ${i === 0 ? '' : 'opacity-70'}`} />
            <Skeleton className="h-3 w-8" />
          </div>
        ))}
      </div>
    </div>
  );
}
