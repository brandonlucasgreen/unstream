import { Link, useSearchParams } from 'react-router-dom';
import { Header } from '../components/Header';
import { Footer } from '../components/Footer';

// Where Stripe Checkout returns after a tip. The payment itself is recorded by the Connect webhook,
// not by this page, so nothing here depends on the session id Stripe appends.

export function TipThanksPage() {
  const [searchParams] = useSearchParams();
  const slug = searchParams.get('artist');
  const validSlug = slug && /^[a-z0-9-]{1,100}$/.test(slug) ? slug : null;

  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1 px-4 py-16">
        <div className="max-w-md mx-auto text-center space-y-4">
          <p className="text-4xl" aria-hidden="true">♥</p>
          <h1 className="text-2xl font-bold">Thank you</h1>
          <p className="text-text-secondary">
            Your tip went straight to the artist's own Stripe account. It will appear on your statement under their name.
          </p>
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
