interface ClaimDoneStepProps {
  slug: string | undefined;
  discoveredLinks: number;
  alreadyVerified?: boolean;
}

export function ClaimDoneStep({ slug, discoveredLinks, alreadyVerified }: ClaimDoneStepProps) {
  return (
    <div className="text-center space-y-4 p-6 rounded-lg bg-bg-secondary border border-border">
      <div className="text-3xl">✅</div>
      <p className="text-xl font-bold">Profile claimed!</p>
      {alreadyVerified ? (
        <p className="text-sm text-text-muted">
          Your artist page is already live and verified. You can edit your profile from your dashboard.
        </p>
      ) : (
        <p className="text-sm text-text-muted">
          Your artist page is now live. We found {discoveredLinks} platform
          {discoveredLinks === 1 ? ' link' : ' links'} from your website.
        </p>
      )}
      <a
        href={`/a/${slug}?claimed`}
        className="inline-block px-6 py-2 rounded-lg bg-accent-primary text-white font-medium hover:bg-accent-primary/90 transition-colors"
      >
        View your artist page
      </a>
    </div>
  );
}
