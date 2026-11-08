import type { ReactNode } from 'react';
import { leadingOfferSummary, orderedSourcePlatforms, formatReleaseDate } from '../../../../api/shared/release-display';
import { PLATFORMS } from '../../../../api/shared/platform-registry';
import { PlatformIcon } from './PlatformIcon';
import type { SourceId } from '../types';

/** One row of either list returned by `/api/me/recent-releases`. */
export interface RecentRelease {
  artistName: string;
  artistSlug: string;
  title: string;
  releaseSlug: string;
  releaseDate: string;
  datePrecision: string | null;
  artworkUrl: string | null;
  sources: Array<{
    platform: string;
    offers: Array<{ price: number | null; currency: string | null; availability: string }>;
  }>;
}

/**
 * The "Releases" section of /my-collection: what the artists you saved have announced, and what
 * they've just put out.
 *
 * **One section, two subheadings.** The window for the lists (past 30 days plus everything
 * upcoming) is `getFeedReleasesForUser`'s, deliberately — the private feed and the page disagreeing
 * about what counts as recent would read as a bug in whichever one you happened to be looking at —
 * but an album that isn't out yet is not a *recent release*, so the two are headed apart. Upcoming
 * leads, because it is the news; the server sends the two lists already split and capped
 * separately.
 *
 * Only the subheadings with something under them render. When neither list has anything, one box
 * says so rather than two boxes explaining the same silence.
 *
 * Presentational — the page fetches. It says nothing about the release calendar on
 * /my-saved-artists: the calendar follows saved artists, not the collection, so the two are kept
 * apart on purpose (Brandon, 2026-11-08).
 *
 * **Release rows are plain `<a>`, never react-router `<Link>`**, for the same reason as
 * `ReleasesSection`: `/a/{artist}/{release}` is rendered by the `release-page` edge function and
 * the SPA has no route for a two-segment `/a/` path, so a client-side navigation there renders
 * nothing.
 */
export function RecentReleasesSection({
  upcoming,
  recent,
  error,
}: {
  upcoming: RecentRelease[];
  recent: RecentRelease[];
  error?: string | null;
}) {
  const lists = [
    { title: 'Upcoming', releases: upcoming },
    { title: 'Recent', releases: recent },
  ].filter(list => list.releases.length > 0);

  return (
    <section>
      <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
        <svg className="w-5 h-5 text-link" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM21 16c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2z" />
        </svg>
        Releases
      </h2>

      <div className="space-y-6">
        {error && <p className="text-sm text-text-muted">{error}</p>}

        {!error && lists.length === 0 && (
          /*
            Said rather than hidden. Most fans will have saved artists with nothing out this month,
            and an empty section that vanishes reads as a feature that isn't working — where the
            sentence explains both the window and that we are in fact watching. The page only
            renders this at all once the fan has saved somebody, so there is no case where this box
            greets someone with nothing to say.
          */
          <div className="text-center py-10 rounded-lg border border-border border-dashed">
            <p className="text-text-muted">Nothing new from your saved artists this month.</p>
            <p className="text-text-muted text-sm mt-1">
              Releases from the past 30 days and anything already announced will show up here.
            </p>
          </div>
        )}

        {lists.map(list => (
          <div key={list.title}>
            <Subheading>{list.title}</Subheading>
            <div className="grid gap-2 sm:grid-cols-2">
              {list.releases.map(release => (
                <ReleaseRow key={`${release.artistSlug}/${release.releaseSlug}`} release={release} />
              ))}
            </div>
          </div>
        ))}

      </div>
    </section>
  );
}

/** One list inside the Releases section — smaller than the section's own heading, same for each. */
function Subheading({ children }: { children: ReactNode }) {
  return (
    <h3 className="text-sm font-semibold text-text-secondary mb-3 flex items-center gap-1.5">
      {children}
    </h3>
  );
}

function ReleaseRow({ release }: { release: RecentRelease }) {
  const date = formatReleaseDate(release.releaseDate, release.datePrecision);

  // leadingOfferSummary, not the globally cheapest price: once a release has more than one
  // source, picking the absolute cheapest could rank a Discogs secondhand copy above a Bandcamp
  // direct purchase — see the function's own doc for why that's off-mission.
  const meta = [date, leadingOfferSummary(release.sources)].filter(Boolean).join(' · ');

  // Ordered the same artist-paying-first way as the summary above and the release page itself,
  // so the platform a fan sees leading the row is also the one the price came from.
  const platforms = orderedSourcePlatforms(release.sources);

  // No per-row "Coming" badge: it existed to stop an unreleased album disappearing into a list
  // that otherwise read as history, and the heading above it now says that for the whole section.

  // `min-w-0` on the row belongs on the grid item itself, not only on the text column inside it:
  // a grid item's automatic minimum size is its content, so without it the single-column layout
  // at phone widths sizes its track to the longest meta line — measured at 636px inside a 375px
  // viewport — and the whole page scrolls sideways.
  return (
    <a
      href={`/a/${encodeURIComponent(release.artistSlug)}/${encodeURIComponent(release.releaseSlug)}`}
      className="flex items-center gap-3 p-3 min-w-0 rounded-lg bg-bg-secondary border border-border hover:border-border-hover transition-colors"
    >
      {release.artworkUrl ? (
        <img
          src={release.artworkUrl}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          className="w-14 h-14 rounded-md object-cover shrink-0 bg-bg-hover"
        />
      ) : (
        <div className="w-14 h-14 rounded-md shrink-0 bg-bg-hover flex items-center justify-center text-2xl">
          💿
        </div>
      )}

      <span className="flex-1 min-w-0">
        <span className="block font-medium text-text-primary truncate">{release.title}</span>
        <span className="block text-sm text-text-muted truncate">{release.artistName}</span>
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
    </a>
  );
}
