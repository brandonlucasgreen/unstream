import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Header } from '../components/Header';
import { Footer } from '../components/Footer';

/**
 * What an unknown path renders. Until this existed the router simply matched nothing, so a URL
 * the SPA didn't know produced an **empty `#root`** — a white page with no heading, no error and
 * nothing in the console, which reads as a crash rather than a 404.
 *
 * The case that made it worth fixing: a returning visitor whose service worker still holds the
 * previous build navigates to a route that build has never heard of (any route added since), and
 * gets that blank page until `StaleBuildBanner` persuades them to refresh. The banner is the
 * actual fix for staleness; this is what sits under it.
 *
 * **Imported eagerly in main.tsx, not through `lazyWithRetry`.** Every other page is lazy, but a
 * route that exists to catch "something has gone wrong with navigation" should not itself depend
 * on fetching a chunk — not least because a superseded build's chunks are deleted, which is the
 * very situation this page is most likely to be rendered in.
 *
 * `noindex` because this answers with HTTP 200: the SPA shell is served for every unmatched path,
 * so without it a mistyped or retired URL is an indexable soft 404.
 */
export function NotFoundPage() {
  useEffect(() => {
    const previousTitle = document.title;
    document.title = 'Page not found | Unstream';

    const meta = document.createElement('meta');
    meta.name = 'robots';
    meta.content = 'noindex';
    document.head.appendChild(meta);

    return () => {
      document.title = previousTitle;
      meta.remove();
    };
  }, []);

  return (
    <div className="min-h-screen bg-bg-primary text-text-primary flex flex-col">
      <Header />

      <main className="flex-1 p-6">
        <div className="max-w-2xl mx-auto text-center py-16 space-y-3">
          <h1 className="text-2xl font-bold">Page not found</h1>
          <p className="text-text-muted">
            That link doesn't go anywhere on Unstream. It may have moved, or it may never have
            existed — if you followed it from somewhere on this site, that's our bug.
          </p>
          <p className="text-text-muted text-sm">
            If you got here from a bookmark that used to work, try reloading the page first: an old
            copy of the site cached in your browser can reach for a page that has since moved.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-4 pt-4 text-sm">
            <Link to="/" className="text-accent-primary hover:underline">Search for an artist</Link>
            <Link to="/artists" className="text-accent-primary hover:underline">Browse artists</Link>
            <Link to="/faq" className="text-accent-primary hover:underline">FAQ</Link>
          </div>
        </div>
      </main>

      <Footer />
    </div>
  );
}
