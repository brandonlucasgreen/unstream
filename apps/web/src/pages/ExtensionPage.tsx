import { useEffect } from 'react';
import { Header } from '../components/Header';
import { Footer } from '../components/Footer';
import { analytics } from '../services/analytics';

export function ExtensionPage() {
  useEffect(() => {
    document.title = 'Browser Extension — Detect & support artists while you listen | Unstream';
    const metaDesc = document.querySelector('meta[name="description"]');
    if (metaDesc) {
      metaDesc.setAttribute('content', 'Free browser extension that detects what music is playing and shows you how to support artists on Bandcamp, Mirlo, and other platforms. Available for Chrome and Firefox.');
    }
    return () => { document.title = 'Unstream - Support artists directly'; };
  }, []);

  return (
    <div className="min-h-screen">

      <Header />

      <div className="pt-8 pb-4 px-4">
        <div className="max-w-4xl mx-auto text-center">
          <h1 className="font-display text-3xl md:text-4xl font-semibold text-text-primary mb-4">
            The Unstream Browser Extension
          </h1>
          <p className="text-text-secondary text-lg max-w-2xl mx-auto">
            Detects what you're listening to and shows you how to support that artist directly — right in your browser.
          </p>
        </div>
      </div>

      <main className="px-4 pb-16">
        <div className="max-w-2xl mx-auto space-y-8">

          {/* How it works */}
          <div className="bg-surface-secondary rounded-2xl p-8 border border-border">
            <h2 className="font-display text-xl font-semibold text-text-primary mb-6">How it works</h2>
            <div className="space-y-6">
              <div className="flex items-start gap-4">
                <div className="w-8 h-8 rounded-full bg-accent-primary/10 text-accent-primary flex items-center justify-center flex-shrink-0 text-sm font-bold">1</div>
                <div>
                  <p className="font-medium text-text-primary">Listen to music in your browser</p>
                  <p className="text-sm text-text-secondary mt-1">
                    Play music on YouTube, SoundCloud, Bandcamp, or any site with audio — the extension detects what's playing automatically.
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-4">
                <div className="w-8 h-8 rounded-full bg-accent-primary/10 text-accent-primary flex items-center justify-center flex-shrink-0 text-sm font-bold">2</div>
                <div>
                  <p className="font-medium text-text-primary">See where to support the artist</p>
                  <p className="text-sm text-text-secondary mt-1">
                    Click the extension icon to see direct links to that artist on Bandcamp, Mirlo, Faircamp, and other platforms where they earn the most.
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-4">
                <div className="w-8 h-8 rounded-full bg-accent-primary/10 text-accent-primary flex items-center justify-center flex-shrink-0 text-sm font-bold">3</div>
                <div>
                  <p className="font-medium text-text-primary">Save artists and get release alerts</p>
                  <p className="text-sm text-text-secondary mt-1">
                    Save the artists you care about. When they release new music on Bandcamp or other platforms, you'll know about it.
                  </p>
                </div>
              </div>
            </div>
          </div>

          {/* Install */}
          <div className="bg-surface-secondary rounded-2xl p-8 border border-border text-center">
            <h2 className="font-display text-xl font-semibold text-text-primary mb-6">Install the extension</h2>
            <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
              <a
                href="https://chromewebstore.google.com/detail/unstream-support-music-di/ghoiopeidkganjdebkgkehaofnmjofkf"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-accent-primary text-white hover:bg-accent-primary/90 transition-colors font-medium shadow-lg shadow-accent-primary/20"
                onClick={() => analytics.trackDownload()}
              >
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M12 0C8.21 0 4.831 1.757 2.632 4.501l3.953 6.848A5.454 5.454 0 0 1 12 6.545h10.691A12 12 0 0 0 12 0zM1.931 5.47A11.943 11.943 0 0 0 0 12c0 6.012 4.42 10.991 10.189 11.864l3.953-6.847a5.45 5.45 0 0 1-6.865-2.29zm13.342 2.166a5.446 5.446 0 0 1 1.45 7.09l.002.001h-.002l-5.344 9.257c.206.01.413.016.621.016 6.627 0 12-5.373 12-12 0-1.54-.29-3.011-.818-4.364zM12 16.364a4.364 4.364 0 1 1 0-8.728 4.364 4.364 0 0 1 0 8.728z"/>
                </svg>
                Install for Chrome
              </a>
              <a
                href="https://addons.mozilla.org/en-US/firefox/addon/unstream/"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-surface border border-border text-text-primary hover:bg-surface-secondary transition-colors font-medium"
                onClick={() => analytics.trackDownload()}
              >
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M8.824 7.287c.008 0 .004 0 0 0zm-2.8-1.4c.006 0 .003 0 0 0zm16.754 2.161c-.505-1.215-1.53-2.528-2.333-2.943.654 1.283 1.033 2.57 1.177 3.53l.002.02c-1.314-3.278-3.544-4.6-5.366-7.477-.091-.147-.184-.292-.273-.446a3.545 3.545 0 01-.13-.24 2.118 2.118 0 01-.172-.46.03.03 0 00-.027-.03.038.038 0 00-.021 0l-.006.001a.037.037 0 00-.01.005L15.624 0c-2.585 1.515-3.657 4.168-3.932 5.856a6.197 6.197 0 00-2.305.587.297.297 0 00-.147.37c.057.162.24.24.396.17a5.622 5.622 0 012.008-.523l.067-.005a5.847 5.847 0 011.957.222l.095.03a5.816 5.816 0 01.616.228c.08.036.16.073.238.112l.107.055a5.835 5.835 0 01.368.211 5.953 5.953 0 012.034 2.104c-.62-.437-1.733-.868-2.803-.681 4.183 2.09 3.06 9.292-2.737 9.02a5.164 5.164 0 01-1.513-.292 4.42 4.42 0 01-.538-.232c-1.42-.735-2.593-2.121-2.74-3.806 0 0 .537-2 3.845-2 .357 0 1.38-.998 1.398-1.287-.005-.095-2.029-.9-2.817-1.677-.422-.416-.622-.616-.8-.767a3.47 3.47 0 00-.301-.227 5.388 5.388 0 01-.032-2.842c-1.195.544-2.124 1.403-2.8 2.163h-.006c-.46-.584-.428-2.51-.402-2.913-.006-.025-.343.176-.389.206-.406.29-.787.616-1.136.974-.397.403-.76.839-1.085 1.303a9.816 9.816 0 00-1.562 3.52c-.003.013-.11.487-.19 1.073-.013.09-.026.181-.037.272a7.8 7.8 0 00-.069.667l-.002.034-.023.387-.001.06C.386 18.795 5.593 24 12.016 24c5.752 0 10.527-4.176 11.463-9.661.02-.149.035-.298.052-.448.232-1.994-.025-4.09-.753-5.844z"/>
                </svg>
                Install for Firefox
              </a>
            </div>
            <p className="text-text-muted text-sm mt-4">Free and open source. Safari extension coming soon.</p>
          </div>

          {/* Also available */}
          <div className="bg-surface-secondary rounded-2xl p-8 border border-border text-center">
            <h2 className="font-display text-xl font-semibold text-text-primary mb-3">Also available as a Mac app</h2>
            <p className="text-text-secondary text-sm mb-6">
              Unstream for macOS sits in your menu bar and detects what's playing in Spotify or Apple Music — no browser needed.
            </p>
            <a
              href="https://github.com/brandonlucasgreen/unstream/releases/latest"
              className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-surface border border-border text-text-primary hover:bg-surface-secondary transition-colors font-medium"
              onClick={() => analytics.trackDownload()}
            >
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/>
              </svg>
              Download for macOS
            </a>
          </div>

        </div>
      </main>

      <Footer />
    </div>
  );
}
