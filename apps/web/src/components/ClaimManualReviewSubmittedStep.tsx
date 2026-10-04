import { Link } from 'react-router-dom';

interface ClaimManualReviewSubmittedStepProps {
  slug: string | undefined;
  email: string;
  /** Set when the link-back passed but the website isn't one we hold for the artist. */
  linkBackFound?: boolean;
}

export function ClaimManualReviewSubmittedStep({ slug, email, linkBackFound = false }: ClaimManualReviewSubmittedStepProps) {
  return (
    <div className="text-center space-y-4 p-6 rounded-lg bg-bg-secondary border border-border">
      <div className="text-3xl">📋</div>
      <p className="text-xl font-bold">Request submitted</p>
      {linkBackFound && (
        <p className="text-sm text-text-muted">
          We found the Unstream link on your website. Because it isn't a site we already have on
          record for this artist, a person checks it before your profile goes live. This keeps
          anyone else from claiming your page and swapping in their own links.
        </p>
      )}
      <p className="text-sm text-text-muted">
        Your verification request has been submitted. We'll review it within a few days
        and notify you at <strong className="text-text-primary">{email}</strong>.
      </p>
      <Link
        to={`/a/${slug}`}
        className="inline-block px-6 py-2 rounded-lg bg-bg-primary border border-border text-sm hover:bg-bg-secondary transition-colors"
      >
        View artist page
      </Link>
    </div>
  );
}
