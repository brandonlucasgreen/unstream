import { useEffect, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import * as Sentry from '@sentry/react';
import { Header } from '../components/Header';
import { Footer } from '../components/Footer';
import { useAuth } from '../contexts/AuthContext';
import { claimTip, TipsApiError } from '../services/tips';

// Where Stripe Checkout returns after a tip. The payment itself is recorded by the Connect webhook,
// not by this page.
//
// Tipping never needs an account, so this is where a fan is offered one, after they've paid
// rather than in the way of paying: a signed-in fan's tip is saved to their account here, using
// the Checkout Session id Stripe appends (POST /api/me/tips), and a signed-out fan is offered a
// sign-in that comes back here to do the same. It also says where the receipt comes from and who
// handles refunds, since a signed-out fan has nothing else from Unstream to go on.

const SLUG_PATTERN = /^[a-z0-9-]{1,100}$/;
const SESSION_ID_PATTERN = /^cs_(test|live)_[A-Za-z0-9]{10,200}$/;

/** The webhook usually lands within a second or two; give it a little longer before saying so. */
const PENDING_RETRIES = 5;
const PENDING_RETRY_MS = 2000;

type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'failed'; message: string };

export function TipThanksPage() {
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const { session, isLoading: authLoading } = useAuth();
  const [save, setSave] = useState<SaveState>({ kind: 'idle' });

  const slug = searchParams.get('artist');
  const validSlug = slug && SLUG_PATTERN.test(slug) ? slug : null;
  const sessionId = searchParams.get('session_id');
  const validSessionId = sessionId && SESSION_ID_PATTERN.test(sessionId) ? sessionId : null;
  const canSave = !!(validSlug && validSessionId);
  const token = session?.access_token ?? null;

  useEffect(() => {
    if (!canSave || !token) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const attempt = async (retriesLeft: number) => {
      try {
        const status = await claimTip(token, validSessionId!, validSlug!);
        if (cancelled) return;
        if (status === 'saved') {
          setSave({ kind: 'saved' });
        } else if (retriesLeft > 0) {
          timer = setTimeout(() => attempt(retriesLeft - 1), PENDING_RETRY_MS);
        } else {
          setSave({ kind: 'failed', message: "Your tip went through, but we couldn't save it to your account yet. Reload this page in a minute to try again." });
        }
      } catch (err) {
        if (cancelled) return;
        const expected = err instanceof TipsApiError && [404, 409, 410].includes(err.status);
        if (!expected) Sentry.captureException(err, { extra: { context: 'TipThanksPage.claim' } });
        setSave({
          kind: 'failed',
          message: err instanceof TipsApiError && expected
            ? err.message
            : "Your tip went through, but we couldn't save it to your account. Reload this page to try again.",
        });
      }
    };

    setSave({ kind: 'saving' });
    attempt(PENDING_RETRIES);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [canSave, token, validSessionId, validSlug]);

  const signInHref = `/login?next=${encodeURIComponent(`${location.pathname}${location.search}`)}`;

  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1 px-4 py-16">
        <div className="max-w-md mx-auto space-y-6">
          <div className="text-center space-y-4">
            <p className="text-4xl" aria-hidden="true">♥</p>
            <h1 className="text-2xl font-bold">Thank you</h1>
            <p className="text-text-secondary">
              Your tip went straight to the artist's own Stripe account. It will appear on your statement under their name.
            </p>
          </div>

          {canSave && !authLoading && (
            <div className="p-4 rounded-xl border border-border text-sm space-y-2" role="status">
              {!token ? (
                <>
                  <p className="font-medium">Keep track of your tips</p>
                  <p className="text-text-secondary">
                    Sign in or create an account and we'll save this tip to it, so you can see every tip you've
                    left in one place. Entirely optional.
                  </p>
                  <Link to={signInHref} className="inline-block text-accent-primary hover:underline">
                    Save this tip to my account →
                  </Link>
                </>
              ) : save.kind === 'saved' ? (
                <p>
                  Saved to your account.{' '}
                  <Link to="/settings#tips" className="text-accent-primary hover:underline">See your tips</Link>
                </p>
              ) : save.kind === 'failed' ? (
                <p className="text-text-secondary">{save.message}</p>
              ) : (
                <p className="text-text-muted">Saving this tip to your account…</p>
              )}
            </div>
          )}

          <div className="text-sm text-text-secondary space-y-2">
            <p>
              <strong className="text-text-primary">Your receipt</strong> comes by email from the artist's Stripe
              account, under their business name, to the address you gave at checkout.
            </p>
            <p>
              <strong className="text-text-primary">Need a refund?</strong> The artist is the seller, so refunds
              come from them; their contact details are on your receipt. If you can't reach them, email{' '}
              <a href="mailto:support@unstream.stream" className="text-accent-primary hover:underline">support@unstream.stream</a>{' '}
              and we'll pass it on. <Link to="/terms#section-14" className="underline">How tipping works</Link>
            </p>
          </div>

          <div className="flex justify-center gap-3 pt-2">
            {validSlug && (
              <Link to={`/a/${validSlug}`} className="px-4 py-2 rounded-lg border border-border text-sm hover:bg-bg-hover">
                Back to the artist
              </Link>
            )}
            <Link to="/" className="px-4 py-2 rounded-lg bg-accent-primary text-white text-sm hover:bg-accent-primary/90">
              Find more artists
            </Link>
          </div>
        </div>
      </main>
      <Footer />
    </div>
  );
}
