
import { Header } from '../components/Header';
import { Footer } from '../components/Footer';

export function SupportPage() {
  return (
    <div className="min-h-screen">

      <Header />

      <div className="pt-8 pb-8 px-4">
        <div className="max-w-4xl mx-auto text-center">
          <h1 className="font-display text-3xl md:text-4xl font-semibold text-text-primary mb-4">Support Unstream</h1>
        </div>
      </div>

      {/* Content */}
      <main className="px-4 pb-16">
        <div className="max-w-2xl mx-auto text-center">
          <p className="text-text-secondary text-lg mb-8">
            Unstream is free and open source. If you find it useful, consider supporting its development and maintenance with a donation.
          </p>

          <div className="bg-surface-secondary rounded-2xl p-8 border border-border mb-8">
            <a
              href="https://liberapay.com/unstream"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-3 px-8 py-4 rounded-xl bg-[#F6C915] text-gray-900 hover:bg-[#E5BA14] transition-colors font-semibold text-lg shadow-lg"
            >
              <svg className="w-6 h-6" viewBox="0 0 24 24" fill="currentColor">
                <path d="M2.32 0A2.321 2.321 0 0 0 0 2.32v19.36A2.321 2.321 0 0 0 2.32 24h19.36A2.32 2.32 0 0 0 24 21.68V2.32A2.32 2.32 0 0 0 21.68 0zm9.208 3.98l-2.27 9.405a2.953 2.953 0 0 0-.073.539.853.853 0 0 0 .09.432.7.7 0 0 0 .334.302c.157.077.378.126.661.147l-.49 2.008c-.772 0-1.38-.1-1.82-.3-.441-.203-.757-.477-.947-.826a2.391 2.391 0 0 1-.278-1.2c.005-.452.068-.933.188-1.445l2.074-8.67zm3.9 3.888c.61 0 1.135.092 1.576.277.44.185.802.438 1.085.76.283.32.493.696.629 1.126.136.43.204.89.204 1.379v.001c0 .794-.13 1.52-.392 2.179a5.16 5.16 0 0 1-1.086 1.706 4.84 4.84 0 0 1-1.665 1.118c-.648.267-1.353.4-2.114.4-.37 0-.74-.033-1.11-.098l-.735 2.956H9.403l2.71-11.298c.435-.13.934-.248 1.494-.351a10.045 10.045 0 0 1 1.821-.155zm-.31 2.041a4.67 4.67 0 0 0-.98.098l-1.143 4.752c.185.044.413.065.685.065.425 0 .812-.079 1.16-.237a2.556 2.556 0 0 0 .89-.661c.244-.283.435-.623.571-1.02a4.03 4.03 0 0 0 .204-1.315c0-.468-.104-.865-.31-1.192-.207-.326-.566-.49-1.077-.49z"/>
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
