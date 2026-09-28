import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Header } from '../components/Header';
import { Footer } from '../components/Footer';
import { NewsletterSignup } from '../components/NewsletterSignup';
import { sources, sourceCategories } from '../services/sources';
import { DEFAULT_PAGE_TITLE } from '../data/seo';
import { LIGHTBULBS_ON_BLURB } from '../data/newsletter';
import type { Source } from '../types';

/**
 * Every platform Unstream searches, grouped the way results are.
 *
 * Replaced two of the retired guides (2026-09-27), which described the same platforms in
 * long-form prose that drifted from the registry. This page is generated from
 * `services/sources.ts`, which mirrors `api/shared/platform-registry.ts`, so adding a platform
 * there adds it here and a changed payout figure can't disagree with the result cards.
 *
 * Official and social links are left out: they're where an artist is, not ways to pay them.
 */
const SUPPORT_CATEGORIES = ['marketplace', 'patronage', 'decentralized', 'library'] as const;

export function supportPlatformGroups(): { key: string; name: string; description: string; platforms: Source[] }[] {
  return SUPPORT_CATEGORIES.map((key) => ({
    key,
    name: sourceCategories[key].name,
    description: sourceCategories[key].description,
    platforms: sourceCategories[key].sources.map((id) => sources[id]),
  }));
}

const PAGE_TITLE = 'Platforms - Unstream';
const PAGE_DESCRIPTION =
  'Every platform Unstream searches, from Bandcamp to your local library, with how much of each sale reaches the artist.';

export function PlatformsPage() {
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

  const groups = supportPlatformGroups();

  return (
    <div className="min-h-screen">
      <Header />

      <div className="pt-6 pb-8 px-4">
        <div className="max-w-4xl mx-auto text-center">
          <h1 className="font-display text-3xl md:text-4xl font-extrabold text-text-primary mb-2">Where Unstream looks</h1>
          <p className="text-text-secondary text-lg max-w-2xl mx-auto">
            The places Unstream searches when you look up an artist, and how much of your money each one passes on.
          </p>
        </div>
      </div>

      <main className="px-4 pb-16">
        <div className="max-w-2xl mx-auto space-y-10">
          <p className="text-text-secondary text-sm">
            Payout is the share of a sale the artist keeps after the platform's fee. Card processing, usually
            around 2.9% plus 30¢, comes out on top of that, so the exact figure moves a little from sale to sale.
            The source for each number is in the <Link to="/faq" className="text-accent-primary hover:underline">FAQ</Link>,
            along with how Bandcamp Fridays change Bandcamp's.
          </p>

          {groups.map((group) => (
            <section key={group.key} aria-labelledby={`platforms-${group.key}`}>
              <h2 id={`platforms-${group.key}`} className="font-display text-xl font-semibold text-text-primary">
                {group.name}
              </h2>
              <p className="text-text-muted text-sm mb-4">{group.description}</p>
              <ul className="space-y-3">
                {group.platforms.map((platform) => (
                  <PlatformRow key={platform.id} platform={platform} />
                ))}
              </ul>
            </section>
          ))}

          <div className="bg-surface-secondary rounded-xl p-6 border border-border">
            <NewsletterSignup source="platforms" heading="Lightbulbs On" blurb={LIGHTBULBS_ON_BLURB} />
          </div>
        </div>
      </main>

      <Footer />
    </div>
  );
}

function PlatformRow({ platform }: { platform: Source }) {
  return (
    <li className="bg-surface-secondary rounded-xl border border-border p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <a
            href={platform.homepageUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-text-primary hover:underline"
          >
            <span aria-hidden="true" className="mr-2">{platform.icon}</span>
            {platform.name}
          </a>
          <p className="text-text-secondary text-sm">{platform.description}</p>
          {platform.aiPolicy && platform.aiPolicyUrl && (
            <a
              href={platform.aiPolicyUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-accent-primary hover:underline mt-1 inline-block"
            >
              {platform.aiPolicy === 'formal' ? 'Has a written AI policy' : 'Discourages AI-generated music'}
            </a>
          )}
        </div>
        <div className="text-right shrink-0">
          <p className="text-text-primary font-semibold">{platform.artistPayoutPercent ?? '—'}</p>
          <p className="text-text-muted text-xs">{platform.artistPayoutPercent ? 'to the artist' : 'not published'}</p>
        </div>
      </div>
    </li>
  );
}
