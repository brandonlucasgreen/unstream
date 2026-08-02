import { useState, type ReactNode } from 'react';
import { leadingOfferSummary, orderedSourcePlatforms, formatReleaseDate } from '../../../../api/shared/release-display';
import { PLATFORMS } from '../../../../api/shared/platform-registry';
import { PlatformIcon } from './PlatformIcon';
import type { ArtistPagePayload } from '../types/artist-page';
import type { SourceId } from '../types';

type Release = NonNullable<ArtistPagePayload['releases']>[number];

/** Releases per page. Two columns of five. */
const PAGE_SIZE = 10;

/**
 * An artist's releases, each linking to its buying guide at `/a/{artist}/{release}`.
 *
 * Placed below Follow: Support directly and Follow together form the links region whose order
 * the artist controls with dividers, and releases are a different kind of thing that shouldn't
 * interrupt that ordering.
 *
 * Renders nothing when there are no releases. An empty "Releases" heading reads as broken, while
 * its absence reads as "nothing here yet" — the truth for any artist nobody has saved or
 * searched, since cataloguing is demand-driven.
 *
 * The formatting helpers come from `api/shared/release-display.ts`, which the crawler-side edge
 * renderer also uses, so the two can't drift on what a price or a partial date looks like.
 *
 * **Rows are plain `<a>`, never react-router `<Link>`.** `/a/{artist}/{release}` is rendered by
 * the `release-page` edge function and by nothing else — the SPA has no route for a two-segment
 * `/a/` path, and there is no catch-all `<Route>`, so a client-side navigation there matches
 * nothing and renders a blank page. It also strands history: the URL changes, React renders
 * nothing, and Back has nowhere sensible to go. A real navigation reaches the one renderer that
 * exists, which is also what makes an in-app click and a pasted link produce the same page.
 *
 * Paginated ten at a time in two columns, so a long discography stays one glance rather than a
 * scroll past the platform links this page exists to show.
 */
export function ReleasesSection({
  releases,
  total,
  artistSlug,
}: {
  releases: Release[];
  total: number;
  artistSlug: string;
}) {
  const [page, setPage] = useState(0);

  if (releases.length === 0) return null;

  // Paged over what the payload already carries rather than fetched a page at a time: the whole
  // list arrives with the page, so turning a page is instant and costs no request. `total` can
  // still exceed it for an unusually large catalogue, which the note below reports honestly
  // instead of pretending the last page is the end of the discography.
  const pageCount = Math.ceil(releases.length / PAGE_SIZE);
  const current = Math.min(page, pageCount - 1);
  const shown = releases.slice(current * PAGE_SIZE, current * PAGE_SIZE + PAGE_SIZE);

  return (
    <div className="mt-6">
      <h2 className="text-xs uppercase tracking-wider text-text-muted mb-3">Releases</h2>
      <div className="grid gap-2 sm:grid-cols-2">
        {shown.map(release => (
          <ReleaseRow key={release.slug} release={release} artistSlug={artistSlug} />
        ))}
      </div>

      {pageCount > 1 && (
        <nav className="mt-3 flex items-center justify-center gap-3" aria-label="Releases pages">
          <PageButton onClick={() => setPage(current - 1)} disabled={current === 0}>
            ← Previous
          </PageButton>
          <span className="text-xs text-text-muted" aria-live="polite">
            Page {current + 1} of {pageCount}
          </span>
          <PageButton onClick={() => setPage(current + 1)} disabled={current === pageCount - 1}>
            Next →
          </PageButton>
        </nav>
      )}

      {total > releases.length && (
        <p className="mt-2.5 text-center text-xs text-text-muted">and {total - releases.length} more</p>
      )}

      {/*
        The per-artist feeds had no entry point anywhere in the app — they worked, but the only
        way to find one was to already know the URL. This is the natural place: it sits with the
        releases it describes, and only renders when there are releases to follow.

        Plain <a> rather than react-router <Link>: these are not SPA routes. They are served by
        a Netlify function, so a client-side navigation would try to render them in-app and fail.
      */}
      <p className="mt-3 text-center text-xs text-text-muted">
        Follow for new releases:{' '}
        <a
          href={`/a/${encodeURIComponent(artistSlug)}/releases.ics`}
          className="text-accent-primary hover:underline"
          title="Subscribe in Apple Calendar, Google Calendar or another calendar app"
        >
          ICS
        </a>
        {' · '}
        <a
          href={`/a/${encodeURIComponent(artistSlug)}/releases.xml`}
          className="text-accent-primary hover:underline"
          title="Subscribe in an RSS reader"
        >
          XML
        </a>
      </p>
    </div>
  );
}

function PageButton({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="px-3 py-1.5 rounded-lg border border-border text-xs text-text-primary hover:bg-bg-hover transition-colors disabled:opacity-40 disabled:cursor-default disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}

function ReleaseRow({ release, artistSlug }: { release: Release; artistSlug: string }) {
  const date = formatReleaseDate(release.releaseDate, release.datePrecision);

  // Capitalised here rather than with a `capitalize` class, which would apply to the whole line
  // and turn "from $7" into "From $7" and "Name your price" into "Name Your Price".
  const type =
    release.releaseType === 'other'
      ? ''
      : release.releaseType.charAt(0).toUpperCase() + release.releaseType.slice(1);

  // leadingOfferSummary, not the globally cheapest price: once a release has more than one
  // source, picking the absolute cheapest could rank a Discogs secondhand copy above a
  // Bandcamp direct purchase — see the function's own doc for why that's off-mission.
  const meta = [type, date, leadingOfferSummary(release.sources)].filter(Boolean).join(' · ');

  // Ordered the same artist-paying-first way as the summary above and the release page
  // itself, so the platform a fan sees leading the row is also the one the price came from.
  const platforms = orderedSourcePlatforms(release.sources);

  return (
    <a
      href={`/a/${encodeURIComponent(artistSlug)}/${encodeURIComponent(release.slug)}`}
      className="flex items-center gap-3 px-3 py-2 rounded-xl border border-border hover:bg-bg-hover transition-colors"
    >
      {release.artworkUrl ? (
        <img
          src={release.artworkUrl}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          className="w-12 h-12 rounded-md object-cover shrink-0 bg-bg-secondary"
        />
      ) : (
        <div className="w-12 h-12 rounded-md shrink-0 bg-bg-secondary flex items-center justify-center text-xl">
          💿
        </div>
      )}

      <span className="flex-1 min-w-0">
        <span className="block font-medium text-text-primary truncate">{release.title}</span>
        {meta && <span className="block text-xs text-text-muted">{meta}</span>}
        {platforms.length > 0 && (
          <span className="flex items-center gap-1 mt-1">
            {/* Icons alone don't convey the platform names to a screen reader; the text below
                does, and is visually hidden since the meta line above already carries the
                price/payout for the leading one. */}
            <span className="sr-only">
              Available on {platforms.map(p => PLATFORMS[p]?.name ?? p).join(', ')}
            </span>
            <span aria-hidden="true" className="flex items-center gap-1">
              {platforms.map(p => (
                <PlatformIcon
                  key={p}
                  sourceId={p as SourceId}
                  color={PLATFORMS[p]?.color ?? '#888'}
                  emoji={PLATFORMS[p]?.icon ?? '🔗'}
                  className="w-3.5 h-3.5"
                />
              ))}
            </span>
          </span>
        )}
      </span>

      {/* An upcoming release is the most interesting row here and the easiest to miss at the top
          of a list that otherwise reads as history. */}
      {release.status === 'announced' && (
        <span className="text-[10px] font-bold uppercase tracking-wide text-accent-primary shrink-0">
          Coming
        </span>
      )}
    </a>
  );
}
