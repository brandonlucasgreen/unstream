interface LoadErrorCardProps {
  /** What failed, said plainly: "We couldn't load this artist." */
  title: string;
  /** Optional second line; defaults to a generic "try again" hint. */
  detail?: string;
  onRetry: () => void;
}

/**
 * A load that failed — network, 5xx, rate limit — as opposed to data that is genuinely
 * missing or empty. Keep the two apart: "we couldn't find that artist" or "0 verified
 * artists" after a failed request tells a fan something false, and they have no reason to
 * try again. `role="alert"` so a screen reader hears it when it replaces a loading state.
 */
export function LoadErrorCard({ title, detail, onRetry }: LoadErrorCardProps) {
  return (
    <div role="alert" className="text-center py-16">
      <p className="text-text-primary text-xl font-semibold mb-2">{title}</p>
      <p className="text-text-muted text-sm mb-6">
        {detail ?? 'This is usually temporary. Check your connection and try again.'}
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="text-sm font-medium text-text-primary underline hover:no-underline"
      >
        Try again
      </button>
    </div>
  );
}
