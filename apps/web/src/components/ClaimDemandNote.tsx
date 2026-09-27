import { useEffect, useState } from 'react';
import type { ArtistPagePayload } from '../types/artist-page';
import { formatCityCounts } from '../../../../api/shared/artist-interest';

// "14 fans want to tip you" on the claim flow (docs/specs/artist-patronage-spec.md §3.6): the
// reason to finish claiming. Reads the public artist page payload, so it shows only counts that
// already cleared the public threshold, and renders nothing otherwise — including on any error,
// since it's encouragement, not part of the claim.

export function ClaimDemandNote({ slug }: { slug: string }) {
  const [interest, setInterest] = useState<ArtistPagePayload['interest'] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/artist-page?slug=${encodeURIComponent(slug)}`)
      .then(r => (r.ok ? r.json() : null))
      .then((data: ArtistPagePayload | null) => { if (!cancelled) setInterest(data?.interest ?? null); })
      .catch(() => { /* decoration only; the page works without it */ });
    return () => { cancelled = true; };
  }, [slug]);

  if (!interest || (interest.tipCount === 0 && interest.cities.length === 0)) return null;

  return (
    <div className="p-3 rounded-lg bg-accent-primary/10 border border-accent-primary/20 text-sm text-text-primary">
      {interest.tipCount > 0 && <p>{interest.tipCount} fans want to tip you.</p>}
      {interest.cities.length > 0 && <p>Most wanted in: {formatCityCounts(interest.cities)}</p>}
    </div>
  );
}
