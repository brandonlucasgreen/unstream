import { Link } from 'react-router-dom';
import { MacAppPromo } from './MacAppPromo';

interface NotFoundCardProps {
  slug?: string;
}

export function NotFoundCard({ slug }: NotFoundCardProps) {
  return (
    <div className="text-center py-16">
      <p className="text-text-primary text-xl font-semibold mb-2">We couldn't find that artist</p>
      {slug && (
        <p className="text-text-muted text-sm mb-6">
          No profile found for "{slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}"
        </p>
      )}
      <Link
        to="/artists"
        className="inline-flex items-center gap-1 text-sm text-accent-primary hover:underline"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
        </svg>
        Browse artists
      </Link>
      <div className="mt-10">
        <MacAppPromo />
      </div>
    </div>
  );
}