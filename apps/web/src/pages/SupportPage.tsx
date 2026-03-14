import { Link } from 'react-router-dom';
import { ThemeToggle } from '../components/ThemeToggle';
import { ArtistAuthBar } from '../components/ArtistAuthBar';
import { useTheme } from '../hooks/useTheme';
import { Footer } from '../components/Footer';

export function SupportPage() {
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
        <div className="max-w-2xl mx-auto text-center">
          <h2 className="font-display text-3xl font-semibold text-text-primary mb-4">Support Unstream</h2>
          <p className="text-text-secondary text-lg mb-8">
            Unstream is free, open source, and will always stay that way. If you find it useful, you can support ongoing development with a donation.
          </p>

          <div className="bg-surface-secondary rounded-2xl p-8 border border-border mb-8">
            <a
              href="https://liberapay.com/unstream"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-3 px-8 py-4 rounded-xl bg-[#F6C915] text-gray-900 hover:bg-[#E5BA14] transition-colors font-semibold text-lg shadow-lg"
            >
              <svg className="w-6 h-6" viewBox="0 0 80 80" fill="currentColor">
                <g transform="translate(18.4,0)">
                  <path d="M27.3 78.8c-2.1 0-4.2-.3-6.1-.8a21.7 21.7 0 01-5.3-2.3l5.6-12.9c1.2.8 2.4 1.3 3.8 1.7a14.1 14.1 0 008.6-1c2.2-1.2 4-2.8 5.5-4.9a21.2 21.2 0 003.5-7.8L6.8 0h16.6l22.4 36.7L36.3 64c-1.4 4.1-3.8 7.2-7 9.5-3.3 2.2-7 3.3-11 3.3z" fill="#f6c915"/>
                </g>
              </svg>
              Donate via Liberapay
            </a>
            <p className="text-text-muted text-sm mt-4">
              Liberapay is an open source, non-profit platform for recurring donations.
            </p>
          </div>

          <div className="text-left bg-surface-secondary rounded-2xl p-8 border border-border">
            <h3 className="font-display text-xl font-semibold text-text-primary mb-4">Other ways to help</h3>
            <ul className="space-y-3 text-text-secondary">
              <li className="flex items-start gap-3">
                <span className="text-lg mt-0.5">*</span>
                <span>Star the project on <a href="https://github.com/brandonlucasgreen/unstream" target="_blank" rel="noopener noreferrer" className="text-accent-primary hover:underline">GitHub</a></span>
              </li>
              <li className="flex items-start gap-3">
                <span className="text-lg mt-0.5">*</span>
                <span>Share Unstream with friends who care about supporting artists</span>
              </li>
              <li className="flex items-start gap-3">
                <span className="text-lg mt-0.5">*</span>
                <span>Report bugs or suggest features on <a href="https://unstream.featurebase.app" target="_blank" rel="noopener noreferrer" className="text-accent-primary hover:underline">Featurebase</a></span>
              </li>
            </ul>
          </div>
        </div>
      </main>

      <Footer />
    </div>
  );
}
