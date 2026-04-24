interface ClaimVerifyStepProps {
  verifyUrl: string;
  loading: boolean;
  onVerify: () => void;
  onRequestManualReview: () => void;
}

export function ClaimVerifyStep({ verifyUrl, loading, onVerify, onRequestManualReview }: ClaimVerifyStepProps) {
  return (
    <div className="space-y-4">
      <div className="p-4 rounded-lg bg-bg-secondary border border-border space-y-3">
        <p className="text-sm font-medium">
          Add this link to your website:
        </p>
        <div className="flex items-center gap-2">
          <code className="flex-1 px-3 py-2 rounded bg-bg-primary border border-border text-sm text-accent-primary break-all">
            {verifyUrl}
          </code>
          <button
            onClick={() => navigator.clipboard.writeText(verifyUrl)}
            className="flex-shrink-0 px-3 py-2 rounded-lg bg-bg-primary border border-border text-sm hover:bg-bg-secondary transition-colors"
            title="Copy URL"
          >
            Copy
          </button>
        </div>
        <p className="text-xs text-text-muted">
          Add a link anywhere on your website that points to the URL above.
          This proves you own the website. You can remove it after verification.
        </p>
      </div>
      <button
        onClick={onVerify}
        disabled={loading}
        className="w-full py-2 rounded-lg bg-accent-primary text-white font-medium hover:bg-accent-primary/90 transition-colors disabled:opacity-50"
      >
        {loading ? 'Checking your website...' : 'Verify my website'}
      </button>

      <div className="text-center pt-2">
        <button
          onClick={onRequestManualReview}
          className="text-sm text-text-muted hover:text-accent-primary transition-colors"
        >
          Having trouble? Request manual verification
        </button>
      </div>
    </div>
  );
}
