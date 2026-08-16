import { useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  COLLECTION_PAGE_SIZE,
  COLLECTION_SORTS,
  pageWindow,
  sortItems,
  type CollectionGridItem,
  type CollectionSortKey,
} from '../utils/collection-grid';

// The album-art grid shared by the public collection page and the owner's dashboard, so the
// two can't drift in sorting, paging or what's clickable. Paging and sorting logic lives in
// utils/collection-grid.ts.

function Tile({ item }: { item: CollectionGridItem }) {
  // Which URL failed, rather than a boolean: a boolean would need resetting whenever the
  // item's art changed, and comparing URLs makes that fall out for free.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const showArt = item.artUrl && failedUrl !== item.artUrl;

  return (
    <div className={`relative group ${item.dimmed ? 'opacity-40' : ''}`}>
      {showArt ? (
        <img
          src={item.artUrl!}
          alt={`${item.title} by ${item.artistName}`}
          loading="lazy"
          // The art proxy answers 404 when Bandcamp has no cover, so a broken image is an
          // expected outcome here, not an error.
          onError={() => setFailedUrl(item.artUrl)}
          className="w-full aspect-square object-cover rounded-lg bg-bg-hover"
        />
      ) : (
        // A mark, not the title: the caption directly below already carries the title and
        // artist, and repeating it inside the square just reads as a rendering fault.
        <div className="w-full aspect-square rounded-lg bg-bg-hover flex items-center justify-center">
          <svg
            className="w-6 h-6 text-text-muted opacity-50"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2z"
            />
          </svg>
        </div>
      )}

      <div className="mt-1.5 min-w-0">
        {item.releaseUrl ? (
          // A plain anchor, never <Link>: /a/{artist}/{release} is rendered by the release-page
          // edge function and has NO route in main.tsx, so React Router's client-side navigation
          // pushed the URL and then rendered nothing — a blank page at the release's own URL. The
          // browser only showed the real page once the visitor reloaded, and Back afterwards
          // restored that release document under the profile's URL, which is the "hard refresh to
          // get back" report. Same reasoning, and the same plain <a>, as ReleasesSection and
          // RecentReleasesSection. The artist link below is a <Link> because /a/{artist} *is* an
          // SPA route.
          <a href={item.releaseUrl} className="block text-xs font-medium truncate hover:underline">
            {item.title}
          </a>
        ) : (
          <p className="text-xs font-medium truncate">{item.title}</p>
        )}
        {item.artistUrl ? (
          <Link
            to={item.artistUrl}
            className="block text-xs text-text-muted truncate hover:text-text-primary hover:underline"
          >
            {item.artistName}
          </Link>
        ) : (
          <p className="text-xs text-text-muted truncate">{item.artistName}</p>
        )}
      </div>

      {item.overlay}
    </div>
  );
}

export function CollectionGrid({ items }: { items: CollectionGridItem[] }) {
  const [sort, setSort] = useState<CollectionSortKey>('added');
  const [page, setPage] = useState(1);

  const sorted = useMemo(() => sortItems(items, sort), [items, sort]);
  const totalPages = Math.max(1, Math.ceil(sorted.length / COLLECTION_PAGE_SIZE));

  // Clamped during render rather than corrected in an effect: a collection that shrinks
  // (an item deleted, a filter applied) can leave `page` past the end, and deriving the
  // safe value avoids a second render pass to fix it.
  const safePage = Math.min(page, totalPages);
  const start = (safePage - 1) * COLLECTION_PAGE_SIZE;
  const visible = sorted.slice(start, start + COLLECTION_PAGE_SIZE);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-text-muted">
          {sorted.length} release{sorted.length === 1 ? '' : 's'}
        </p>
        <label className="flex items-center gap-2 text-sm">
          <span className="text-text-muted">Sort</span>
          <select
            value={sort}
            onChange={e => {
              setSort(e.target.value as CollectionSortKey);
              // Page 1 of the new order — staying on page 7 of a resorted list shows the
              // viewer somewhere arbitrary.
              setPage(1);
            }}
            aria-label="Sort collection"
            className="px-2 py-1 rounded-lg bg-bg-primary border border-border text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent-primary"
          >
            {COLLECTION_SORTS.map(({ key, label }) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="grid grid-cols-3 sm:grid-cols-5 gap-3">
        {visible.map(item => (
          <Tile key={item.key} item={item} />
        ))}
      </div>

      {totalPages > 1 && (
        <nav className="flex flex-wrap items-center justify-center gap-1" aria-label="Collection pages">
          <button
            type="button"
            onClick={() => setPage(p => Math.max(1, Math.min(p, totalPages) - 1))}
            disabled={safePage === 1}
            className="px-2 py-1 rounded text-sm text-text-muted hover:text-text-primary disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Previous
          </button>
          {pageWindow(safePage, totalPages).map((n, i) =>
            n === null ? (
              <span key={`gap-${i}`} className="px-1 text-text-muted">
                …
              </span>
            ) : (
              <button
                key={n}
                type="button"
                onClick={() => setPage(n)}
                aria-label={`Page ${n}`}
                aria-current={n === safePage ? 'page' : undefined}
                className={`min-w-8 px-2 py-1 rounded text-sm ${
                  n === safePage
                    ? 'bg-accent-primary text-white'
                    : 'text-text-muted hover:text-text-primary hover:bg-bg-hover'
                }`}
              >
                {n}
              </button>
            )
          )}
          <button
            type="button"
            onClick={() => setPage(p => Math.min(totalPages, Math.min(p, totalPages) + 1))}
            disabled={safePage === totalPages}
            className="px-2 py-1 rounded text-sm text-text-muted hover:text-text-primary disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Next
          </button>
        </nav>
      )}
    </div>
  );
}
