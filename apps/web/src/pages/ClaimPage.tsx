import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import * as Sentry from '@sentry/react';
import { signInWithMagicLink } from '../services/auth';
import { useAuth } from '../contexts/AuthContext';

import { Header } from '../components/Header';
import { Footer } from '../components/Footer';
import { ClaimStepIndicator } from '../components/ClaimStepIndicator';
import { ClaimEmailStep } from '../components/ClaimEmailStep';
import { ClaimCheckEmailStep } from '../components/ClaimCheckEmailStep';
import { ClaimWebsiteStep } from '../components/ClaimWebsiteStep';
import { ClaimVerifyStep } from '../components/ClaimVerifyStep';
import { ClaimManualReviewStep } from '../components/ClaimManualReviewStep';
import { ClaimManualReviewSubmittedStep } from '../components/ClaimManualReviewSubmittedStep';
import { ClaimReviewStep } from '../components/ClaimReviewStep';
import { ClaimDoneStep } from '../components/ClaimDoneStep';

import type { ClaimStep, ReviewLink } from '../components/ClaimPageTypes';

export function ClaimPage() {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();

  const [step, setStep] = useState<ClaimStep>('email');
  const [email, setEmail] = useState('');
  const [websiteUrl, setWebsiteUrl] = useState('');
  const [verifyUrl, setVerifyUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [artistName, setArtistName] = useState('');
  const [discoveredLinks, setDiscoveredLinks] = useState(0);
  const [alreadyVerified, setAlreadyVerified] = useState(false);

  // Review step state
  const [reviewLinks, setReviewLinks] = useState<ReviewLink[]>([]);
  const [currentImageUrl, setCurrentImageUrl] = useState<string | null>(null);
  const [customImageUrl, setCustomImageUrl] = useState<string | null>(null);
  const [fetchingAvatar, setFetchingAvatar] = useState<string | null>(null);
  const [city, setCity] = useState('');
  const [country, setCountry] = useState('');

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
        // Pre-fill location from enrichment so the artist can confirm/correct
        if (data?.location?.city) setCity(data.location.city);
        const enrichedCountry = data?.location?.country || data?.location?.countryCode;
        if (enrichedCountry) setCountry(enrichedCountry);
      })
      .catch((e) => { Sentry.captureException(e, { extra: { context: 'claim.fetchArtistInfo' } }); })
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

    const token = getAuthToken();
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
        if (data.alreadyVerified) {
          // Profile is already verified — skip to done
          setAlreadyVerified(true);
          setStep('done');
          setLoading(false);
          return;
        }
        setError(data.error || 'Failed to start claim');
        setLoading(false);
        return;
      }

      setVerifyUrl(data.verifyUrl);
      setStep('verify');
    } catch (e) {
      Sentry.captureException(e, { extra: { context: 'claim.startClaim' } });
      setError('Network error. Please try again.');
    }
    setLoading(false);
  }

  async function handleVerify() {
    setError(null);
    setLoading(true);

    const token = getAuthToken();
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
    } catch (e) {
      Sentry.captureException(e, { extra: { context: 'claim.verify' } });
      setError('Network error. Please try again.');
    }
    setLoading(false);
  }

  async function handleFetchAvatar(platform: string, url: string) {
    setFetchingAvatar(platform);
    setError(null);

    const token = getAuthToken();
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
    } catch (e) {
      Sentry.captureException(e, { extra: { context: 'claim.fetchAvatar' } });
      setError('Network error. Please try again.');
    }
    setFetchingAvatar(null);
  }

  async function handleConfirmReview() {
    setError(null);
    setLoading(true);

    const token = getAuthToken();
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
          location: { city, country },
          ...(customImageUrl ? { customImageUrl } : {}),
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        if (response.status === 403 && data.error?.includes('not yet verified')) {
          setError('Your profile hasn\'t been verified yet. Please go back and complete the website verification step first.');
        } else if (response.status === 403) {
          setError('You don\'t have permission to edit this profile.');
        } else {
          setError(data.error || 'Failed to save changes');
        }
        setLoading(false);
        return;
      }

      navigate(`/a/${data.slug || slug}?claimed`);
    } catch (e) {
      Sentry.captureException(e, { extra: { context: 'claim.confirmReview' } });
      setError('Network error. Please try again.');
    }
    setLoading(false);
  }

  async function handleManualReviewSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setManualReviewSubmitting(true);

    const token = getAuthToken();
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
    } catch (e) {
      Sentry.captureException(e, { extra: { context: 'claim.manualReview' } });
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

          <ClaimStepIndicator step={step} authenticated={authenticated} />

          {error && (
            <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
              {error}
            </div>
          )}

          {step === 'email' && (
            <ClaimEmailStep
              email={email}
              setEmail={setEmail}
              loading={loading}
              onSubmit={handleSendMagicLink}
            />
          )}

          {step === 'check-email' && (
            <ClaimCheckEmailStep
              email={email}
              loading={loading}
              resendCooldown={resendCooldown}
              onResend={handleResend}
              onUseDifferentEmail={() => { setStep('email'); setEmail(''); setResendCooldown(0); }}
            />
          )}

          {step === 'website' && (
            <ClaimWebsiteStep
              websiteUrl={websiteUrl}
              setWebsiteUrl={setWebsiteUrl}
              loading={loading}
              onSubmit={handleStartClaim}
            />
          )}

          {step === 'verify' && (
            <ClaimVerifyStep
              verifyUrl={verifyUrl}
              loading={loading}
              onVerify={handleVerify}
              onRequestManualReview={() => { setError(null); setStep('manual-review'); }}
            />
          )}

          {step === 'manual-review' && (
            <ClaimManualReviewStep
              displayName={displayName}
              manualReviewMessage={manualReviewMessage}
              setManualReviewMessage={setManualReviewMessage}
              manualReviewSubmitting={manualReviewSubmitting}
              onSubmit={handleManualReviewSubmit}
              onBack={() => { setError(null); setStep('verify'); }}
            />
          )}

          {step === 'manual-review-submitted' && (
            <ClaimManualReviewSubmittedStep slug={slug} email={email} />
          )}

          {step === 'review' && (
            <ClaimReviewStep
              displayName={displayName}
              discoveredLinks={discoveredLinks}
              reviewLinks={reviewLinks}
              setReviewLinks={setReviewLinks}
              currentImageUrl={currentImageUrl}
              customImageUrl={customImageUrl}
              setCustomImageUrl={setCustomImageUrl}
              fetchingAvatar={fetchingAvatar}
              city={city}
              setCity={setCity}
              country={country}
              setCountry={setCountry}
              loading={loading}
              onFetchAvatar={handleFetchAvatar}
              onConfirm={handleConfirmReview}
            />
          )}

          {step === 'done' && (
            <ClaimDoneStep slug={slug} discoveredLinks={discoveredLinks} alreadyVerified={alreadyVerified} />
          )}
        </div>
      </main>

      <Footer />
    </div>
  );
}
