import { useState, useEffect } from 'react';
import { Link, useParams } from 'react-router-dom';
import { signInWithMagicLink, getSession, getSupabaseClient } from '../services/auth';

type ClaimStep = 'email' | 'check-email' | 'website' | 'verify' | 'done';

export function ClaimPage() {
  const { slug } = useParams<{ slug: string }>();
  const [step, setStep] = useState<ClaimStep>('email');
  const [email, setEmail] = useState('');
  const [websiteUrl, setWebsiteUrl] = useState('');
  const [verifyUrl, setVerifyUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [artistName, setArtistName] = useState('');
  const [discoveredLinks, setDiscoveredLinks] = useState(0);

  const displayName = artistName || slug?.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) || '';

  // Check if user is already authenticated (returning from magic link)
  useEffect(() => {
    async function checkAuth() {
      // Handle the auth callback hash from magic link
      const supabase = getSupabaseClient();
      if (!supabase) return;

      // Check for hash params from magic link redirect
      if (window.location.hash.includes('access_token')) {
        const { data, error } = await supabase.auth.getSession();
        if (!error && data.session) {
          setAuthenticated(true);
          setStep('website');
          return;
        }
      }

      const session = await getSession();
      if (session) {
        setAuthenticated(true);
        setStep('website');
      }
    }
    checkAuth();
  }, []);

  // Fetch artist info
  useEffect(() => {
    if (!slug) return;
    fetch(`/api/artist?slug=${encodeURIComponent(slug)}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data?.name) setArtistName(data.name);
        // Pre-fill website if we have one from MusicBrainz
        const officialSite = data?.platforms?.find(
          (p: { sourceId: string }) => p.sourceId === 'officialsite'
        );
        if (officialSite?.url) setWebsiteUrl(officialSite.url);
      })
      .catch(() => {});
  }, [slug]);

  async function getAuthToken(): Promise<string | null> {
    const session = await getSession();
    return session?.access_token ?? null;
  }

  async function handleSendMagicLink(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const redirectTo = `${window.location.origin}/claim/${slug}`;
    const { error } = await signInWithMagicLink(email, redirectTo);

    setLoading(false);
    if (error) {
      setError(error);
    } else {
      setStep('check-email');
    }
  }

  async function handleStartClaim(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const token = await getAuthToken();
    if (!token) {
      setError('Session expired. Please sign in again.');
      setStep('email');
      setLoading(false);
      return;
    }

    try {
      const response = await fetch('/api/claim', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ action: 'start', slug, websiteUrl }),
      });

      const data = await response.json();
      if (!response.ok) {
        setError(data.error || 'Failed to start claim');
        setLoading(false);
        return;
      }

      setVerifyUrl(data.verifyUrl);
      setStep('verify');
    } catch {
      setError('Network error. Please try again.');
    }
    setLoading(false);
  }

  async function handleVerify() {
    setError(null);
    setLoading(true);

    const token = await getAuthToken();
    if (!token) {
      setError('Session expired. Please sign in again.');
      setStep('email');
      setLoading(false);
      return;
    }

    try {
      const response = await fetch('/api/claim', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ action: 'verify', slug }),
      });

      const data = await response.json();
      if (!response.ok || !data.verified) {
        setError(data.error || 'Verification failed');
        setLoading(false);
        return;
      }

      setDiscoveredLinks(data.discoveredLinks || 0);
      setStep('done');
    } catch {
      setError('Network error. Please try again.');
    }
    setLoading(false);
  }

  return (
    <div className="min-h-screen bg-bg-primary text-text-primary flex flex-col">
      <header className="p-4 border-b border-border-primary">
        <Link to="/" className="text-xl font-bold text-accent-primary hover:opacity-80 transition-opacity">
          Unstream
        </Link>
      </header>

      <main className="flex-1 flex items-center justify-center p-6">
        <div className="w-full max-w-md space-y-6">
          <div className="text-center space-y-2">
            <h1 className="text-2xl font-bold">Claim {displayName}</h1>
            <p className="text-text-muted text-sm">
              Verify your identity to get a permanent artist page on Unstream.
            </p>
          </div>

          {/* Step indicator */}
          <div className="flex items-center justify-center gap-2 text-xs text-text-muted">
            <span className={step === 'email' || step === 'check-email' ? 'text-accent-primary font-medium' : authenticated ? 'text-green-400' : ''}>
              1. Sign in
            </span>
            <span>{'>'}</span>
            <span className={step === 'website' ? 'text-accent-primary font-medium' : step === 'verify' || step === 'done' ? 'text-green-400' : ''}>
              2. Your website
            </span>
            <span>{'>'}</span>
            <span className={step === 'verify' ? 'text-accent-primary font-medium' : step === 'done' ? 'text-green-400' : ''}>
              3. Verify
            </span>
          </div>

          {error && (
            <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
              {error}
            </div>
          )}

          {/* Step 1: Email */}
          {step === 'email' && (
            <form onSubmit={handleSendMagicLink} className="space-y-4">
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
                  className="w-full px-3 py-2 rounded-lg bg-bg-secondary border border-border-primary text-text-primary placeholder-text-muted focus:outline-none focus:border-accent-primary"
                />
              </div>
              <button
                type="submit"
                disabled={loading}
                className="w-full py-2 rounded-lg bg-accent-primary text-white font-medium hover:bg-accent-primary/90 transition-colors disabled:opacity-50"
              >
                {loading ? 'Sending...' : 'Send sign-in link'}
              </button>
            </form>
          )}

          {/* Step 1b: Check email */}
          {step === 'check-email' && (
            <div className="text-center space-y-4 p-6 rounded-lg bg-bg-secondary border border-border-primary">
              <div className="text-3xl">📧</div>
              <p className="font-medium">Check your email</p>
              <p className="text-sm text-text-muted">
                We sent a sign-in link to <strong className="text-text-primary">{email}</strong>.
                Click the link to continue claiming your profile.
              </p>
            </div>
          )}

          {/* Step 2: Website URL */}
          {step === 'website' && (
            <form onSubmit={handleStartClaim} className="space-y-4">
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
                  className="w-full px-3 py-2 rounded-lg bg-bg-secondary border border-border-primary text-text-primary placeholder-text-muted focus:outline-none focus:border-accent-primary"
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
          )}

          {/* Step 3: Verify link-back */}
          {step === 'verify' && (
            <div className="space-y-4">
              <div className="p-4 rounded-lg bg-bg-secondary border border-border-primary space-y-3">
                <p className="text-sm font-medium">
                  Add this link to your website:
                </p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 px-3 py-2 rounded bg-bg-primary border border-border-primary text-sm text-accent-primary break-all">
                    {verifyUrl}
                  </code>
                  <button
                    onClick={() => navigator.clipboard.writeText(verifyUrl)}
                    className="flex-shrink-0 px-3 py-2 rounded-lg bg-bg-primary border border-border-primary text-sm hover:bg-bg-secondary transition-colors"
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
                onClick={handleVerify}
                disabled={loading}
                className="w-full py-2 rounded-lg bg-accent-primary text-white font-medium hover:bg-accent-primary/90 transition-colors disabled:opacity-50"
              >
                {loading ? 'Checking your website...' : 'Verify my website'}
              </button>
            </div>
          )}

          {/* Step 4: Done */}
          {step === 'done' && (
            <div className="text-center space-y-4 p-6 rounded-lg bg-bg-secondary border border-border-primary">
              <div className="text-3xl">✅</div>
              <p className="text-xl font-bold">Profile claimed!</p>
              <p className="text-sm text-text-muted">
                Your artist page is now live. We found {discoveredLinks} platform
                {discoveredLinks === 1 ? ' link' : ' links'} from your website.
              </p>
              <Link
                to={`/a/${slug}`}
                className="inline-block px-6 py-2 rounded-lg bg-accent-primary text-white font-medium hover:bg-accent-primary/90 transition-colors"
              >
                View your artist page
              </Link>
            </div>
          )}
        </div>
      </main>

      <footer className="p-4 text-center text-xs text-text-muted border-t border-border-primary">
        <Link to="/" className="hover:text-text-primary transition-colors">Unstream</Link>
        {' · '}
        <Link to="/privacy-policy" className="hover:text-text-primary transition-colors">Privacy</Link>
      </footer>
    </div>
  );
}
