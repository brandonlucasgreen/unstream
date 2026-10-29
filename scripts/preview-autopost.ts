/**
 * Print what release autopost would post for an artist over the next weeks, from their real
 * catalogue, without posting anything.
 *
 * Usage:
 *   npm run preview:autopost -- kid-lightbulbs
 *   npm run preview:autopost -- kid-lightbulbs --per-week=2 --weeks=8
 *   npm run preview:autopost -- kid-lightbulbs --new=lantern --instagram
 *
 * Options:
 *   --per-week=N   posts a week, 1–7 (default: the recommendation for their catalogue)
 *   --weeks=N      how far ahead (default 12)
 *   --new=a,b      release slugs to treat as catalogued after autopost was switched on, so they
 *                  get release moments (pre-order, release day, out now, still new)
 *   --instagram    write the posts as Instagram would get them ("link in bio")
 *   --tz=…         timezone (default America/New_York); --time=HH:MM (default 10:00)
 *
 * WHAT IS AND ISN'T REAL
 *
 * Real: the catalogue (from the public /api/artist-page, the same read as the artist page),
 * the planner and template filler the sweep will run (`api/functions/autopost-plan.ts`,
 * `api/shared/autopost-templates.ts`), Unstream's default templates, and Bandcamp Friday dates.
 *
 * Assumed: autopost is switched on now, with no history; the artist photo, if there is one,
 * fits Instagram's shape; nothing is hidden or in review beyond what the public page already
 * leaves out. Release notes (`{note}`) aren't public, so none appear.
 *
 * Build plan step 1 of docs/specs/release-autopost-spec.md: see the rotation before anything posts.
 * One request to unstream.stream; no database, no Buffer.
 */

import { BANDCAMP_FRIDAY_DATES } from '../api/shared/bandcamp-friday';
import {
  AUTOPOST_KINDS,
  DEFAULT_TEMPLATES,
  releaseTemplateVars,
  renderVariant,
  supportTemplateVars,
  type AutopostKind,
  type TemplateRelease,
} from '../api/shared/autopost-templates';
import { planSlots, recommendedPostsPerWeek, type PlanRelease } from '../api/functions/autopost-plan';

/** Platforms whose listing comes from the artist's own links (spec, "Which releases qualify"). */
const QUALIFYING_PLATFORMS = new Set(['bandcamp', 'mirlo', 'faircamp', 'jamcoop']);

interface PageRelease extends TemplateRelease {
  status: 'announced' | 'released';
  artworkUrl: string | null;
  platforms: string[];
}

function option(name: string): string | undefined {
  return process.argv.find(a => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
}

async function main() {
  const slug = process.argv.slice(2).find(a => !a.startsWith('--'));
  if (!slug) {
    console.error('Usage: npm run preview:autopost -- <artist-slug> [--per-week=N] [--weeks=N] [--new=slug,slug] [--instagram]');
    process.exit(1);
  }
  const weeks = Number(option('weeks') ?? 12);
  const timezone = option('tz') ?? 'America/New_York';
  const postTime = option('time') ?? '10:00';
  const newSlugs = new Set((option('new') ?? '').split(',').filter(Boolean));
  const instagram = process.argv.includes('--instagram');

  const res = await fetch(`https://unstream.stream/api/artist-page?slug=${encodeURIComponent(slug)}`);
  if (!res.ok) throw new Error(`artist-page answered ${res.status}`);
  const page = await res.json() as {
    artist: { name: string; slug: string; imageUrl: string | null };
    profile: { customImageUrl: string | null; verifiedAt: string | null } | null;
    releases: PageRelease[];
    tips: { enabled: boolean } | null;
  };

  const artist = { name: page.artist.name, slug: page.artist.slug };
  const qualifying = page.releases.filter(r => r.platforms.some(p => QUALIFYING_PLATFORMS.has(p)));
  const bySlug = new Map(qualifying.map(r => [r.slug, r]));
  for (const s of newSlugs) if (!bySlug.has(s)) console.warn(`--new: no qualifying release "${s}"`);

  const now = new Date();
  const enabledAt = now.toISOString();
  const releases: PlanRelease[] = qualifying.map(r => ({
    id: r.slug,
    releaseDate: r.releaseDate,
    datePrecision: r.datePrecision ?? 'unknown',
    status: r.status,
    // Back catalogue is from before switching on; --new releases from just after.
    cataloguedAt: newSlugs.has(r.slug) ? new Date(now.getTime() + 1000).toISOString() : '2000-01-01T00:00:00Z',
    onBandcamp: r.platforms.includes('bandcamp'),
    hasCover: Boolean(r.artworkUrl),
  }));

  const perWeekArg = option('per-week');
  const recommended = recommendedPostsPerWeek(releases.length);
  const hasPhoto = Boolean(page.profile?.customImageUrl ?? page.artist.imageUrl);

  const posts = planSlots({
    settings: {
      postsPerWeek: perWeekArg ? Number(perWeekArg) : null,
      timezone,
      postTime,
      enabledAt,
      kindsOff: [],
      variantCounts: Object.fromEntries(AUTOPOST_KINDS.map(k => [k, DEFAULT_TEMPLATES[k].length])),
      artistPhoto: hasPhoto ? { instagramOk: true } : null,
      uploadIds: [],
    },
    releases,
    history: [],
    campaigns: [],
    bandcampFridays: BANDCAMP_FRIDAY_DATES,
    from: enabledAt,
    to: new Date(now.getTime() + weeks * 7 * 86_400_000).toISOString(),
  });

  const perWeek = perWeekArg ? Number(perWeekArg) : recommended;
  console.log(`\n${artist.name}: ${releases.length} qualifying releases (of ${page.releases.length} on their page)`);
  console.log(`${perWeek} a week${perWeekArg ? '' : ' (recommended)'} · next ${weeks} weeks · ${postTime} ${timezone}${instagram ? ' · as on Instagram' : ''}\n`);

  const counts = new Map<AutopostKind, number>();
  const mentions = new Map<string, number>();
  for (const post of posts) {
    counts.set(post.kind, (counts.get(post.kind) ?? 0) + 1);
    const release = post.releaseId ? bySlug.get(post.releaseId) : undefined;
    if (release) mentions.set(release.slug, (mentions.get(release.slug) ?? 0) + 1);

    const vars = release
      ? releaseTemplateVars(release, artist, { postDate: post.date, instagram })
      : supportTemplateVars(artist, { takesTips: Boolean(page.tips?.enabled), instagram });
    const rendered = renderVariant(DEFAULT_TEMPLATES[post.kind], post.templateIndex, vars);

    const day = new Date(`${post.date}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
    const image = post.imageKey ? `${post.imageKey}${post.imageOnInstagram ? '' : ' (not on Instagram)'}` : 'no image (not on Instagram)';
    console.log(`${day.padEnd(14)} ${post.kind.padEnd(16)} ${release?.title ?? '(support)'}  [${image}]`);
    console.log(`  ${rendered ? rendered.text.replace(/\n/g, '\n  ') : '!! no variant could be filled; this post would not go out'}`);
    console.log('');
  }

  const weekCount = new Set(posts.map(p => p.date)).size;
  console.log(`${posts.length} posts on ${weekCount} days. By kind: ${[...counts].map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}`);
  const never = qualifying.filter(r => !mentions.has(r.slug)).map(r => r.title);
  console.log(`Releases not mentioned in this window: ${never.length ? never.join('; ') : 'none'}\n`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
