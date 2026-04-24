interface ClaimWebsiteStepProps {
  websiteUrl: string;
  setWebsiteUrl: (url: string) => void;
  loading: boolean;
  onSubmit: (e: React.FormEvent) => void;
}

export function ClaimWebsiteStep({ websiteUrl, setWebsiteUrl, loading, onSubmit }: ClaimWebsiteStepProps) {
  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div>
        <label htmlFor="website" className="block text-sm font-medium mb-1">
          Your official website or link-in-bio
        </label>
        <input
          id="website"
          type="url"
          required
          value={websiteUrl}
          onChange={e => setWebsiteUrl(e.target.value)}
          placeholder="https://linktr.ee/yourname"
          className="w-full px-3 py-2 rounded-lg bg-bg-secondary border border-border text-text-primary placeholder-text-muted focus:outline-none focus:border-accent-primary"
        />
        <p className="text-xs text-text-muted mt-1">
          This can be your personal website, Linktree, Carrd, or any page you control.
        </p>
      </div>
      <button
        type="submit"
        disabled={loading}
        className="w-full py-2 rounded-lg bg-accent-primary text-white font-medium hover:bg-accent-primary/90 transition-colors disabled:opacity-50"
      >
        {loading ? 'Setting up...' : 'Continue'}
      </button>
    </form>
  );
}
