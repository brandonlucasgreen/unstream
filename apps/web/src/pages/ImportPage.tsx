import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Header } from '../components/Header';
import { Footer } from '../components/Footer';

export function ImportPage() {
  useEffect(() => {
    document.title = 'Import Your Music Library — Find artists on direct-support platforms | Unstream';
    const metaDesc = document.querySelector('meta[name="description"]');
    if (metaDesc) {
      metaDesc.setAttribute('content', 'See which artists from your Spotify, Apple Music, or Last.fm library are available on Bandcamp, Mirlo, Faircamp, and other platforms that pay artists fairly.');
    }
    return () => { document.title = 'Unstream - Support artists directly'; };
  }, []);

  return (
    <div className="min-h-screen">

      <Header />

      <div className="pt-8 pb-4 px-4">
        <div className="max-w-4xl mx-auto text-center">
          <h1 className="font-display text-3xl md:text-4xl font-semibold text-text-primary mb-4">
            Import Your Music Library
          </h1>
          <p className="text-text-secondary text-lg max-w-2xl mx-auto">
            See which artists from your streaming library are available on platforms that pay them fairly.
          </p>
        </div>
      </div>

      <main className="px-4 pb-16">
        <div className="max-w-2xl mx-auto space-y-8">

          {/* Coming soon notice */}
          <div className="bg-accent-primary/5 rounded-2xl p-8 border border-accent-primary/20 text-center">
            <p className="text-sm font-medium text-accent-primary uppercase tracking-wider mb-2">Coming soon</p>
            <p className="text-text-secondary">
              We're building a way to connect your Spotify, Apple Music, or Last.fm library and instantly discover which of your artists are on Bandcamp, Mirlo, Faircamp, and other direct-support platforms.
            </p>
          </div>

          {/* How it will work */}
          <div className="bg-surface-secondary rounded-2xl p-8 border border-border">
            <h2 className="font-display text-xl font-semibold text-text-primary mb-6">How it will work</h2>
            <div className="space-y-6">
              <div className="flex items-start gap-4">
                <div className="w-8 h-8 rounded-full bg-accent-primary/10 text-accent-primary flex items-center justify-center flex-shrink-0 text-sm font-bold">1</div>
                <div>
                  <p className="font-medium text-text-primary">Connect your streaming account</p>
                  <p className="text-sm text-text-secondary mt-1">
                    Sign in with Spotify, Apple Music, or Last.fm. We only read your library — we never modify it.
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-4">
                <div className="w-8 h-8 rounded-full bg-accent-primary/10 text-accent-primary flex items-center justify-center flex-shrink-0 text-sm font-bold">2</div>
                <div>
                  <p className="font-medium text-text-primary">We match your artists across platforms</p>
                  <p className="text-sm text-text-secondary mt-1">
                    Unstream searches every artist in your library across 17 alternative platforms and shows you which ones have direct-support options.
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-4">
                <div className="w-8 h-8 rounded-full bg-accent-primary/10 text-accent-primary flex items-center justify-center flex-shrink-0 text-sm font-bold">3</div>
                <div>
                  <p className="font-medium text-text-primary">Start supporting artists directly</p>
                  <p className="text-sm text-text-secondary mt-1">
                    Browse your results, save artists you want to follow, and get notified when they release new music on platforms where they earn more.
                  </p>
                </div>
              </div>
            </div>
          </div>

          {/* In the meantime */}
          <div className="bg-surface-secondary rounded-2xl p-8 border border-border text-center">
            <h2 className="font-display text-xl font-semibold text-text-primary mb-3">In the meantime</h2>
            <p className="text-text-secondary text-sm mb-6">
              You can search for any artist right now, or install the browser extension to automatically detect artists as you listen.
            </p>
            <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
              <Link
                to="/"
                className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-accent-primary text-white hover:bg-accent-primary/90 transition-colors font-medium"
              >
                Search for an artist
              </Link>
              <Link
                to="/extension"
                className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-surface border border-border text-text-primary hover:bg-surface-secondary transition-colors font-medium"
              >
                Get the extension
              </Link>
            </div>
          </div>

        </div>
      </main>

      <Footer />
    </div>
  );
}
