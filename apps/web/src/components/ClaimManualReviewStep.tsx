interface ClaimManualReviewStepProps {
  displayName: string;
  manualReviewMessage: string;
  setManualReviewMessage: (message: string) => void;
  manualReviewSubmitting: boolean;
  onSubmit: (e: React.FormEvent) => void;
  onBack: () => void;
}

export function ClaimManualReviewStep({
  displayName,
  manualReviewMessage,
  setManualReviewMessage,
  manualReviewSubmitting,
  onSubmit,
  onBack,
}: ClaimManualReviewStepProps) {
  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="p-4 rounded-lg bg-bg-secondary border border-border space-y-2">
        <p className="text-sm font-medium">Request manual verification</p>
        <p className="text-xs text-text-muted">
          If automated verification isn't working, we can review your request manually.
          Tell us who you are and provide any proof that you're associated with {displayName} --
          links to your profiles on other platforms, social media accounts, etc.
        </p>
      </div>
      <div>
        <label htmlFor="manual-message" className="block text-sm font-medium mb-1">
          Your message
        </label>
        <textarea
          id="manual-message"
          required
          rows={5}
          maxLength={5000}
          value={manualReviewMessage}
          onChange={e => setManualReviewMessage(e.target.value)}
          placeholder={"I'm the artist behind " + displayName + ". Here are my profiles:\n- https://bandcamp.com/...\n- https://instagram.com/..."}
          className="w-full px-3 py-2 rounded-lg bg-bg-secondary border border-border text-text-primary placeholder-text-muted focus:outline-none focus:border-accent-primary text-sm resize-y"
        />
        <p className="text-xs text-text-muted mt-1">
          {manualReviewMessage.length}/5000 characters
        </p>
      </div>
      <button
        type="submit"
        disabled={manualReviewSubmitting || manualReviewMessage.trim().length === 0}
        className="w-full py-2 rounded-lg bg-accent-primary text-white font-medium hover:bg-accent-primary/90 transition-colors disabled:opacity-50"
      >
        {manualReviewSubmitting ? 'Submitting...' : 'Submit verification request'}
      </button>
      <button
        type="button"
        onClick={onBack}
        className="w-full py-2 text-sm text-text-muted hover:text-text-primary transition-colors"
      >
        Back to automated verification
      </button>
    </form>
  );
}
