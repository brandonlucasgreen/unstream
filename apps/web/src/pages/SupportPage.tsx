import { Link } from 'react-router-dom';
import { Header } from '../components/Header';
import { Footer } from '../components/Footer';

export function SupportPage() {
  return (
    <div className="min-h-screen">

      <Header />

      <div className="pt-8 pb-4 px-4">
        <div className="max-w-4xl mx-auto text-center">
          <h1 className="font-display text-3xl md:text-4xl font-extrabold text-text-primary mb-4">Support Unstream</h1>
        </div>
      </div>

      {/* Content */}
      <main className="px-4 pb-16">
        <div className="max-w-2xl mx-auto text-center">
          <div className="mb-8">
            <div className="flex items-center gap-5 mb-6 text-left">
              <div className="flex-1">
                <p className="text-text-secondary text-lg mb-6">
                  Unstream is free to use because its mission is to expand &amp; deepen support for artists.
                </p>
                <p className="text-text-secondary text-lg leading-relaxed">
                  I'm Brandon. I'm an indie musician and tech worker, and I run Unstream. If you find
                  it a helpful tool for supporting your favorite artists, consider chipping in to
                  help me keep it running.
                </p>
              </div>
              <img
                src="/brandon-lucas-green.webp"
                alt="Brandon Lucas Green"
                className="w-32 h-32 rounded-full object-cover shrink-0"
              />
            </div>
            <Link
              to="/open-studio"
              className="inline-flex items-center gap-3 px-8 py-4 rounded-xl bg-accent-primary text-white hover:bg-accent-primary/90 transition-colors font-semibold text-lg shadow-lg"
            >
              See what it costs, and become a member
            </Link>
            <p className="text-text-muted text-sm mt-4">
              From $3 a month. Optional, and it gates nothing.
            </p>
            {/* Liberapay wind-down (open-studio-membership-spec.md §9): kept for existing patrons
                until about March 2027, then removed. */}
            <p className="text-text-muted text-sm mt-2">
              Already give on{' '}
              <a
                href="https://liberapay.com/brandonlucasgreen"
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent-primary hover:underline"
              >
                Liberapay
              </a>
              ? That still counts.
            </p>
          </div>

          <div className="text-left bg-surface-secondary rounded-2xl p-8 border border-border">
            <h3 className="font-display text-xl font-semibold text-text-primary mb-4">Other ways to help</h3>
            <ul className="space-y-3 text-text-secondary">
              <li className="flex items-start gap-3">
                <span className="text-lg mt-0.5">★</span>
                <span>Star the project on <a href="https://github.com/brandonlucasgreen/unstream" target="_blank" rel="noopener noreferrer" className="text-accent-primary hover:underline">GitHub</a></span>
              </li>
              <li className="flex items-start gap-3">
                <span className="text-lg mt-0.5">★</span>
                <span>Share Unstream with friends who care about supporting artists</span>
              </li>
              <li className="flex items-start gap-3">
                <span className="text-lg mt-0.5">★</span>
                <span>Report bugs or suggest features on <a href="https://github.com/brandonlucasgreen/unstream/issues" target="_blank" rel="noopener noreferrer" className="text-accent-primary hover:underline">GitHub</a></span>
              </li>
            </ul>
          </div>
        </div>
      </main>

      <Footer />
    </div>
  );
}