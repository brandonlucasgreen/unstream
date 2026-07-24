/**
 * Loading primitives shared by every skeleton screen.
 *
 * The visuals live in index.css (`.skeleton`, `.eq-bars`, `.skeleton-fade-in`)
 * so they follow the theme tokens and respect prefers-reduced-motion.
 */

interface SkeletonProps {
  className?: string;
}

/** A single shimmering placeholder block. Size it with Tailwind classes. */
export function Skeleton({ className = '' }: SkeletonProps) {
  return <div className={`skeleton ${className}`} />;
}

/** A round placeholder, for avatars and artist photos. */
export function SkeletonCircle({ className = '' }: SkeletonProps) {
  return <div className={`skeleton rounded-full ${className}`} />;
}

/** A block of placeholder text lines. The last line is short, like real copy. */
export function SkeletonText({ lines = 3, className = '' }: SkeletonProps & { lines?: number }) {
  return (
    <div className={`space-y-2 ${className}`}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className={`h-3 ${i === lines - 1 ? 'w-2/3' : 'w-full'}`} />
      ))}
    </div>
  );
}

/** Four bouncing bars in the Unstream accent colours. */
export function EqualizerBars({ className = '' }: SkeletonProps) {
  return (
    <span className={`eq-bars ${className}`} aria-hidden="true">
      <span />
      <span />
      <span />
      <span />
    </span>
  );
}

/** An inline "still working" line: equalizer bars plus a short message. */
export function LoadingLabel({ children, className = '' }: SkeletonProps & { children: React.ReactNode }) {
  return (
    <p className={`flex items-center gap-2 text-text-muted text-sm ${className}`}>
      <EqualizerBars />
      <span>{children}</span>
    </p>
  );
}

/**
 * Wraps a skeleton screen. Screen readers hear the label instead of walking
 * through a pile of empty boxes, and the whole thing fades in together.
 */
export function SkeletonScreen({
  label,
  className = '',
  children,
}: SkeletonProps & { label: string; children: React.ReactNode }) {
  return (
    <div role="status" aria-busy="true" className={`skeleton-fade-in ${className}`}>
      <span className="sr-only">{label}</span>
      <div aria-hidden="true">{children}</div>
    </div>
  );
}
