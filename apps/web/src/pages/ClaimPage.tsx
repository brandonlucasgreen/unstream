import { useState, useEffect } from 'react';
import { Link, useParams } from 'react-router-dom';
import { signInWithMagicLink } from '../services/auth';
import { useAuth } from '../contexts/AuthContext';

import { Header } from '../components/Header';
import { Footer } from '../components/Footer';
import { SocialIcon } from '../components/SocialIcon';
import { sources } from '../services/sources';
import type { SourceId } from '../types';

type ClaimStep = 'email' | 'check-email' | 'website' | 'verify' | 'review' | 'done' | 'manual-review' | 'manual-review-submitted';

interface ReviewLink {
  platform: string;
  url: string;
  checked: boolean;
}

// Platforms that support avatar scraping
const AVATAR_PLATFORMS = new Set(['bandcamp', 'youtube', 'mirlo']);

// Platform name lookup
function platformName(id: string): string {
  const CUSTOM_NAMES: Record<string, string> = {
    officialsite: 'Official Website',
    peertube: 'PeerTube',
    newsletter: 'Newsletter',
    wikipedia: 'Wikipedia',
    liberapay: 'Liberapay',
    other: 'Other',
  };
  if (CUSTOM_NAMES[id]) return CUSTOM_NAMES[id];
  const source = sources[id as SourceId];
  return source?.name || id;
}

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

  // Review step state
  const [reviewLinks, setReviewLinks] = useState<ReviewLink[]>([]);
  const [currentImageUrl, setCurrentImageUrl] = useState<string | null>(null);
  const [customImageUrl, setCustomImageUrl] = useState<string | null>(null);
  const [fetchingAvatar, setFetchingAvatar] = useState<string | null>(null); // platform being fetched

  // Manual review state
  const [manualReviewMessage, setManualReviewMessage] = useState('');
  const [manualReviewSubmitting, setManualReviewSubmitting] = useState(false);

  // Resend cooldown state
  const [resendCooldown, setResendCooldown] = useState(0);

  const { session: authSession, isLoading: authLoading } = useAuth();

  const displayName = artistName || slug?.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) || '';

  // When auth context resolves with a session, advance to website step
  useEffect(() => {
    if (authLoading) return;
    if (authSession && !authenticated) {
      setAuthenticated(true);
      if (authSession.user.email) setEmail(authSession.user.email);
      if (step === 'email' || step === 'check-email') {
        setStep('website');
      }
    }
  }, [authSession, authLoading, authenticated, step]);

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

  function getAuthToken(): string | null {
    return authSession?.access_token ?? null;
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

  async function handleResend() {
    setError(null);
    setLoading(true);
    const redirectTo = `${window.location.origin}/claim/${slug}`;
    const { error } = await signInWithMagicLink(email, redirectTo);
    setLoading(false);
    if (error) {
      setError(error);
    } else {
      setResendCooldown(60);
      const interval = setInterval(() => {
        setResendCooldown(prev => {
          if (prev <= 1) { clearInterval(interval); return 0; }
          return prev - 1;
        });
      }, 1000);
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
        body: JSON.stringify({ action: 'start', slug, websiteUrl, email }),
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

      // Set up the review step with link and image data from verify response
      if (data.allLinks) {
        setReviewLinks(
          data.allLinks.map((l: { platform: string; url: string }) => ({
            platform: l.platform,
            url: l.url,
            checked: true,
          }))
        );
      }
      setCurrentImageUrl(data.imageUrl || null);
      setStep('review');
    } catch {
      setError('Network error. Please try again.');
    }
    setLoading(false);
  }

  async function handleFetchAvatar(platform: string, url: string) {
    setFetchingAvatar(platform);
    setError(null);

    const token = await getAuthToken();
    if (!token) {
      setError('Session expired. Please sign in again.');
      setFetchingAvatar(null);
      return;
    }

    try {
      const response = await fetch('/api/claim', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ action: 'fetch-avatar', platform, url }),
      });

      const data = await response.json();
      if (response.ok && data.imageUrl) {
        setCustomImageUrl(data.imageUrl);
      } else {
        setError(data.error || 'Could not find a profile photo on that page');
      }
    } catch {
      setError('Network error. Please try again.');
    }
    setFetchingAvatar(null);
  }

  async function handleConfirmReview() {
    setError(null);
    setLoading(true);

    const token = await getAuthToken();
    if (!token) {
      setError('Session expired. Please sign in again.');
      setStep('email');
      setLoading(false);
      return;
    }

    const confirmedLinks = reviewLinks
      .filter(l => l.checked && l.url.trim())
      .map(l => ({ platform: l.platform, url: l.url }));

    try {
      const response = await fetch('/api/artist-profile', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          slug,
          links: confirmedLinks,
          ...(customImageUrl ? { customImageUrl } : {}),
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        setError(data.error || 'Failed to save changes');
        setLoading(false);
        return;
      }

      window.location.href = `/a/${data.slug || slug}?claimed`;
    } catch {
      setError('Network error. Please try again.');
    }
    setLoading(false);
  }

  async function handleManualReviewSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setManualReviewSubmitting(true);

    const token = await getAuthToken();
    if (!token) {
      setError('Session expired. Please sign in again.');
      setStep('email');
      setManualReviewSubmitting(false);
      return;
    }

    try {
      const response = await fetch('/api/claim', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          action: 'request-manual-review',
          slug,
          email,
          message: manualReviewMessage,
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        setError(data.error || 'Failed to submit verification request');
        setManualReviewSubmitting(false);
        return;
      }

      setStep('manual-review-submitted');
    } catch {
      setError('Network error. Please try again.');
    }
    setManualReviewSubmitting(false);
  }

  return (
    <div className="min-h-screen bg-bg-primary text-text-primary flex flex-col">

      <Header />

      <main className="flex-1 flex items-center justify-center p-6">
        <div className={`w-full ${step === 'review' ? 'max-w-lg' : 'max-w-md'} space-y-6`}>
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
            <span className={step === 'website' ? 'text-accent-primary font-medium' : ['verify', 'review', 'done'].includes(step) ? 'text-green-400' : ''}>
              2. Website
            </span>
            <span>{'>'}</span>
            <span className={step === 'verify' ? 'text-accent-primary font-medium' : ['review', 'done'].includes(step) ? 'text-green-400' : ''}>
              3. Verify
            </span>
            <span>{'>'}</span>
            <span className={step === 'review' ? 'text-accent-primary font-medium' : step === 'done' ? 'text-green-400' : ''}>
              4. Review
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
          )}

          {/* Step 1b: Check email */}
          {step === 'check-email' && (
            <div className="text-center space-y-4 p-6 rounded-lg bg-bg-secondary border border-border">
              <div className="text-3xl">📧</div>
              <p className="font-medium">Check your email</p>
              <p className="text-sm text-text-muted">
                We sent a sign-in link to <strong className="text-text-primary">{email}</strong>.
                Click the link to continue claiming your profile.
              </p>
              <p className="text-xs text-text-muted">
                Don't see it? Check your spam or junk folder.
                {email.includes('privaterelay.appleid.com') && (
                  <> If you used Apple's Hide My Email, delivery may take a few extra minutes.</>
                )}
              </p>
              <div className="space-y-2">
                <div>
                  <button
                    onClick={handleResend}
                    disabled={resendCooldown > 0 || loading}
                    className="text-sm text-accent-primary hover:underline disabled:opacity-50 disabled:no-underline"
                  >
                    {resendCooldown > 0 ? `Resend in ${resendCooldown}s` : 'Resend email'}
                  </button>
                </div>
                <div>
                  <button
                    onClick={() => { setStep('email'); setEmail(''); setResendCooldown(0); }}
                    className="text-xs text-text-muted hover:text-text-primary underline"
                  >
                    Use a different email
                  </button>
                </div>
              </div>
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
          )}

          {/* Step 3: Verify link-back */}
          {step === 'verify' && (
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
                onClick={handleVerify}
                disabled={loading}
                className="w-full py-2 rounded-lg bg-accent-primary text-white font-medium hover:bg-accent-primary/90 transition-colors disabled:opacity-50"
              >
                {loading ? 'Checking your website...' : 'Verify my website'}
              </button>

              <div className="text-center pt-2">
                <button
                  onClick={() => { setError(null); setStep('manual-review'); }}
                  className="text-sm text-text-muted hover:text-accent-primary transition-colors"
                >
                  Having trouble? Request manual verification
                </button>
              </div>
            </div>
          )}

          {/* Manual review request */}
          {step === 'manual-review' && (
            <form onSubmit={handleManualReviewSubmit} className="space-y-4">
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
                onClick={() => { setError(null); setStep('verify'); }}
                className="w-full py-2 text-sm text-text-muted hover:text-text-primary transition-colors"
              >
                Back to automated verification
              </button>
            </form>
          )}

          {/* Manual review submitted */}
          {step === 'manual-review-submitted' && (
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
          )}

          {/* Step 4: Review links & photo */}
          {step === 'review' && (
            <div className="space-y-6">
              <div className="text-center space-y-1">
                <p className="text-lg font-bold">Review your profile</p>
                <p className="text-sm text-text-muted">
                  We found {discoveredLinks} link{discoveredLinks === 1 ? '' : 's'} from your website.
                  Uncheck any that don't belong to you, then confirm.
                </p>
              </div>

              {/* Photo section */}
              <section className="space-y-3">
                <h2 className="text-sm font-medium">Profile Photo</h2>
                <div className="flex items-start gap-4">
                  <div className="w-20 h-20 rounded-full bg-bg-secondary border border-border flex items-center justify-center overflow-hidden flex-shrink-0">
                    {(customImageUrl || currentImageUrl) ? (
                      <img
                        src={customImageUrl || currentImageUrl || ''}
                        alt={displayName}
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <span className="text-2xl text-text-muted">
                        {displayName.charAt(0).toUpperCase()}
                      </span>
                    )}
                  </div>
                  <div className="flex-1 space-y-2">
                    {customImageUrl ? (
                      <div className="flex items-center gap-2">
                        <span className="text-sm text-green-400">New photo selected</span>
                        <button
                          onClick={() => setCustomImageUrl(null)}
                          className="text-xs text-text-muted hover:text-text-primary"
                        >
                          Undo
                        </button>
                      </div>
                    ) : currentImageUrl ? (
                      <p className="text-sm text-text-muted">
                        This photo was auto-discovered. If it's wrong, pull a new one from one of your platforms:
                      </p>
                    ) : (
                      <p className="text-sm text-text-muted">
                        No photo found. Pull one from a platform:
                      </p>
                    )}
                    {!customImageUrl && (
                      <div className="flex flex-wrap gap-2">
                        {reviewLinks
                          .filter(l => l.checked && AVATAR_PLATFORMS.has(l.platform))
                          .map(l => (
                            <button
                              key={l.platform}
                              onClick={() => handleFetchAvatar(l.platform, l.url)}
                              disabled={fetchingAvatar !== null}
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-bg-secondary border border-border text-sm hover:border-accent-primary transition-colors disabled:opacity-50"
                            >
                              <SocialIcon platform={l.platform} className="w-3.5 h-3.5" />
                              {fetchingAvatar === l.platform ? 'Loading...' : `Use ${platformName(l.platform)} photo`}
                            </button>
                          ))}
                        {reviewLinks.filter(l => l.checked && AVATAR_PLATFORMS.has(l.platform)).length === 0 && (
                          <p className="text-xs text-text-muted">
                            No supported platforms found. You can update your photo later from the editor.
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </section>

              {/* Links section */}
              <section className="space-y-3">
                <h2 className="text-sm font-medium">Your Links</h2>
                <div className="space-y-1">
                  {reviewLinks.map((link, index) => (
                    <label
                      key={`${link.platform}-${index}`}
                      className={`flex items-center gap-3 p-3 rounded-lg border transition-colors cursor-pointer ${
                        link.checked
                          ? 'bg-bg-secondary border-border'
                          : 'bg-bg-primary border-border/50 opacity-50'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={link.checked}
                        onChange={() => {
                          const updated = [...reviewLinks];
                          updated[index] = { ...updated[index], checked: !updated[index].checked };
                          setReviewLinks(updated);
                        }}
                        className="w-4 h-4 rounded accent-accent-primary flex-shrink-0"
                      />
                      <SocialIcon platform={link.platform} className="w-4.5 h-4.5" />
                      <div className="flex-1 min-w-0">
                        <span className="text-sm font-medium">{platformName(link.platform)}</span>
                        <p className="text-xs text-text-muted truncate">{link.url}</p>
                      </div>
                    </label>
                  ))}
                </div>
                {reviewLinks.length === 0 && (
                  <p className="text-sm text-text-muted text-center py-2">
                    No links discovered. You can add links later from your dashboard.
                  </p>
                )}
              </section>

              {/* Confirm */}
              <button
                onClick={handleConfirmReview}
                disabled={loading}
                className="w-full py-3 rounded-lg bg-accent-primary text-white font-medium hover:bg-accent-primary/90 transition-colors disabled:opacity-50"
              >
                {loading ? 'Saving...' : 'This looks good — go to my page'}
              </button>
            </div>
          )}

          {/* Step 5: Done */}
          {step === 'done' && (
            <div className="text-center space-y-4 p-6 rounded-lg bg-bg-secondary border border-border">
              <div className="text-3xl">✅</div>
              <p className="text-xl font-bold">Profile claimed!</p>
              <p className="text-sm text-text-muted">
                Your artist page is now live. We found {discoveredLinks} platform
                {discoveredLinks === 1 ? ' link' : ' links'} from your website.
              </p>
              <a
                href={`/a/${slug}?claimed`}
                className="inline-block px-6 py-2 rounded-lg bg-accent-primary text-white font-medium hover:bg-accent-primary/90 transition-colors"
              >
                View your artist page
              </a>
            </div>
          )}
        </div>
      </main>

      <Footer />
    </div>
  );
}
