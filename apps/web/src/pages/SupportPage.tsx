import { Header } from '../components/Header';
import { Footer } from '../components/Footer';
import { KOFI_URL, UPCOMING_COSTS } from '../data/support';

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
        <div className="max-w-2xl mx-auto">
          <div className="space-y-4 text-text-secondary text-lg leading-relaxed mb-10">
            <p>
              Unstream is free to use because its mission is to expand &amp; deepen support for artists.
              Search, support links, saved artists and the apps stay free whether or not anyone pays.
            </p>
            <p>
              <a href="https://bgreen.lol" target="_blank" rel="noopener noreferrer" className="text-accent-primary hover:underline">
                I'm Brandon
              </a>{' '}
              — an indie musician and tech worker. I build and run Unstream in my spare time, and
              because Unstream has been small, I've been able to run it basically for free.
            </p>
          </div>

          <section aria-labelledby="costs-heading" className="mb-10">
            <h2 id="costs-heading" className="font-display text-xl font-semibold text-text-primary mb-3">
              That's about to change
            </h2>
            <p className="text-text-secondary mb-4">
              Unstream is growing, which is exciting! But it's starting to outgrow free services. The
              database has already gone down a few times as I've added features and more people have
              started to use it. Moving to paid services to run Unstream looks roughly like this:
            </p>
            <ul className="divide-y divide-border border-y border-border">
              {UPCOMING_COSTS.map((cost) => (
                <li key={cost.service} className="py-3 flex justify-between gap-4">
                  <span className="text-text-primary">
                    {cost.service} <span className="text-text-muted">— {cost.what}</span>
                  </span>
                  <span className="text-text-primary tabular-nums shrink-0">{cost.monthly}/mo</span>
                </li>
              ))}
            </ul>
          </section>

          <section aria-labelledby="help-heading" className="mb-10">
            <h2 id="help-heading" className="font-display text-xl font-semibold text-text-primary mb-3">
              How you can help
            </h2>
            <p className="text-text-secondary mb-6">
              If you use and like Unstream, I'd appreciate a one-time or recurring contribution.
              Payments will go directly toward improving the service and helping more music fans
              discover it.
            </p>
            <div className="text-center">
              <a
                href={KOFI_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-3 px-8 py-4 rounded-xl bg-[#FF5E5B] text-white hover:bg-[#F04E4B] transition-colors font-semibold text-lg shadow-lg"
              >
                Support Unstream on Ko-fi
              </a>
              <p className="text-text-muted text-sm mt-4">One-time or monthly.</p>
            </div>
          </section>

          <div className="bg-surface-secondary rounded-2xl p-8 border border-border">
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
