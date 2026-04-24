import { Link } from 'react-router-dom';

interface ClaimEmailStepProps {
  email: string;
  setEmail: (email: string) => void;
  loading: boolean;
  onSubmit: (e: React.FormEvent) => void;
}

export function ClaimEmailStep({ email, setEmail, loading, onSubmit }: ClaimEmailStepProps) {
  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div>
        <label htmlFor="email" className="block text-sm font-medium mb-1">
          Your email address
        </label>
        <input
          id="email"
          type="email"
          required
          value={email}
          onChange={e => setEmail(e.target.value)}
          placeholder="artist@example.com"
          className="w-full px-3 py-2 rounded-lg bg-bg-secondary border border-border text-text-primary placeholder-text-muted focus:outline-none focus:border-accent-primary"
        />
      </div>
      <button
        type="submit"
        disabled={loading}
        className="w-full py-2 rounded-lg bg-accent-primary text-white font-medium hover:bg-accent-primary/90 transition-colors disabled:opacity-50"
      >
        {loading ? 'Sending...' : 'Send sign-in link'}
      </button>
      <p className="text-xs text-text-muted text-center">
        By clicking you accept Unstream's{' '}
        <Link to="/privacy-policy" className="text-accent-primary hover:underline">Privacy Policy</Link>
      </p>
    </form>
  );
}
