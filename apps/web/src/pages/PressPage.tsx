import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Header } from '../components/Header';
import { Footer } from '../components/Footer';

/**
 * Press kit.
 *
 * Written for one reader: a writer who has just heard of Unstream and has about ninety seconds
 * before they decide whether it's worth their time. Everything they might otherwise have to email
 * for — boilerplate at four lengths, the facts, the screenshots, what the thing is *not* — is on
 * this page so the answer to "can you send me…" is always "it's already there."
 *
 * PLATFORM_COUNT is the site-wide public figure and has to match what the rest of the site says
 * (index.html meta, DevelopersPage, ImportPage, the guides). It is deliberately conservative:
 * a strict count of buy/support/borrow entries in `api/shared/platform-registry.ts` comes out
 * higher, so "17+" stays true as platforms are added and never needs a correction.
 */

const PLATFORM_COUNT = '17+';

const BOILERPLATE = [
  {
    label: 'One line',
    text:
      'Unstream shows you where to buy music directly from the artists you already listen to — and how much of your money each place actually passes along.',
  },
  {
    label: 'Short — 25 words',
    text:
      `A free, open-source tool that finds where any artist sells music outside streaming, across ${PLATFORM_COUNT} platforms, with the artist's payout percentage shown on every link.`,
  },
  {
    label: 'Medium — 50 words',
    text:
      `Unstream is a free, open-source tool for music fans. Search any artist and it finds where they sell, share, or accept support across ${PLATFORM_COUNT} platforms — Bandcamp, Mirlo, Ampwall, Qobuz, Ko-fi, library services — with each artist's payout percentage shown inline. It runs on the web, in your menu bar, and in your browser.`,
  },
  {
    label: 'Long — 100 words',
    text:
      `Unstream is a free, open-source tool that helps music fans support the artists they already listen to. Search any artist and Unstream finds where they sell, share, or accept support across ${PLATFORM_COUNT} platforms — music marketplaces like Bandcamp and Mirlo, patronage sites like Ko-fi and Patreon, decentralized platforms like Faircamp, and library services like Hoopla — showing each platform's artist payout percentage alongside the link. It runs as a website, a macOS menu bar app that reads what you're playing, and Chrome and Firefox extensions. Save artists and subscribe to their new releases by RSS or calendar feed. No paywall, no tracking, no AI.`,
  },
];

const FACTS: { label: string; value: React.ReactNode }[] = [
  { label: 'Name', value: 'Unstream' },
  { label: 'What it is', value: 'A tool for finding where to buy and support music outside streaming' },
  {
    label: 'URL',
    value: (
      <a href="https://unstream.stream" className="text-accent-primary hover:underline">
        unstream.stream
      </a>
    ),
  },
  { label: 'Price', value: 'Free. No paid tier, no upsell. Optional donations via Liberapay.' },
  {
    label: 'License',
    value: (
      <a
        href="https://github.com/brandonlucasgreen/unstream"
        target="_blank"
        rel="noopener noreferrer"
        className="text-accent-primary hover:underline"
      >
        Open source on GitHub
      </a>
    ),
  },
  {
    label: 'Platforms',
    value: 'Web · macOS menu bar app · Chrome extension · Firefox extension · installable web app on iOS and Android · iOS Shortcut',
  },
  {
    label: 'macOS distribution',
    value: (
      <>
        Direct download from{' '}
        <a
          href="https://github.com/brandonlucasgreen/unstream/releases/latest"
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent-primary hover:underline"
        >
          GitHub Releases
        </a>{' '}
        — not the Mac App Store
      </>
    ),
  },
  {
    label: 'Sources searched',
    value: `${PLATFORM_COUNT} places to buy, support, or borrow — plus official sites and social profiles`,
  },
  {
    label: 'Analytics',
    value: (
      <>
        GoatCounter, and{' '}
        <a
          href="https://unstream.goatcounter.com"
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent-primary hover:underline"
        >
          public
        </a>
        . No tracking pixels, no ad networks, no personal data collected from visitors.
      </>
    ),
  },
  {
    label: 'AI',
    value: 'None. Unstream does not use AI to recommend artists and does not surface AI-generated music.',
  },
  {
    label: 'Press contact',
    value: (
      <a href="mailto:press@unstream.stream" className="text-accent-primary hover:underline">
        press@unstream.stream
      </a>
    ),
  },
  {
    label: 'Made by',
    value: (
      <>
        Brandon Lucas Green — independent musician (
        <a
          href="https://kidlightbulbs.com"
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent-primary hover:underline"
        >
          Kid Lightbulbs
        </a>
        ), based in Massachusetts
      </>
    ),
  },
];

const FEATURES = [
  {
    title: 'It reads what you’re playing and tells you where to buy it',
    body:
      'The macOS menu bar app watches Spotify and Apple Music. Whatever’s playing, one click shows every place that artist sells music, with the payout percentage on each link. Bandcamp 80–85%. Ampwall 92–95%. Subvert 97%. Qobuz ~70%.',
  },
  {
    title: 'New releases come to you, as a feed you own',
    body:
      'Save artists and Unstream watches their catalogs. Subscribe by Atom or by calendar (.ics) and new releases land in your RSS reader or your calendar, each one linked to where you can buy it. No app required to check, no account to log into.',
  },
  {
    title: 'Your saved artists are a page you can share',
    body:
      'unstream.stream/u/your-handle is a public list of the artists you support — a shareable object, not a private library.',
  },
  {
    title: 'It works while you’re on Spotify',
    body:
      'The Chrome and Firefox extensions detect the artist on Spotify, Apple Music, YouTube, YouTube Music, SoundCloud, and Bandcamp, and surface the same buying guide without leaving the page.',
  },
  {
    title: 'Artists can claim their page, free',
    body:
      'A verified badge, a short URL, control over which links show, and analytics on searches, views, and click-throughs.',
  },
];

const NOT_LIST = [
  ['Not a streaming service.', 'It doesn’t play music.'],
  [
    'Not anti-Spotify evangelism.',
    'The framing is “reduce your dependency,” not “quit.” Most people who use Unstream still stream. That’s the point.',
  ],
  ['Not a marketplace.', 'Unstream takes no cut of anything. It links out and gets out of the way.'],
  ['Not a discovery engine.', 'It’s for artists you already like, not artists you haven’t met.'],
  ['Not artists-first.', 'Artists have a feature set, but the audience is fans.'],
];

/**
 * Grouped by surface rather than shown as one flat grid — a writer looking for "a shot of the
 * extension" shouldn't have to scan captions for it. Grouping also keeps wildly different aspect
 * ratios out of the same row: the phone and extension shots are tall and narrow, the web shots are
 * wide, and mixing them in one grid leaves ragged whitespace.
 */
const SCREENSHOT_GROUPS: {
  title: string;
  columns: 1 | 2;
  shots: { src: string; alt: string; caption: string }[];
}[] = [
  {
    title: 'The web app',
    columns: 1,
    shots: [
      {
        src: '/screenshots/web-release-page.webp',
        alt: 'An Unstream release page for the album World Wore by Roberta Fidora, with a Where To Buy section comparing Mirlo at 86–90% to artist and Bandcamp at 80–85%, broken down by format and price',
        caption:
          'A release page. Each format is priced separately, with an estimate of what reaches the artist — and a line saying when prices were last checked and that the payout figures are estimates.',
      },
      {
        src: '/screenshots/web-artist-page-light.webp',
        alt: 'Unstream artist page for Sarah McLachlan in light mode, showing Bandcamp at 80–85%, an official site, Discogs, and the library services Hoopla and Freegal, above a grid of releases each listing a date, a price, and an estimate of what reaches the artist',
        caption:
          'An artist page in light mode. Ways to buy and ways to borrow sit side by side, and every release below carries its own price and estimate. The calendar and RSS icons subscribe you to new ones.',
      },
      {
        src: '/screenshots/web-artist-page.webp',
        alt: "Unstream's artist page for Neko Case in dark mode, listing Bandcamp at 80–85%, Qobuz at ~70%, Discogs, Hoopla, and Freegal under a heading reading Support Directly",
        caption:
          'The same page in dark mode. Library services (Hoopla, Freegal) sit alongside the places you can buy.',
      },
      {
        src: '/screenshots/web-claimed-artist.webp',
        alt: 'A claimed and verified Unstream artist page for Kid Lightbulbs, with a bio, an embedded featured release, support links showing payout percentages and AI policy badges, and a list of releases',
        caption:
          'A claimed artist page — bio, featured release, and the artist’s own choice of links. The AI policy badges flag where a platform has one.',
      },
      {
        src: '/screenshots/web-dashboard.webp',
        alt: 'The Unstream dashboard showing Upcoming Releases and Recent Releases with dates, prices, and estimated artist takings, above a list of saved artists',
        caption:
          'Saved artists and their releases, with the estimated take for the artist on each. The calendar and RSS icons top-right are the subscribe links.',
      },
    ],
  },
  {
    title: 'The macOS menu bar app',
    columns: 2,
    shots: [
      {
        src: '/screenshots/macos-kidlightbulbs.webp',
        alt: 'The Unstream menu bar app showing the currently playing artist and the platforms they sell on, each with a payout percentage',
        caption: 'Now Playing, with payout percentages on every link',
      },
      {
        src: '/screenshots/macos-saved.webp',
        alt: 'The Unstream menu bar app showing a list of saved artists, several marked Verified',
        caption: 'Saved artists — the list that feeds your release feed',
      },
      {
        src: '/screenshots/macos-liturgy.webp',
        alt: 'Unstream menu bar search results for the band Liturgy',
        caption: 'Searching from the menu bar',
      },
      {
        src: '/screenshots/macos-okayden.webp',
        alt: 'Unstream menu bar results for the artist okayden',
        caption: 'Results grouped by platform category',
      },
    ],
  },
  {
    title: 'The browser extension',
    columns: 2,
    shots: [
      {
        src: '/screenshots/extension-popup.webp',
        alt: 'The Unstream browser extension popup showing the currently playing artist, support links with payout percentages, and an expandable list of releases with prices',
        caption:
          'The extension, open over whatever you’re streaming. Releases expand to show what each one costs and what reaches the artist.',
      },
    ],
  },
  {
    title: 'On a phone',
    columns: 2,
    shots: [
      {
        src: '/screenshots/mobile-saved-list.webp',
        alt: "A shared Unstream list titled brandon's saved artists on a phone, with several artists marked Supported and a Copy URL button",
        caption:
          'A shared list, which anyone can open without an account. The site installs to a home screen; there’s no separate iOS app.',
      },
    ],
  },
];

function CopyBlock({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  // Clipboard access is unavailable on insecure origins and can be denied by permissions policy.
  // A failed copy leaves the text selectable, which is the same outcome as having no button.
  const handleCopy = () => {
    navigator.clipboard?.writeText(text).then(
      () => setCopied(true),
      () => setCopied(false)
    );
  };

  return (
    <div className="rounded-xl border border-border bg-surface-secondary p-5">
      <div className="flex items-center justify-between gap-4 mb-3">
        <span className="text-xs font-semibold uppercase tracking-wide text-text-muted">{label}</span>
        <button
          type="button"
          onClick={handleCopy}
          className="text-xs font-medium text-accent-primary hover:underline shrink-0"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <p className="text-text-secondary leading-relaxed">{text}</p>
    </div>
  );
}

export function PressPage() {
  useEffect(() => {
    document.title = 'Press kit — Unstream';
    const metaDesc = document.querySelector('meta[name="description"]');
    if (metaDesc) {
      metaDesc.setAttribute(
        'content',
        'Press kit for Unstream: boilerplate, facts, screenshots, and logos. A free, open-source tool that shows music fans where to buy directly from artists.'
      );
    }
  }, []);

  return (
    <div className="min-h-screen flex flex-col">
      <Header />

      <main className="flex-1 px-4 py-12 sm:py-16">
        <div className="max-w-3xl mx-auto">
          <h1 className="font-display text-3xl md:text-4xl font-extrabold text-text-primary mb-4">
            Press kit
          </h1>
          <p className="text-lg text-text-secondary mb-12">
            Unstream is made by one person. Everything here is free to use, quote, edit for length,
            and reproduce without asking.
          </p>

          {/* Boilerplate */}
          <section className="mb-14">
            <h2 className="font-display text-2xl font-bold text-text-primary mb-2">Boilerplate</h2>
            <p className="text-text-secondary mb-6">Four lengths. Use whichever fits, edited however you like.</p>
            <div className="space-y-4">
              {BOILERPLATE.map((item) => (
                <CopyBlock key={item.label} label={item.label} text={item.text} />
              ))}
            </div>
          </section>

          {/* Facts */}
          <section className="mb-14">
            <h2 className="font-display text-2xl font-bold text-text-primary mb-6">The facts</h2>
            <dl className="divide-y divide-border border-y border-border">
              {FACTS.map((fact) => (
                <div key={fact.label} className="py-4 sm:grid sm:grid-cols-3 sm:gap-6">
                  <dt className="text-sm font-semibold text-text-primary mb-1 sm:mb-0">{fact.label}</dt>
                  <dd className="text-text-secondary sm:col-span-2">{fact.value}</dd>
                </div>
              ))}
            </dl>
            <p className="text-sm text-text-muted mt-4">
              Sources fall into four groups: music marketplaces (Bandcamp, Mirlo, Ampwall, Subvert,
              Qobuz, Beatport, EVEN, Jam.coop, Discogs), patronage platforms (Patreon, Ko-fi, Buy Me
              a Coffee, Liberapay), decentralized and self-hosted platforms (Faircamp, Bandwagon,
              Funkwhale), and library services (Hoopla, Freegal, Internet Archive).
            </p>
          </section>

          {/* What it does */}
          <section className="mb-14">
            <h2 className="font-display text-2xl font-bold text-text-primary mb-6">What it does</h2>
            <div className="space-y-6">
              {FEATURES.map((feature) => (
                <div key={feature.title}>
                  <h3 className="font-semibold text-text-primary mb-1">{feature.title}</h3>
                  <p className="text-text-secondary leading-relaxed">{feature.body}</p>
                </div>
              ))}
            </div>
            <div className="mt-6 rounded-xl border border-border bg-surface-secondary p-5">
              <p className="text-sm text-text-secondary">
                <span className="font-semibold text-text-primary">Also true:</span> scrobbles to
                ListenBrainz, surfaces library services like Hoopla and Freegal so "free and legal
                with your library card" is a first-class answer, ships an iOS Shortcut that takes a
                share-sheet link from Spotify or Apple Music, has a{' '}
                <Link to="/developers" className="text-accent-primary hover:underline">
                  public API
                </Link>
                , and flags Bandcamp Friday in the web app and the extension.
              </p>
            </div>
          </section>

          {/* What it's not */}
          <section className="mb-14">
            <h2 className="font-display text-2xl font-bold text-text-primary mb-2">
              What Unstream is <em>not</em>
            </h2>
            <p className="text-text-secondary mb-6">
              These are the five things people assume that aren't true.
            </p>
            <ul className="space-y-3">
              {NOT_LIST.map(([lead, rest]) => (
                <li key={lead} className="text-text-secondary leading-relaxed">
                  <span className="font-semibold text-text-primary">{lead}</span> {rest}
                </li>
              ))}
            </ul>
          </section>

          {/* Screenshots */}
          <section className="mb-14">
            <h2 className="font-display text-2xl font-bold text-text-primary mb-2">Screenshots</h2>
            <p className="text-text-secondary mb-8">
              Free to use with credit to Unstream. Click any image to open it at full size.
            </p>
            <div className="space-y-10">
              {SCREENSHOT_GROUPS.map((group) => (
                <div key={group.title}>
                  <h3 className="font-semibold text-text-primary mb-4">{group.title}</h3>
                  <div
                    className={`grid gap-6 ${group.columns === 2 ? 'sm:grid-cols-2' : 'grid-cols-1'}`}
                  >
                    {group.shots.map((shot) => (
                      <figure key={shot.src}>
                        <a href={shot.src} target="_blank" rel="noopener noreferrer">
                          <img
                            src={shot.src}
                            alt={shot.alt}
                            loading="lazy"
                            className="w-full rounded-xl border border-border bg-surface-secondary"
                          />
                        </a>
                        <figcaption className="text-sm text-text-muted mt-2">
                          {shot.caption}
                        </figcaption>
                      </figure>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* Logos */}
          <section className="mb-14">
            <h2 className="font-display text-2xl font-bold text-text-primary mb-2">Logo</h2>
            <p className="text-text-secondary mb-6">
              Please don't restyle, recolor, or add effects to the mark. Otherwise, use it however
              you need.
            </p>
            <div className="flex flex-wrap items-center gap-6 rounded-xl border border-border bg-surface-secondary p-6">
              <img
                src="/icon-512.png"
                alt="The Unstream app icon"
                className="w-24 h-24 rounded-2xl"
              />
              <div className="text-sm text-text-secondary">
                <p className="mb-2">
                  <a href="/icon-512.png" download className="text-accent-primary hover:underline">
                    512×512 PNG
                  </a>
                  {' · '}
                  <a href="/icon-192.png" download className="text-accent-primary hover:underline">
                    192×192 PNG
                  </a>
                  {' · '}
                  <a href="/favicon.svg" download className="text-accent-primary hover:underline">
                    SVG
                  </a>
                </p>
                <p className="text-text-muted">
                  Larger sizes and light/dark variants live in{' '}
                  <a
                    href="https://github.com/brandonlucasgreen/unstream/tree/main/assets/logos"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-accent-primary hover:underline"
                  >
                    assets/logos
                  </a>{' '}
                  in the repo.
                </p>
              </div>
            </div>
          </section>

          {/* How many people use it */}
          <section className="mb-14">
            <h2 className="font-display text-2xl font-bold text-text-primary mb-4">
              How many people use it
            </h2>
            <p className="text-text-secondary leading-relaxed">
              Not many. It's a small tool I work on in evenings, and the numbers (which are{' '}
              <a
                href="https://unstream.goatcounter.com"
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent-primary hover:underline"
              >
                public
              </a>{' '}
              and anonymized) reflect that.
            </p>
          </section>

          {/* Who made it */}
          <section className="mb-14">
            <h2 className="font-display text-2xl font-bold text-text-primary mb-4">Who made it</h2>
            <div className="sm:flex sm:items-start sm:gap-6">
              <a
                href="/brandon-lucas-green.jpg"
                target="_blank"
                rel="noopener noreferrer"
                className="block shrink-0 mb-4 sm:mb-0"
              >
                <img
                  src="/brandon-lucas-green.webp"
                  alt="Brandon Lucas Green"
                  loading="lazy"
                  className="w-full sm:w-56 rounded-xl border border-border"
                />
              </a>
              <div>
                <p className="text-text-secondary leading-relaxed">
                  Brandon Lucas Green is an independent musician who records as{' '}
                  <a
                    href="https://kidlightbulbs.com"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-accent-primary hover:underline"
                  >
                    Kid Lightbulbs
                  </a>{' '}
                  and works in product at Buffer. He built Unstream after years of selling music
                  directly and realizing most of his listeners had no idea the option existed.
                </p>
                <p className="text-sm text-text-muted mt-3">
                  <a
                    href="/brandon-lucas-green.jpg"
                    download
                    className="text-accent-primary hover:underline"
                  >
                    Download the photo
                  </a>{' '}
                  — 1500×1000 JPEG, free to use with the piece.
                </p>
              </div>
            </div>
          </section>

          {/* Contact */}
          <section>
            <h2 className="font-display text-2xl font-bold text-text-primary mb-4">Contact</h2>
            <p className="text-text-secondary leading-relaxed">
              <a
                href="mailto:press@unstream.stream"
                className="text-accent-primary hover:underline"
              >
                press@unstream.stream
              </a>{' '}
              — I answer everything. Happy to do a call, walk through the app, hand over a build, or
              answer a question that makes the piece better. There's no embargo on anything here.
            </p>
            <p className="text-text-secondary leading-relaxed mt-3">
              Not press?{' '}
              <Link to="/contact" className="text-accent-primary hover:underline">
                The contact page
              </Link>{' '}
              is the better door.
            </p>
          </section>
        </div>
      </main>

      <Footer />
    </div>
  );
}
