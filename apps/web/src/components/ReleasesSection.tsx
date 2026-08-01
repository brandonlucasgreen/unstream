import { cheapestOfferSummary, formatReleaseDate } from '../../../../api/shared/release-display';
import type { ArtistPagePayload } from '../types/artist-page';

type Release = NonNullable<ArtistPagePayload['releases']>[number];

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
  if (releases.length === 0) return null;

  return (
    <div className="mt-6">
      <h2 className="text-xs uppercase tracking-wider text-text-muted mb-3">Releases</h2>
      <div className="grid gap-2">
        {releases.map(release => (
          <ReleaseRow key={release.slug} release={release} artistSlug={artistSlug} />
        ))}
      </div>
      {total > releases.length && (
        <p className="mt-2.5 text-xs text-text-muted">and {total - releases.length} more</p>
      )}
    </div>
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

  const meta = [type, date, cheapestOfferSummary(release.offers)].filter(Boolean).join(' · ');

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
