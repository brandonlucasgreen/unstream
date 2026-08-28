import { Header } from '../components/Header';
import { Footer } from '../components/Footer';

export function SupportPage() {
  return (
    <div className="min-h-screen">

      <Header />

      <div className="pt-8 pb-8 px-4">
        <div className="max-w-4xl mx-auto text-center">
          <h1 className="font-display text-3xl md:text-4xl font-extrabold text-text-primary mb-4">Support Unstream</h1>
        </div>
      </div>

      {/* Content */}
      <main className="px-4 pb-16">
        <div className="max-w-2xl mx-auto text-center">
          <p className="text-text-secondary text-lg mb-8">
            Unstream is free because the money should go to artists, not us. If this tool helps you
            find and support musicians, chip in to keep it running.
          </p>

          <div className="bg-surface-secondary rounded-2xl p-8 border border-border mb-8">
            <a
              href="https://www.buymeacoffee.com/bgreen"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-3 px-8 py-4 rounded-xl bg-[#FFDD00] text-gray-900 hover:bg-[#F5D000] transition-colors font-semibold text-lg shadow-lg"
            >
              <svg className="w-6 h-6" viewBox="0 0 24 24" fill="currentColor">
                <path d="M18.5 4.8c-1.1-.4-2.5-.5-4-.3-2.4.3-4.7 1.4-6.2 3-.8.8-1.3 1.7-1.5 2.7-.2.9-.1 1.7.2 2.4.4.8 1 1.3 1.8 1.4.6.1 1.2 0 1.7-.3l-.3 1.5c-.1.5-.1 1 .1 1.4.2.4.5.7.9.8-.2.9 0 1.8.5 2.5.6.7 1.4 1.2 2.4 1.3 1.2.2 2.4-.1 3.4-.8.9-.7 1.6-1.7 2-2.9l1.8-8c.3-1.3.1-2.5-.5-3.4-.5-.7-1.3-1.1-2.3-1.3zM9.3 12c-.4-.1-.7-.3-.9-.7-.2-.4-.2-.9-.1-1.4.2-.8.6-1.5 1.2-2.1 1.2-1.3 3.1-2.2 5.2-2.5 1.2-.2 2.3-.1 3.1.2.6.3 1 .7 1.2 1.3.3.7.2 1.6-.1 2.5l-1.8 8c-.3 1-.8 1.7-1.5 2.3-.7.5-1.5.7-2.3.6-.7-.1-1.2-.4-1.6-.9-.4-.5-.5-1.1-.3-1.8l.4-1.8 2.5-1.2c.2-.1.3-.3.2-.5 0-.2-.2-.3-.4-.3l-2.8.5.7-3.1c.1-.2 0-.4-.2-.5z"/>
              </svg>
              Buy me a coffee
            </a>
            <p className="text-text-muted text-sm mt-4">
              One-time or monthly. No account needed.
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