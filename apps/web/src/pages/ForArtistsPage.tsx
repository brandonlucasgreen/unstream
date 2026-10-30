import { useEffect, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Header } from '../components/Header';
import { Footer } from '../components/Footer';
import { ClaimSearch, CLAIM_SEARCH_INPUT_ID } from '../components/ClaimSearch';
import { DEFAULT_PAGE_TITLE } from '../data/seo';

/**
 * Unstream for artists: what an independent artist gets from claiming their page, with the
 * search for that page at the top. The homepage speaks to fans; this is the page to send an
 * artist to.
 *
 * Every claim here has to stay true of the product, so check it when a feature changes:
 * Promote is "coming soon" while release autopost sits behind its `releaseAutopost` flag, and
 * comes off when that flag opens to every artist. Tips are open to artists (`tipsArtists`).
 * There is no public iPhone app, so "mid-stream" names the Mac app and the extensions.
 */

const PAGE_TITLE = 'Unstream for artists';
const PAGE_DESCRIPTION =
  'The best free promo & patronage toolkit for indie artists. Claim your page, take tips, and send fans to wherever you earn the most.';

type Accent = 'primary' | 'secondary' | 'tertiary';

// Same tiles as the homepage's HomeFeatures. Spelled out in full so Tailwind sees the classes.
const ACCENT_CLASSES: Record<Accent, { tile: string; chip: string }> = {
  primary: { tile: 'bg-fill-primary/10', chip: 'bg-fill-primary' },
  secondary: { tile: 'bg-fill-secondary/10', chip: 'bg-fill-secondary' },
  tertiary: { tile: 'bg-fill-tertiary/15', chip: 'bg-fill-tertiary' },
};

interface Feature {
  title: string;
  body: string;
  accent: Accent;
  icon: ReactNode;
  comingSoon?: boolean;
}

// Outline icons on the app's 24-unit grid.
const ICONS = {
  megaphone: <path d="M4 10v4h3l6 4V6L7 10H4zM16.5 8.5a5 5 0 010 7M19 6a8.5 8.5 0 010 12" />,
  store: (
    <>
      <path d="M4 9l1.5-4.5h13L20 9" />
      <path d="M4 9h16v2a2.7 2.7 0 01-5.3 0 2.7 2.7 0 01-5.4 0A2.7 2.7 0 014 11V9z" />
      <path d="M5.5 13v6.5h13V13" />
    </>
  ),
  bell: (
    <>
      <path d="M18 15.5V11a6 6 0 00-12 0v4.5L4.5 17.5h15L18 15.5z" />
      <path d="M10 20a2 2 0 004 0" />
    </>
  ),
  chart: <path d="M4 20h16M7 16v-5M12 16V7M17 16v-8" />,
  heart: <path d="M12 20.5s-7.5-4.4-7.5-10A4.5 4.5 0 0112 7.6a4.5 4.5 0 017.5 2.9c0 5.6-7.5 10-7.5 10z" />,
  list: <path d="M9 6h11M9 12h11M9 18h11M4.5 6h0M4.5 12h0M4.5 18h0" />,
  disc: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="2.5" />
    </>
  ),
  pen: <path d="M14.5 5.5l4 4L9 19H5v-4l9.5-9.5z" />,
};

// Promote comes last while it is still "Coming soon": what an artist can use today goes first.
const REACH_FEATURES: Feature[] = [
  {
    title: 'Every place to buy, with what you keep',
    body: 'Your page lists Bandcamp, Mirlo, Subvert and everywhere else that sells your music, plus patronage like Patreon, with how much of each payment reaches you, so fans can pick the one that pays you best.',
    accent: 'primary',
    icon: ICONS.store,
  },
  {
    title: 'Release alerts',
    body: 'Fans who save you get an email when you put something out, and can follow your releases by calendar or RSS.',
    accent: 'secondary',
    icon: ICONS.bell,
  },
  {
    title: 'See where your patrons come from',
    body: 'Your dashboard shows how often you’re searched for, how often your page is viewed, and which stores fans click through to. It counts visits, not people: Unstream doesn’t track who your listeners are.',
    accent: 'tertiary',
    icon: ICONS.chart,
  },
  {
    title: 'Promote',
    body: 'Connect your Buffer account and pick how often to post. Unstream fills your queue with your releases, Bandcamp Friday and your back catalog. Your words on a schedule, never written by AI.',
    accent: 'primary',
    icon: ICONS.megaphone,
    comingSoon: true,
  },
];

const PROFILE_FEATURES: Feature[] = [
  {
    title: 'Tips, straight to you',
    body: 'Fans tip you through your own Stripe account and can see the goals you set. Unstream takes nothing unless you choose to share up to 5%.',
    accent: 'secondary',
    icon: ICONS.heart,
  },
  {
    title: 'Your order, your links',
    body: 'Put the store you’d rather fans use first, add your own links, and choose the order of the sections on your page.',
    accent: 'tertiary',
    icon: ICONS.list,
  },
  {
    title: 'Feature a release',
    body: 'Pin the record you want people to hear first, playable right on your page, and choose which releases show.',
    accent: 'primary',
    icon: ICONS.disc,
  },
  {
    title: 'Your bio and photo',
    body: 'Write your own bio and choose your photo. Until you do, Unstream borrows them from Bandcamp, Discogs or Wikipedia.',
    accent: 'secondary',
    icon: ICONS.pen,
  },
];

// What an artist might otherwise pay a subscription for. No competitor prices: they change
// often and couldn't be checked against the vendors' own pages (2026-10-29).
const INSTEAD_OF: { insteadOf: string; unstream: string; cost: string }[] = [
  { insteadOf: 'a link-in-bio page', unstream: 'Your Unstream page', cost: 'Free' },
  { insteadOf: 'a release announcement list', unstream: 'Release alerts', cost: 'Free' },
  { insteadOf: 'a post scheduler', unstream: 'Promote, with Buffer’s free plan (coming soon)', cost: 'Free' },
  { insteadOf: 'a tip jar subscription', unstream: 'Tips', cost: 'No monthly fee' },
];

export function ForArtistsPage() {
  useEffect(() => {
    document.title = PAGE_TITLE;
    const descTag = document.querySelector('meta[name="description"]');
    const previousDescription = descTag?.getAttribute('content') ?? '';
    descTag?.setAttribute('content', PAGE_DESCRIPTION);
    return () => {
      document.title = DEFAULT_PAGE_TITLE;
      descTag?.setAttribute('content', previousDescription);
    };
  }, []);

  function focusSearch() {
    const input = document.getElementById(CLAIM_SEARCH_INPUT_ID);
    input?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    input?.focus({ preventScroll: true });
  }

  return (
    <div className="min-h-screen">
      <Header />

      <main className="px-4 pb-16">
        <div className="max-w-4xl mx-auto">
          <section className="pt-10 pb-12 md:pt-14" aria-labelledby="for-artists-heading">
            <p className="text-link font-bold text-xs uppercase tracking-widest mb-3">Unstream for artists</p>
            <h1 id="for-artists-heading" className="font-display text-4xl md:text-6xl font-extrabold text-text-primary leading-none mb-4 max-w-3xl">
              The best free promo &amp; patronage toolkit for indie artists
            </h1>
            <p className="text-text-secondary text-lg max-w-2xl mb-6">
              Send fans to wherever you earn the most, take tips, and keep your music in front of people, so you can
              get back to making it.
            </p>
            <div className="max-w-2xl">
              <ClaimSearch />
              <p className="text-xs text-text-muted mt-3">
                Claiming is free, and you prove it’s you with a link from your own website.
              </p>
            </div>
          </section>

          <Section title="Send fans where you earn the most">
            <FeatureGrid features={REACH_FEATURES} />
          </Section>

          <Section title="Get support mid-stream">
            <p className="text-text-secondary mb-6 max-w-2xl">
              Most people hear you on Spotify or Apple Music first. When they do, Unstream’s Mac menu bar app and its
              Chrome and Firefox extensions notice what’s playing and show them where to buy your music, or tip you,
              right then, without leaving what they’re doing.
            </p>
            <div className="grid grid-cols-2 gap-4 max-w-xl">
              <Screenshot
                src="/screenshots/macos-kidlightbulbs.webp"
                alt="The Unstream menu bar app showing Kid Lightbulbs playing, with links to Faircamp, Subvert, Bandcamp, Ampwall, Bandwagon and Qobuz."
                caption="The Mac menu bar app"
              />
              <Screenshot
                src="/screenshots/extension-popup.webp"
                alt="The Unstream browser extension showing the artist that's playing, their support links with payout percentages, and releases with what reaches the artist."
                caption="The browser extension"
              />
            </div>
            <p className="text-sm text-text-muted mt-4">
              <Link to="/extension" className="text-link hover:underline">Get the apps</Link> to see what your fans see.
            </p>
          </Section>

          <Section title="Make the page yours">
            <div className="flex flex-col md:flex-row items-start gap-8">
              <div className="flex-1">
                <FeatureGrid features={PROFILE_FEATURES} />
              </div>
              <div className="w-full md:w-72 shrink-0">
                <Screenshot
                  src="/screenshots/web-claimed-artist.webp"
                  alt="A claimed artist page for Kid Lightbulbs: photo, verified badge, bio, a Tip button, support links with payout percentages, and a featured release."
                  caption="A claimed page"
                />
              </div>
            </div>
          </Section>

          <Section title="Free, and made by an artist">
            <ul className="mb-3" aria-label="Tools Unstream can replace">
              {INSTEAD_OF.map(row => (
                <li key={row.insteadOf} className="flex items-center gap-4 border-t border-border py-3 first:border-t-0">
                  <div className="flex-1 min-w-0">
                    <p className="text-text-primary font-medium">{row.unstream}</p>
                    <p className="text-sm text-text-muted">Instead of {row.insteadOf}</p>
                  </div>
                  <p className="text-success font-semibold text-right shrink-0">{row.cost}</p>
                </li>
              ))}
            </ul>
            <p className="text-xs text-text-muted mb-8">
              Stripe’s card fee still applies to tips, and fans can choose to cover it.
            </p>

            <div className="flex gap-4 items-start rounded-2xl border border-border bg-surface-secondary p-5">
              <img
                src="/brandon-lucas-green.webp"
                alt=""
                className="w-16 h-16 rounded-full object-cover shrink-0"
                loading="lazy"
              />
              <p className="text-text-secondary leading-relaxed">
                I'm{' '}
                <a href="https://bgreen.lol" target="_blank" rel="noopener noreferrer" className="text-link hover:underline">
                  Brandon
                </a>, an indie musician and tech worker. I build and run Unstream in my spare time. Unstream is free to use
                because its mission is to expand &amp; deepen support for artists.
              </p>
            </div>
          </Section>
        </div>
      </main>

      <div className="bg-fill-primary text-accent-foreground text-center px-6 py-5">
        <button
          type="button"
          onClick={focusSearch}
          className="font-semibold underline decoration-2 underline-offset-4 hover:no-underline"
        >
          Ready? Find your page ↑
        </button>
      </div>

      <Footer />
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-t border-border py-12">
      <h2 className="font-display text-3xl md:text-4xl font-extrabold text-text-primary mb-6 heading-accent">{title}</h2>
      {children}
    </section>
  );
}

function FeatureGrid({ features }: { features: Feature[] }) {
  return (
    <div className="grid md:grid-cols-2 gap-3">
      {features.map(feature => (
        <div key={feature.title} className={`rounded-xl p-4 ${ACCENT_CLASSES[feature.accent].tile}`}>
          <div
            className={`w-9 h-9 mb-3 rounded-lg grid place-items-center text-accent-foreground ${ACCENT_CLASSES[feature.accent].chip}`}
            aria-hidden="true"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
              {feature.icon}
            </svg>
          </div>
          <h3 className="font-semibold text-text-primary mb-1">
            {feature.title}
            {feature.comingSoon && (
              <span className="ml-2 align-middle inline-block rounded-full bg-fill-primary text-accent-foreground text-[0.7rem] font-bold uppercase tracking-wide px-2 py-0.5">
                Coming soon
              </span>
            )}
          </h3>
          <p className="text-text-secondary text-sm">{feature.body}</p>
        </div>
      ))}
    </div>
  );
}

function Screenshot({ src, alt, caption }: { src: string; alt: string; caption: string }) {
  return (
    <figure>
      <img src={src} alt={alt} className="w-full rounded-xl border border-border" loading="lazy" />
      <figcaption className="text-xs text-text-muted mt-2 text-center">{caption}</figcaption>
    </figure>
  );
}
