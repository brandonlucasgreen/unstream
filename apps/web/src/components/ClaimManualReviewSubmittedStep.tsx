import { Link } from 'react-router-dom';

interface ClaimManualReviewSubmittedStepProps {
  slug: string | undefined;
  email: string;
}

export function ClaimManualReviewSubmittedStep({ slug, email }: ClaimManualReviewSubmittedStepProps) {
  return (
    <div className="text-center space-y-4 p-6 rounded-lg bg-bg-secondary border border-border">
      <div className="text-3xl">📋</div>
      <p className="text-xl font-bold">Request submitted</p>
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
