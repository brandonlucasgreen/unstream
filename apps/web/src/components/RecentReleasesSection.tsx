import { useState, type ReactNode } from 'react';
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
 * What the fans' half of the dashboard was missing: what the artists you saved have put out.
 *
 * Release alerts have only ever existed in the Mac app and the browser extension, and the private
 * release feed shipped with its only entry point buried on /settings — where, in the months it
 * has been live, not one fan ever minted a token. This is the web's first fan-facing release
 * surface, and the natural home for that subscribe control.
 *
 * **Two sections, not one.** The window (past 30 days plus everything upcoming) is
 * `getFeedReleasesForUser`'s, deliberately — the feed and the dashboard disagreeing about what
 * counts as recent would read as a bug in whichever one you happened to be looking at — but an
 * album that isn't out yet is not a *recent release*, and a heading that said so was wrong on its
 * own terms. Upcoming leads, because it is the news; the server sends the two lists already split
 * and capped separately.
 *
 * Only the sections with something in them render. When neither does, one box says so under the
 * "Recent Releases" heading rather than two boxes explaining the same silence.
 *
 * Presentational — the page fetches, and hands the auth-dependent subscribe panel in as a prop.
 *
 * **Rows are plain `<a>`, never react-router `<Link>`**, for the same reason as `ReleasesSection`:
 * `/a/{artist}/{release}` is rendered by the `release-page` edge function and the SPA has no
 * route for a two-segment `/a/` path, so a client-side navigation there renders nothing.
 */
export function RecentReleasesSection({
  upcoming,
  recent,
  subscribePanel,
  error,
}: {
  upcoming: RecentRelease[];
  recent: RecentRelease[];
  subscribePanel: ReactNode;
  error?: string | null;
}) {
  const [showSubscribe, setShowSubscribe] = useState(false);

  /*
    One control for the pair, not one per section: both lists come out of the same feed token, so
    a second button would be a second treatment for one action. It rides whichever heading comes
    first, so it always sits at the top of the block.
  */
  const subscribeControl = (
    <SubscribeToggle open={showSubscribe} onToggle={() => setShowSubscribe(v => !v)} />
  );
  const revealedPanel = showSubscribe ? (
    <div className="mb-4 p-4 rounded-lg bg-bg-secondary border border-border">{subscribePanel}</div>
  ) : null;

  const groups = [
    { title: 'Upcoming Releases', releases: upcoming },
    { title: 'Recent Releases', releases: recent },
  ].filter(group => group.releases.length > 0);

  if (error || groups.length === 0) {
    return (
      <section>
        <SectionHeading title="Recent Releases" action={subscribeControl} />
        {revealedPanel}
        {error ? (
          <p className="text-sm text-text-muted">{error}</p>
        ) : (
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
      </section>
    );
  }

  return (
    <div className="space-y-8">
      {groups.map((group, index) => (
        <section key={group.title}>
          <SectionHeading title={group.title} action={index === 0 ? subscribeControl : null} />
          {index === 0 && revealedPanel}
          <div className="grid gap-2 sm:grid-cols-2">
            {group.releases.map(release => (
              <ReleaseRow key={`${release.artistSlug}/${release.releaseSlug}`} release={release} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

/** The dashboard's section heading treatment, shared so both headings match exactly. */
function SectionHeading({ title, action }: { title: string; action: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 mb-4">
      <h2 className="text-lg font-semibold flex items-center gap-2">
        <svg className="w-5 h-5 text-accent-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM21 16c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2z" />
        </svg>
        {title}
      </h2>
      {action}
    </div>
  );
}

/**
 * Two formats, one action: the calendar and the RSS marks both come from the same feed token, so
 * a pair of buttons that did the same thing would be two treatments for one action. The marks stay
 * side by side and stroked at the same weight — the artist page's heading treatment — because that
 * pairing is what reads as "subscribe" without a word of explanation.
 *
 * A button rather than a link, unlike the artist page's, because a fan's feed URL contains a
 * credential that doesn't exist until they ask for one. Pressing this only reveals the panel;
 * minting still takes the explicit press inside it.
 */
function SubscribeToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-label="Subscribe to these releases in a calendar app or RSS reader"
      title="Subscribe in a calendar app or RSS reader"
      className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border transition-colors shrink-0 ${
        open
          ? 'border-accent-primary/40 text-accent-primary bg-accent-primary/10'
          : 'border-border text-text-muted hover:text-text-primary hover:border-border-hover'
      }`}
    >
      <CalendarIcon />
      <RssIcon />
    </button>
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

/**
 * The same pair as `ReleasesSection`'s heading, drawn as strokes at the same weight so they read
 * as one control rather than two icons from different sets.
 *
 * `aria-hidden` because the button around them already carries the accessible name.
 */
function CalendarIcon() {
  return (
    <svg
      className="w-3.5 h-3.5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </svg>
  );
}

function RssIcon() {
  return (
    <svg
      className="w-3.5 h-3.5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 11a9 9 0 019 9M4 4a16 16 0 0116 16" />
      <circle cx="5" cy="19" r="1.5" fill="currentColor" stroke="none" />
    </svg>
  );
}
