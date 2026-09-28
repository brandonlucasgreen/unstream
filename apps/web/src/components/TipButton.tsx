import { Link } from 'react-router-dom';

// The Tip button (docs/specs/artist-patronage-spec.md §3.1): a link to /tip/{slug}, where hosted
// Stripe Checkout on the artist's own account takes over. Rendered only for an artist taking tips.

export function TipButton({ slug, artistName }: { slug: string; artistName: string }) {
  return (
    <Link
      to={`/tip/${slug}`}
      onClick={e => e.stopPropagation()}
      className="inline-flex items-center gap-1.5 min-h-11 px-3 py-2 rounded-lg border border-accent-primary bg-accent-primary text-white text-sm hover:bg-accent-primary/90 transition-colors"
    >
      <span aria-hidden="true">♥</span>
      Tip {artistName}
    </Link>
  );
}
