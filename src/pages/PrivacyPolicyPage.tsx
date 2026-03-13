import { Link } from 'react-router-dom';
import { ThemeToggle } from '../components/ThemeToggle';
import { ArtistAuthBar } from '../components/ArtistAuthBar';
import { useTheme } from '../hooks/useTheme';
import { Footer } from '../components/Footer';

export function PrivacyPolicyPage() {
  const { preference, cycleTheme } = useTheme();

  return (
    <div className="min-h-screen">
      <ArtistAuthBar />
      {/* Header */}
      <header className="pt-8 pb-8 px-4 relative">
        <div className="absolute top-4 right-4">
          <ThemeToggle preference={preference} onCycle={cycleTheme} />
        </div>
        <div className="max-w-4xl mx-auto text-center">
          <Link
            to="/"
            className="inline-flex items-center gap-1 text-sm text-text-muted hover:text-text-primary transition-colors mb-4"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
            Back to search
          </Link>
          <h1 className="font-display text-4xl md:text-5xl font-bold mb-4">
            <Link
              to="/"
              className="text-text-primary hover:opacity-80 transition-opacity"
            >
              Unstream 🤘🏻
            </Link>
          </h1>
        </div>
      </header>

      {/* Content */}
      <main className="px-4 pb-16">
        <div className="max-w-3xl mx-auto">
          <article className="prose prose-lg max-w-none text-text-primary">
            <h2 className="font-display text-3xl font-semibold text-text-primary mb-6">Privacy Policy</h2>
            <p className="text-text-muted text-sm mb-8">Last updated: March 13, 2026</p>

            <section className="mb-8">
              <h3 className="font-display text-xl font-semibold text-text-primary mb-3">Overview</h3>
              <p className="text-text-primary/90 leading-relaxed mb-3">
                Unstream is committed to protecting your privacy. This policy explains what data we collect, how we use it, and your rights regarding that data.
              </p>
              <p className="text-text-primary/90 leading-relaxed mb-3">
                <strong>The short version:</strong> We collect minimal data, we don't sell your information, and we don't track you across the web.
              </p>
            </section>

            <section className="mb-8">
              <h3 className="font-display text-xl font-semibold text-text-primary mb-3">What We Collect</h3>

              <h4 className="font-semibold text-text-primary mt-4 mb-2">Web App (unstream.stream)</h4>
              <ul className="list-disc ml-5 text-text-primary/90 mb-3 space-y-1">
                <li>Search queries you enter (artist names) - used only to fetch results</li>
                <li>Basic analytics (page views, search counts) - no personal identifiers</li>
              </ul>

              <h4 className="font-semibold text-text-primary mt-4 mb-2">Artist Profiles (for artists who claim their page)</h4>
              <ul className="list-disc ml-5 text-text-primary/90 mb-3 space-y-1">
                <li>Email address - used for authentication and account recovery via Supabase Auth</li>
                <li>Artist profile information you provide (bio, platform links, featured release embeds) - stored in our database and displayed publicly on your artist page</li>
                <li>Your artist page URL slug - publicly visible</li>
              </ul>

              <h4 className="font-semibold text-text-primary mt-4 mb-2">Chrome Extension</h4>
              <ul className="list-disc ml-5 text-text-primary/90 mb-3 space-y-1">
                <li>Currently playing track information (artist name, song title) from Spotify, YouTube, YouTube Music, and Apple Music - used only to search for alternative platforms</li>
                <li>License key (if you upgrade to Unstream Plus) - stored locally in your browser</li>
                <li>Saved artists (if you upgrade to Unstream Plus) - stored locally in your browser</li>
              </ul>

              <h4 className="font-semibold text-text-primary mt-4 mb-2">macOS App</h4>
              <ul className="list-disc ml-5 text-text-primary/90 mb-3 space-y-1">
                <li>Currently playing track information from your system - used only to search for alternative platforms</li>
                <li>License key and saved artists (if you upgrade to Unstream Plus) - stored locally on your device</li>
              </ul>
            </section>

            <section className="mb-8">
              <h3 className="font-display text-xl font-semibold text-text-primary mb-3">What We Don't Collect</h3>
              <ul className="list-disc ml-5 text-text-primary/90 mb-3 space-y-1">
                <li>Personal information (name, email, address) - unless you contact support or create an artist profile</li>
                <li>Login credentials for streaming services</li>
                <li>Listening history or playlists</li>
                <li>Cookies for tracking or advertising</li>
                <li>Any data from pages other than the specific streaming service player pages</li>
              </ul>
            </section>

            <section className="mb-8">
              <h3 className="font-display text-xl font-semibold text-text-primary mb-3">Third-Party Services</h3>
              <p className="text-text-primary/90 leading-relaxed mb-3">
                We use the following third-party services:
              </p>
              <ul className="list-disc ml-5 text-text-primary/90 mb-3 space-y-1">
                <li><strong>Lemon Squeezy</strong> - for processing Unstream Plus purchases and license validation</li>
                <li><strong>Supabase</strong> - for artist account authentication and profile data storage</li>
                <li><strong>MusicBrainz</strong> - for fetching artist metadata and social links</li>
                <li><strong>Bandcamp, Qobuz, and other music platforms</strong> - for searching artist availability</li>
              </ul>
              <p className="text-text-primary/90 leading-relaxed mb-3">
                We do not share your personal data with these services beyond what is necessary to provide the functionality (e.g., sending an artist name to search for results).
              </p>
            </section>

            <section className="mb-8">
              <h3 className="font-display text-xl font-semibold text-text-primary mb-3">Data Storage</h3>
              <p className="text-text-primary/90 leading-relaxed mb-3">
                For listeners, all user preferences, saved artists, and license information are stored locally on your device using browser storage (for the extension) or app storage (for macOS).
              </p>
              <p className="text-text-primary/90 leading-relaxed mb-3">
                For artists who claim their page, account and profile data (email, bio, links, embeds) is stored in our database hosted by Supabase. You can request deletion of your artist account and all associated data by contacting us at{' '}
                <a href="mailto:support@unstream.stream" className="text-accent-primary hover:text-accent-secondary transition-colors underline">
                  support@unstream.stream
                </a>.
              </p>
            </section>

            <section className="mb-8">
              <h3 className="font-display text-xl font-semibold text-text-primary mb-3">Your Rights</h3>
              <p className="text-text-primary/90 leading-relaxed mb-3">
                You can clear all locally stored data at any time by:
              </p>
              <ul className="list-disc ml-5 text-text-primary/90 mb-3 space-y-1">
                <li><strong>Chrome Extension:</strong> Remove the extension or clear extension data in Chrome settings</li>
                <li><strong>macOS App:</strong> Delete the app and its associated data from your system</li>
                <li><strong>Artist Profile:</strong> Contact us at support@unstream.stream to request deletion of your account and all associated profile data</li>
              </ul>
            </section>

            <section className="mb-8">
              <h3 className="font-display text-xl font-semibold text-text-primary mb-3">Changes to This Policy</h3>
              <p className="text-text-primary/90 leading-relaxed mb-3">
                We may update this privacy policy from time to time. We will notify users of any material changes by updating the "Last updated" date at the top of this page.
              </p>
            </section>

            <section className="mb-8">
              <h3 className="font-display text-xl font-semibold text-text-primary mb-3">Contact</h3>
              <p className="text-text-primary/90 leading-relaxed mb-3">
                If you have any questions about this privacy policy, please contact us at{' '}
                <a href="mailto:support@unstream.stream" className="text-accent-primary hover:text-accent-secondary transition-colors underline">
                  support@unstream.stream
                </a>.
              </p>
            </section>
          </article>
        </div>
      </main>

      <Footer />
    </div>
  );
}
