import { edgeEnv } from "../shared/edge-context.ts";
import type { Context } from "../shared/edge-context.ts";
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { PLATFORMS } from "../shared/platform-registry.ts";
import { isBandcampFriday } from "../shared/bandcamp-friday.ts";
import { SOCIAL_ICON_PATHS } from "../shared/social-icon-paths.ts";
import { mainLinkDividerIndexes } from "../shared/link-dividers.ts";
import {
  groupLinksIntoSections,
  resolveSectionOrder,
  type PageSectionKey,
} from "../shared/page-sections.ts";
import { leadingOfferSummary, orderedSourcePlatforms, formatReleaseDate, releaseTypeLabel } from "../shared/release-display.ts";
import { isSocialCrawler, isIndexingCrawler } from "../shared/crawler-detection.ts";
import { safeEmbedStyle } from "../shared/embed-style.ts";
import { MAX_OPEN_GOALS } from "../shared/tips.ts";
import { FLAGS_HASH_KEY, TIPS_FANS_FLAG_FIELD, flagIsOn } from "../shared/tips-flag.ts";
import {
  stripeModeFromKey,
  isTipAccountTakingTips,
  renderTipSection,
  type OpenGoal,
  type TipAccountSnapshot,
} from "../shared/artist-page-tips.ts";

/**
 * How many releases to list before summarising the rest.
 *
 * Most catalogues fit: 16 for Sufjan Stevens, 13 for Explosions in the Sky. The cap exists for
 * the artists who don't — one live Mirlo artist has 33 releases including *Inaction I–V* — where
 * an unbounded list would bury the platform links this page exists to show.
 */
const MAX_RELEASES_SHOWN = 24;

/**
 * A day, not the five minutes this used to be.
 *
 * This render only ever reaches crawlers — real browsers are handed to the SPA above, before any
 * database query — so the only thing a long TTL delays is how quickly Google sees an edit, and a
 * day is well inside how often it recrawls. Meanwhile each miss costs four Supabase queries, one
 * of them a two-level nested embed over `releases`, and there are ~800 of these pages for
 * crawlers to sweep.
 *
 * Claimed-artist edits don't wait for the TTL: they purge the `artist-${slug}` tag below (see
 * purgeArtistCaches in api/functions/artist-releases.ts and artist-profile.ts).
 *
 * **Inert as things stand.** Netlify caches an edge function's response only when the function
 * opts in (`cache = "manual"`), and this one doesn't, so every crawler hit runs the queries above.
 * Opting in isn't a one-line fix here the way it was for release-page: this URL answers crawlers
 * with this render and browsers with the SPA, and the CDN's cache key is the URL, so a cached
 * crawler render would be served to people. Caching it needs the key to vary on the crawler
 * decision first.
 */
const CDN_CACHE_CONTROL = 'public, s-maxage=86400, stale-while-revalidate=86400';

interface ReleaseRow {
  slug: string;
  title: string;
  release_type: string;
  release_date: string | null;
  date_precision: string | null;
  status: string;
  artwork_url: string | null;
  release_sources: {
    platform: string;
    release_offers: { price: number | null; currency: string | null; availability: string }[] | null;
  }[] | null;
}

// Allowed embed domains for featured releases (must match api/functions/artist-profile.ts)
const ALLOWED_EMBED_DOMAINS = [
  'bandcamp.com',
  'youtube.com',
  'youtube-nocookie.com',
  'soundcloud.com',
  'open.spotify.com',
  'embed.music.apple.com',
  'w.soundcloud.com',
  'player.vimeo.com',
  'embed.tidal.com',
];

// Derive PLATFORM_INFO from shared registry
const PLATFORM_INFO: Record<string, { name: string; color: string; icon: string; category: string; payoutPercent?: string }> = {};
for (const [id, p] of Object.entries(PLATFORMS)) {
  PLATFORM_INFO[id] = { name: p.name, color: p.color, icon: p.icon, category: p.category, ...(p.payoutPercent && { payoutPercent: p.payoutPercent }) };
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * The social marks this page draws, built from the shared path data so the SPA can draw the same
 * ones. It used to hold the SVG strings itself, which is how the SPA ended up rendering the word
 * `youtube` where this page rendered the icon — see api/shared/social-icon-paths.ts.
 */
const SOCIAL_ICONS: Record<string, string> = Object.fromEntries(
  Object.entries(SOCIAL_ICON_PATHS).map(([platform, icon]) => [
    platform,
    `<svg width="16" height="16" viewBox="0 0 24 24" fill="${icon.brandColor}"><path d="${icon.d}"/></svg>`,
  ]),
);

const LOGO_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 110 110" aria-hidden="true"><defs><filter id="gs"><feColorMatrix type="saturate" values="0"/></filter></defs><g transform="translate(22,22) scale(1.8333)" filter="url(#gs)"><path fill="#50A5E6" d="M30 22c-3 0-6.688 7.094-7 10-.421 3.915 2 4 2 4h11V26s-3.438-4-6-4z"/><ellipse transform="rotate(-60 27.574 28.49)" fill="#1C6399" cx="27.574" cy="28.489" rx="5.848" ry="1.638"/><path fill="#F9CA55" d="M20.086 0c1.181 0 2.138.957 2.138 2.138 0 .789.668 10.824.668 10.824L17.948 18V2.138C17.948.957 18.905 0 20.086 0z"/><path fill="#FFDC5D" d="M18.875 4.323c0-1.099.852-1.989 1.903-1.989 1.051 0 1.903.891 1.903 1.989 0 0 .535 5.942 1.192 9.37.878 1.866 1.369 4.682 1.261 6.248.054.398 5.625 5.006 5.625 5.006-.281 1.813-2.259 6.155-4.759 8.159l-3.521-2.924c-2.885-.404-4.458-3.331-4.458-4.264 0-2.984.854-21.595.854-21.595z"/><path fill="#50A5E6" d="M6 22c3 0 6.688 7.094 7 10 .421 3.915-2 4-2 4H0V26s3.438-4 6-4z"/><ellipse transform="rotate(-30 8.424 28.489)" fill="#1C6399" cx="8.426" cy="28.489" rx="1.638" ry="5.848"/><path fill="#F9CA55" d="M16.061.011c-1.266-.127-2.333.864-2.333 2.103 0 .78-.184 10.319-.184 10.319L17.895 18l.062-15.765c0-1.106-.795-2.114-1.896-2.224z"/><path fill="#FFDC5D" d="M17.125 4.323c0-1.099-.852-1.989-1.903-1.989-1.051 0-1.903.891-1.903 1.989 0 0-.535 5.942-1.192 9.37-.878 1.866-1.369 4.682-1.261 6.248-.054.398-5.625 5.006-5.625 5.006C5.522 26.76 7.5 31.102 10 33.106l3.521-2.924c2.885-.404 4.458-3.331 4.458-4.264 0-2.984-.854-21.595-.854-21.595z"/><path fill="#F9CA55" d="M17.958 25.823c-.414 0-.75-.336-.75-.75V2.792c0-.414.336-.75.75-.75s.75.336.75.75v22.282c.001.413-.335.749-.75.749z"/></g><path d="M14,52 A41,41 0 0,1 96,52" fill="none" stroke="currentColor" stroke-width="8" stroke-linecap="round"/><line x1="14" y1="52" x2="14" y2="64" stroke="currentColor" stroke-width="7" stroke-linecap="round"/><line x1="96" y1="52" x2="96" y2="64" stroke="currentColor" stroke-width="7" stroke-linecap="round"/><rect x="3" y="60" width="22" height="28" rx="9" fill="currentColor"/><rect x="85" y="60" width="22" height="28" rx="9" fill="currentColor"/></svg>';

/**
 * One release in the list: artwork, title, and the cheapest way to own it.
 *
 * The price is the point. A chronology of titles is something a dozen sites already have; "from
 * $8" next to it is the thing that makes this list worth clicking, and it comes straight from
 * the offers the release page shows in full.
 */
function renderReleaseRow(release: ReleaseRow, artistSlug: string): string {
  const href = `/a/${encodeURIComponent(artistSlug)}/${encodeURIComponent(release.slug)}`;
  const title = escapeHtml(release.title);
  const date = formatReleaseDate(release.release_date, release.date_precision);

  const sources = (release.release_sources || []).map(s => ({ platform: s.platform, offers: s.release_offers || [] }));

  // Capitalized in the helper rather than with `text-transform: capitalize`, which applies to the
  // whole line and would turn "from $7" into "From $7" and "Name your price" into "Name Your Price".
  const type = releaseTypeLabel(release.release_type, sources.map(s => s.platform));
  // leadingOfferSummary, not the globally cheapest price across every source — see the
  // function's own doc for why picking the absolute cheapest could rank a Discogs secondhand
  // listing above a Bandcamp direct purchase.
  const meta = [type, date, leadingOfferSummary(sources)].filter(Boolean).join(' · ');

  // Same artist-paying-first order as the summary above and the release page itself.
  const platformsHtml = orderedSourcePlatforms(sources)
    .map(p => {
      const info = PLATFORM_INFO[p];
      return `<span title="${escapeHtml(info?.name || p)}" style="font-size:13px">${info?.icon || '🔗'}</span>`;
    })
    .join('');

  const art = release.artwork_url
    ? `<img src="${escapeHtml(release.artwork_url)}" alt="" loading="lazy" referrerpolicy="no-referrer" style="width:48px;height:48px;border-radius:6px;object-fit:cover;flex-shrink:0;background:var(--bg2)">`
    : `<div style="width:48px;height:48px;border-radius:6px;flex-shrink:0;background:var(--bg2);display:flex;align-items:center;justify-content:center;font-size:20px">💿</div>`;

  // An upcoming release is the most interesting row in the list and the easiest to miss when
  // it's sorted to the top of a chronology that otherwise reads as history.
  const upcoming = release.status === 'announced'
    ? '<span style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;color:var(--accent);flex-shrink:0">Coming</span>'
    : '';

  return `<a href="${href}" style="display:flex;align-items:center;gap:12px;padding:8px 12px;border-radius:12px;border:1px solid var(--border);text-decoration:none;color:var(--text)">
    ${art}
    <span style="flex:1;min-width:0">
      <span style="display:block;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${title}</span>
      ${meta ? `<span style="display:block;font-size:13px;color:var(--muted)">${escapeHtml(meta)}</span>` : ''}
      ${platformsHtml ? `<span style="display:flex;gap:4px;margin-top:2px">${platformsHtml}</span>` : ''}
    </span>
    ${upcoming}
  </a>`;
}

function isEmbedDomainAllowed(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    const hostname = parsed.hostname.toLowerCase();
    return ALLOWED_EMBED_DOMAINS.some(
      d => hostname === d || hostname.endsWith('.' + d)
    );
  } catch {
    return false;
  }
}

/**
 * Section headings as the crawler page shows them — the same labels the SPA renders
 * (RichArtistProfile SECTION_HEADINGS) and the edit page uses.
 */
const SECTION_HEADINGS: Record<PageSectionKey, string> = {
  patronage: 'Patronage',
  bio: 'Bio',
  featured: 'Featured Release',
  marketplaces: 'Marketplaces',
  official: 'Official',
  social: 'Follow',
};

/**
 * Claimed-page sections, in the artist's saved order (UNS-221). The crawler's view of the same
 * arrangement RichArtistProfile renders: patronage (with the Tip block first inside it, using
 * the shared renderTipSection), bio, featured release, marketplaces (+ the pinned Official
 * section), Follow — skipping sections with nothing to show.
 */
function renderClaimedSections({
  profile,
  platformsFiltered,
  tipSectionHtml,
  featuredEmbedHtml,
  bioHtml,
}: {
  profile: { section_order?: unknown } | null;
  platformsFiltered: { platform: string; url: string; display_name?: string }[];
  isMainPlatform: (p: { platform: string }) => boolean;
  tipSectionHtml: string;
  featuredEmbedHtml: string;
  bioHtml: string;
}): string {
  const sectionOrder = resolveSectionOrder(profile?.section_order) as PageSectionKey[];

  // Group the artist's stored link order by section (the sectionCategory field on the
  // registry decides where each link lands; unknown platforms ride in marketplaces).
  // Dividers the artist placed between main links become per-section rules — a rule at a
  // section boundary renders as the section gap, not a stray rule.
  const groups = groupLinksIntoSections(platformsFiltered, (p: { platform: string }) =>
    PLATFORMS[p.platform]?.sectionCategory, []);

  const sectionRuleIndexes = new Map(
    groups.map(g => [g.key, g.ruleIndexes]),
  );

  // One pill list per link section, rebuilt from the shared groups (the old flat
  // platformLinksHtml interleaved patronage and marketplaces under one heading).
  const linkRow = (p: { platform: string; url: string; display_name?: string }): string => {
    const info = PLATFORMS[p.platform];
    const isOther = p.platform === 'other' || p.platform.startsWith('other_');
    const linkName = isOther ? escapeHtml(p.display_name || 'Link') : (info?.name || escapeHtml(p.display_name || p.platform));
    const linkColor = info?.color || '#71717a';
    const linkIcon = info ? (SOCIAL_ICONS[p.platform] ? `<span style="font-size:16px">${SOCIAL_ICONS[p.platform]}</span>` : info.icon) : '🔗';
    const isBCFriday = p.platform === 'bandcamp' && isBandcampFriday();
    const payout = isBCFriday ? '~97%' : info?.payoutPercent;
    const payoutLabel = payout ? `<span style="font-size:12px;color:var(--muted)">${payout} to artist</span>` : '';
    const bcFridayLabel = isBCFriday ? '<span style="font-size:12px;font-weight:700;color:#1da0c3;animation:bc-pulse 2s ease-in-out infinite">Bandcamp Friday!</span>' : '';
    return `<a href="${escapeHtml(p.url)}" target="_blank" rel="noopener noreferrer" style="display:flex;align-items:center;gap:12px;padding:12px 16px;border-radius:12px;border:1px solid ${isBCFriday ? '#1da0c340' : 'var(--border)'};background:${isBCFriday ? '#1da0c310' : linkColor + '08'};text-decoration:none;color:var(--text);transition:background 0.15s">
      <span style="font-size:20px;display:inline-flex;align-items:center;justify-content:center">${linkIcon}</span>
      <span style="flex:1;font-weight:500">${linkName}</span>
      ${payoutLabel}${bcFridayLabel}
    </a>`;
  };

  // Rows with rules between them, per section — the mirror of SectionPillGroups in the SPA.
  const pillGroupsHtml = (section: PageSectionKey): string => {
    const group = groups.find(g => g.key === section);
    if (!group || group.items.length === 0) return '';
    const rules = new Set(sectionRuleIndexes.get(section) ?? []);
    const rows: string[][] = [];
    let current: string[] = [];
    group.items.forEach((item, index) => {
      if (rules.has(index) && current.length > 0) {
        rows.push(current);
        current = [];
      }
      current.push(linkRow(item as { platform: string; url: string; display_name?: string }));
    });
    if (current.length > 0) rows.push(current);
    return rows
      .map((row, i) => `
        ${i > 0 ? '<hr style="border:0;border-top:1px solid var(--border);margin:4px 0">' : ''}
        <div style="display:grid;gap:8px">${row.join('')}</div>`)
      .join('');
  };

  const sectionHtmlFor = (key: PageSectionKey): string => {
    switch (key) {
      case 'patronage': {
        const linkHtml = pillGroupsHtml('patronage');
        if (!tipSectionHtml && !linkHtml) return '';
        return `
        <div style="margin-bottom:24px">
          <h2 style="font-size:12px;text-transform:uppercase;letter-spacing:0.05em;color:var(--muted);margin-bottom:12px">Patronage</h2>
          ${tipSectionHtml ? tipSectionHtml : ''}
          ${linkHtml}
        </div>`;
      }
      case 'bio':
        return bioHtml ? `
        <div style="margin-bottom:24px">
          <h2 style="font-size:12px;text-transform:uppercase;letter-spacing:0.05em;color:var(--muted);margin-bottom:12px">Bio</h2>
          ${bioHtml}
        </div>` : '';
      case 'featured':
        return featuredEmbedHtml ? `
        <div style="margin-bottom:24px">
          <h2 style="font-size:12px;text-transform:uppercase;letter-spacing:0.05em;color:var(--muted);margin-bottom:12px">Featured Release</h2>
          ${featuredEmbedHtml}
        </div>` : '';
      default: {
        // marketplaces, and official pinned directly after it (not artist-orderable).
        const linkHtml = pillGroupsHtml(key);
        if (!linkHtml) return '';
        return `
        <div style="margin-bottom:24px">
          <h2 style="font-size:12px;text-transform:uppercase;letter-spacing:0.05em;color:var(--muted);margin-bottom:12px">${SECTION_HEADINGS[key]}</h2>
          ${linkHtml}
        </div>`;
      }
    }
  };

  return sectionOrder
    .flatMap((key): PageSectionKey[] => (key === 'marketplaces' ? ['marketplaces', 'official'] : [key]))
    .map(sectionHtmlFor)
    .join('');
}

function buildSafeEmbed(featuredEmbed: string | null): string {
  if (!featuredEmbed || !featuredEmbed.trim()) return '';

  // Extract iframe src
  const iframeMatch = featuredEmbed.match(/<iframe[^>]*\ssrc=["']([^"']+)["'][^>]*>/i);
  if (!iframeMatch) return '';

  const src = iframeMatch[1];
  if (!isEmbedDomainAllowed(src)) {
    // Not in allowlist — render a safe placeholder instead
    return '<div style="border-radius:12px;overflow:hidden;border:1px solid var(--border);padding:32px 16px;text-align:center;color:var(--muted);font-size:16px;background:var(--bg2)">Featured Release</div>';
  }

  // Extract dimensions if present
  const widthMatch = featuredEmbed.match(/\bwidth=["']([^"']+)["']/i);
  const heightMatch = featuredEmbed.match(/\bheight=["']([^"']+)["']/i);
  const styleMatch = featuredEmbed.match(/\bstyle=["']([^"']+)["']/i);

  let iframeAttrs = `src="${escapeHtml(src)}" sandbox="allow-scripts allow-same-origin" loading="lazy"`;
  if (widthMatch) iframeAttrs += ` width="${escapeHtml(widthMatch[1])}"`;
  if (heightMatch) iframeAttrs += ` height="${escapeHtml(heightMatch[1])}"`;
  const style = styleMatch ? safeEmbedStyle(styleMatch[1]) : null;
  if (style) iframeAttrs += ` style="${escapeHtml(style)}"`;
  if (/\ballowfullscreen\b/i.test(featuredEmbed)) iframeAttrs += ' allowfullscreen';
  // title is required for axe frame-title (wcag2a); the safe rebuild drops
  // everything but the attrs above, so supply our own.
  iframeAttrs += ' title="Featured release player"';

  return `<div style="border-radius:12px;overflow:hidden"><iframe ${iframeAttrs}></iframe></div>`;
}

/**
 * How long a read of the tips flag is reused. This render only reaches crawlers, there are ~800
 * of these pages for them to sweep, and a flag flip only has to reach Google within a minute — so
 * one read a minute per warm instance is worth far more than an instant switch.
 */
const TIPS_FLAG_CACHE_MS = 60_000;

/** The module-level flag cache: one value, for the life of one warm edge instance. */
let tipsFlagCache: { value: boolean; expiresAt: number } | null = null;

/**
 * The `tipsFans` feature flag (UNS-215), read straight off Upstash over its REST API.
 *
 * The fan-facing half of the split: an artist may already have onboarded with Stripe while this
 * stays off, and this page must not advertise a tip until fans are allowed to give one.
 *
 * A second reader of the same hash, not a second decision: edge functions run on Deno and cannot
 * import api/functions/feature-flags.ts (which pulls in the Upstash SDK and Sentry), so the value
 * is fetched here and applied by the shared api/shared/tips-flag.ts. The env names are the ones
 * the node side's client uses (api/functions/redis.ts), deliberately: if one side is renamed, the
 * flag fails closed here rather than the two sides disagreeing silently.
 *
 * Fails closed, exactly like the node store — no env, a non-200, a body with no result, a failed
 * fetch — because a flag that reads "on" by accident would publish a half-built feature to every
 * crawler. The answer, including an off one, is cached for a minute: that bounds a hot SEO page
 * to one read a minute, and delays recovery from a blip by the same minute.
 */
async function readTipsFlag(): Promise<boolean> {
  const now = Date.now();
  if (tipsFlagCache && now < tipsFlagCache.expiresAt) return tipsFlagCache.value;

  const url = edgeEnv("UPSTASH_REDIS_REST_URL");
  const token = edgeEnv("UPSTASH_REDIS_REST_TOKEN");

  let raw: unknown;
  if (url && token) {
    try {
      // HGET sent as a command body — the hash read Upstash's REST API expects ({ result: "on" }).
      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(["HGET", FLAGS_HASH_KEY, TIPS_FANS_FLAG_FIELD]),
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) raw = ((await res.json()) as { result?: unknown }).result;
      else console.error(`[artist-page-static] tips flag read failed: HTTP ${res.status}`);
    } catch (err) {
      console.error("[artist-page-static] tips flag read failed:", String(err));
    }
  } else {
    console.error("[artist-page-static] tips flag read skipped: Upstash env not configured");
  }

  const value = flagIsOn(raw);
  tipsFlagCache = { value, expiresAt: now + TIPS_FLAG_CACHE_MS };
  return value;
}

/**
 * Open goals for a claimed artist who is taking tips right now, or null when they aren't (or the
 * read failed) — null renders no tips block at all. The same rules as `getTipsLiveSlugs` and
 * `getGoals` in api/functions/tips-db.ts, duplicated because edge functions can't import from
 * api/functions; the pure parts live in api/shared/artist-page-tips.ts.
 *
 * Fails closed: a failed account read hides the Tip link rather than failing the page. A failed
 * goals read keeps the link and drops the goals — they're decoration, as on the SPA's page.
 * Edge functions have no Sentry here, so failures go to the function log.
 */
async function readTipGoals(
  supabase: SupabaseClient,
  artistId: string,
  ownerUserId: string | null | undefined,
): Promise<OpenGoal[] | null> {
  // UNS-215: the flag gates this render too, and it is checked before anything else so a flag-off
  // rollout costs no Supabase query and can't leak a Tip link through any later branch.
  if (!(await readTipsFlag())) return null;

  // Tips ship dark: no Stripe key (or an unrecognised one) means no tips block and no queries.
  // Only the key's prefix is read, to keep test and live rows apart exactly as the functions do.
  const mode = stripeModeFromKey(edgeEnv("STRIPE_SECRET_KEY"));
  if (!mode || !ownerUserId) return null;
  const livemode = mode === 'live';

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 2000);
  try {
    const { data: account, error: accountError } = await supabase
      .from('artist_tip_accounts')
      .select('user_id, charges_enabled, tips_enabled, tips_approved_at, deauthorized_at')
      .eq('artist_id', artistId)
      .eq('livemode', livemode)
      .abortSignal(controller.signal)
      .maybeSingle();
    if (accountError) throw new Error(`artist_tip_accounts: ${accountError.message}`);
    if (!isTipAccountTakingTips(account as TipAccountSnapshot | null, ownerUserId)) return null;

    try {
      const { data: goalRows, error: goalsError } = await supabase
        .from('artist_goals')
        .select('id, title, target_cents')
        .eq('artist_id', artistId)
        .eq('status', 'open')
        .eq('livemode', livemode)
        .order('created_at', { ascending: false })
        .limit(MAX_OPEN_GOALS)
        .abortSignal(controller.signal);
      if (goalsError) throw new Error(`artist_goals: ${goalsError.message}`);
      const rows = (goalRows ?? []) as { id: string; title: string; target_cents: number }[];
      if (rows.length === 0) return [];

      const { data: progress, error: progressError } = await supabase
        // No generated Database type here, so supabase-js can't type this function's
        // arguments. The shape is checked by get_goal_progress itself.
        .rpc('get_goal_progress' as never, { p_goal_ids: rows.map(r => r.id), p_livemode: livemode } as never)
        .abortSignal(controller.signal);
      if (progressError) throw new Error(`get_goal_progress: ${progressError.message}`);
      const raised = new Map<string, number>();
      for (const p of (progress ?? []) as { goal_id: string; raised_cents: number | string }[]) {
        raised.set(p.goal_id, Number(p.raised_cents));
      }
      return rows.map(r => ({ id: r.id, title: r.title, targetCents: r.target_cents, raisedCents: raised.get(r.id) ?? 0 }));
    } catch (err) {
      console.error('[artist-page-static] goals read failed:', String(err));
      return [];
    }
  } catch (err) {
    console.error('[artist-page-static] tip account read failed:', String(err));
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

const CSS = `
  :root { --bg: #121212; --bg2: #1a1a1a; --text: #f0f0f0; --muted: #999; --border: #2a2a2a; --accent: #ff6b35; --footer-border: #1a1a1a; }
  @media (prefers-color-scheme: light) {
    :root { --bg: #fafafa; --bg2: #f5f5f5; --text: #1a1a1a; --muted: #555; --border: #e0e0e0; --accent: #e55a2b; --footer-border: #e0e0e0; }
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Stack Sans Headline', system-ui, sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; display: flex; flex-direction: column; }
  h1, h2 { font-family: 'Darker Grotesque', 'Stack Sans Headline', system-ui, sans-serif; }
  a { color: inherit; }
  .container { max-width: 640px; margin: 0 auto; padding: 0 24px; width: 100%; }
  .page-content { position: relative; flex: 1; display: flex; flex-direction: column; }
  @keyframes bc-pulse { 0%, 100% { opacity: 0.7; } 50% { opacity: 1; } }
  .site-header { padding: 16px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; gap: 16px; }
  .site-header .brand { display: flex; align-items: center; gap: 8px; font-size: 20px; font-weight: 700; color: var(--text); text-decoration: none; flex-shrink: 0; }
  .site-header .brand:hover { opacity: 0.8; }
  .site-header .brand svg { flex-shrink: 0; }
  .site-header .header-search { display: flex; gap: 8px; flex: 1; max-width: 420px; margin: 0 auto; }
  .site-header .header-search input { flex: 1; min-width: 0; background: var(--bg2); border: 1px solid var(--border); border-radius: 8px; padding: 8px 12px; font-size: 14px; color: var(--text); font-family: inherit; }
  .site-header .header-search input:focus { outline: none; border-color: var(--accent); }
  .site-header .header-search button { border: 0; border-radius: 8px; padding: 8px 14px; background: var(--accent); color: #fff; font-size: 14px; font-weight: 500; cursor: pointer; font-family: inherit; }
  @media (max-width: 640px) { .site-header .header-search { display: none; } }
  .site-header .nav-right { display: flex; align-items: center; gap: 12px; font-size: 14px; }
  .site-header .nav-link { color: var(--muted); text-decoration: none; }
  .site-header .nav-link:hover { color: var(--text); }
  .site-header .nav-accent { color: var(--accent); text-decoration: none; font-weight: 500; }
  .site-header .nav-accent:hover { text-decoration: underline; }
  .claim-cta { display: inline-block; margin-top: 24px; padding: 10px 24px; border-radius: 12px; background: var(--accent); color: #fff; font-weight: 600; font-size: 15px; text-decoration: none; }
  .claim-cta:hover { opacity: 0.9; }
  .avatar-wrap { width:128px;height:128px;border-radius:50%;border:2px solid var(--border);margin:0 auto 16px;display:flex;align-items:center;justify-content:center;overflow:hidden;background:var(--bg2) }
  .avatar-wrap img { width:100%;height:100%;object-fit:cover }
  .avatar-fallback { font-size:48px;font-weight:600;color:var(--muted) }
`;

export default async function handler(request: Request, context: Context) {
  try {
    const url = new URL(request.url);
    const slug = url.pathname.replace(/^\/(a|artist)\//, '').replace(/\/$/, '');

    if (!slug) return context.next();

    // Real browsers get the SPA, same as a client-side <Link> navigation from /artists would
    // render — so a direct load and an in-app click produce the same UI (see
    // docs/postmortems/UNS-100-bifurcation-retro.md). Only crawlers, which either can't run JS
    // (social previews) or benefit from content that doesn't wait on a client fetch (indexing),
    // get this static render.
    const userAgent = request.headers.get('user-agent');
    if (!isSocialCrawler(userAgent) && !isIndexingCrawler(userAgent)) {
      return context.next();
    }

    const supabaseUrl = edgeEnv("SUPABASE_URL");
    const supabaseKey = edgeEnv("SUPABASE_SERVICE_KEY");
    if (!supabaseUrl || !supabaseKey) return context.next();

    const supabase = createClient(supabaseUrl, supabaseKey);

    // 5-second timeout for Supabase fetches
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    let artist: any;
    let profile: any;
    let links: any[];
    let releases: ReleaseRow[] = [];
    let releaseCount = 0;

    try {
      const { data: artistData } = await supabase
        .from('artists')
        .select('*')
        .eq('slug', slug)
        .abortSignal(controller.signal)
        .single();

      artist = artistData;

      // A retired slug still resolves: the artist was merged into another row, or re-slugged when
      // accent folding was fixed (`bj-rk` -> `bjork`). Checked only *after* the live slug misses, so
      // a real artist who later takes that slug always wins.
      //
      // A 301 rather than rendering the page here — this branch only ever serves crawlers, and
      // rendering identical content at two URLs is duplicate content plus a second page competing
      // with the canonical one. Humans never reach this code (see the crawler check above): they
      // fall through to the SPA, whose data endpoint resolves the alias itself.
      //
      // Duplicates resolveArtistSlugAlias in api/functions/db.ts — edge functions run on Deno and
      // cannot import from api/functions.
      if (!artist) {
        const { data: alias } = await supabase
          .from('artist_slug_aliases')
          .select('artists!inner(slug)')
          .eq('alias', slug.toLowerCase())
          .abortSignal(controller.signal)
          .maybeSingle();

        const canonical = (alias as { artists?: { slug?: string } } | null)?.artists?.slug;
        clearTimeout(timeoutId);
        if (!canonical) return context.next();

        const prefix = url.pathname.startsWith('/artist/') ? '/artist/' : '/a/';
        return new Response(null, {
          status: 301,
          headers: { Location: `${prefix}${canonical}`, 'Cache-Control': 'public, max-age=3600' },
        });
      }

      const { data: profileData } = await supabase
        .from('artist_profiles')
        .select('*')
        .eq('artist_id', artist.id)
        .abortSignal(controller.signal)
        .single();

      profile = profileData;

      const { data: linksData } = await supabase
        .from('artist_links')
        .select('*')
        .eq('artist_id', artist.id)
        .order('display_order', { ascending: true, nullsFirst: false })
        .abortSignal(controller.signal);

      links = linksData || [];

      // Releases, in the artist's own order where they set one and newest first otherwise.
      // `count: 'exact'` alongside a limit gives the full total in the same round trip, so the
      // "and N more" line is a real number rather than a guess.
      //
      // The ordering must stay identical to `getArtistReleases` in api/functions/db.ts — this is
      // the crawler's view of the same page the SPA renders, and the two disagreeing on release
      // order is the two-renderers trap in miniature. display_order leads (NULLS LAST, so it's
      // inert until a claimed artist arranges their catalogue); the chronological part matches
      // idx_releases_artist_chrono, where created_at is the tiebreaker that stops undated rows —
      // grid ingest gets identity and artwork but no dates — shuffling between requests.
      const { data: releasesData, count } = await supabase
        .from('releases')
        .select(
          'slug, title, release_type, release_date, date_precision, status, artwork_url,' +
          ' release_sources ( platform, release_offers ( price, currency, availability ) )',
          { count: 'exact' }
        )
        .eq('artist_id', artist.id)
        .eq('is_hidden', false)
        .order('display_order', { ascending: true, nullsFirst: false })
        .order('release_date', { ascending: false, nullsFirst: false })
        .order('created_at', { ascending: false })
        .limit(MAX_RELEASES_SHOWN)
        .abortSignal(controller.signal);

      releases = (releasesData as unknown as ReleaseRow[]) || [];
      releaseCount = count ?? releases.length;
    } catch (e: any) {
      // Timeout or error — fall through to SPA
      clearTimeout(timeoutId);
      return context.next();
    }

    clearTimeout(timeoutId);

    const isClaimed = artist.match_confidence === 'claimed' && profile?.verified_at;

    // Filter out search/engine links
    const platforms = links.filter((l: { url: string }) => {
      const u = l.url.toLowerCase();
      return !u.includes('duckduckgo.com') && !u.includes('google.com/search') && !u.includes('searchstyle=search');
    });

    const imageUrl = (isClaimed && profile?.custom_image_url) || artist.image_url || '';
    const artistName = escapeHtml(artist.name);
    const pageUrl = `https://unstream.stream/a/${slug}`;

    // Separate main platforms from social
    const isMainPlatform = (p: { platform: string }) => {
      const info = PLATFORM_INFO[p.platform];
      return !info || info.category !== 'social';
    };
    const mainPlatforms = platforms.filter(isMainPlatform);
    const socialPlatforms = platforms.filter((p: { platform: string }) => {
      const info = PLATFORM_INFO[p.platform];
      return info?.category === 'social';
    });

    // Artist-placed dividers, translated into indexes in mainPlatforms
    const dividerIndexes = new Set(
      isClaimed ? mainLinkDividerIndexes(platforms, isMainPlatform, profile?.link_dividers) : []
    );

    const bcFriday = isBandcampFriday();

    // Releases, shared by the claimed and unclaimed templates below.
    //
    // Rendered for every artist that has a catalogue, not only verified ones. The releases come
    // from the artist's stored Bandcamp link — which this page is *already* showing as a place
    // to buy — so listing what's behind that link asserts nothing the page doesn't already
    // assert. Gating on verification would hide the feature from nearly every artist, since
    // almost none are claimed.
    //
    // Nothing renders when there are no releases. An empty "Releases" heading reads as broken,
    // while its absence reads as "nothing here yet" — which is the truth for any artist nobody
    // has saved or searched, because cataloguing is demand-driven.
    const releasesHtml = releases.length === 0 ? '' : `
      <div style="margin-top:24px">
        <h2 style="font-size:12px;text-transform:uppercase;letter-spacing:0.05em;color:var(--muted);margin-bottom:12px">Releases</h2>
        <div style="display:grid;gap:8px">
          ${releases.map((r: ReleaseRow) => renderReleaseRow(r, slug)).join('')}
        </div>
        ${releaseCount > releases.length
          ? `<p style="font-size:14px;color:var(--muted);margin-top:10px">and ${releaseCount - releases.length} more</p>`
          : ''}
      </div>
    `;

    // Build platform links HTML (shared by both claimed and unclaimed)
    const platformLinksHtml = mainPlatforms.map((p: { platform: string; url: string; display_name?: string }, index: number) => {
      const divider = dividerIndexes.has(index)
        ? '<hr style="border:0;border-top:1px solid var(--border);margin:4px 0">'
        : '';
      const info = PLATFORM_INFO[p.platform];
      const isOther = p.platform === 'other' || p.platform.startsWith('other_');
      const linkName = isOther ? escapeHtml(p.display_name || 'Link') : (info?.name || escapeHtml(p.display_name || p.platform));
      const linkColor = info?.color || '#71717a';
      const linkIcon = info ? (SOCIAL_ICONS[p.platform] ? `<span style="font-size:16px">${SOCIAL_ICONS[p.platform]}</span>` : info.icon) : '🔗';
      const isBCFriday = p.platform === 'bandcamp' && bcFriday;
      const payout = isBCFriday ? '~97%' : info?.payoutPercent;
      const payoutLabel = payout ? `<span style="font-size:12px;color:var(--muted)">${payout} to artist</span>` : '';
      const bcFridayLabel = isBCFriday ? '<span style="font-size:12px;font-weight:700;color:#1da0c3;animation:bc-pulse 2s ease-in-out infinite">Bandcamp Friday!</span>' : '';
      return `${divider}<a href="${escapeHtml(p.url)}" target="_blank" rel="noopener noreferrer" style="display:flex;align-items:center;gap:12px;padding:12px 16px;border-radius:12px;border:1px solid ${isBCFriday ? '#1da0c340' : 'var(--border)'};background:${isBCFriday ? '#1da0c310' : linkColor + '08'};text-decoration:none;color:var(--text);transition:background 0.15s">
        <span style="font-size:20px;display:inline-flex;align-items:center;justify-content:center">${linkIcon}</span>
        <span style="flex:1;font-weight:500">${linkName}</span>
        ${payoutLabel}${bcFridayLabel}
      </a>`;
    }).join('');

    const socialLinksHtml = socialPlatforms.length > 0 ? `
      <div style="margin-top:24px">
        <h2 style="font-size:12px;text-transform:uppercase;letter-spacing:0.05em;color:var(--muted);margin-bottom:12px">Follow</h2>
        <div style="display:flex;flex-wrap:wrap;gap:8px">
          ${socialPlatforms.map((p: { platform: string; url: string }) => {
            const info = PLATFORM_INFO[p.platform];
            if (!info) return '';
            const icon = SOCIAL_ICONS[p.platform] || info.icon;
            return `<a href="${escapeHtml(p.url)}" target="_blank" rel="noopener noreferrer" style="display:inline-flex;align-items:center;gap:8px;padding:8px 12px;border-radius:8px;border:1px solid var(--border);text-decoration:none;color:var(--text);font-size:16px">${icon} ${info.name}</a>`;
          }).join('')}
        </div>
      </div>
    ` : '';

    // Location
    const locationRegion = artist.country || artist.country_code;
    const locationText = artist.city && locationRegion
      ? `${artist.city}, ${locationRegion}`
      : artist.city || locationRegion || '';
    const locationHtml = locationText
      ? `<div style="margin-top:6px;color:var(--muted);font-size:16px">${escapeHtml(locationText)}</div>`
      : '';

    // JSON-LD structured data
    const sameAsUrls = platforms.map((p: { url: string }) => p.url);
    const jsonLd: Record<string, unknown> = {
      '@context': 'https://schema.org',
      '@type': 'MusicGroup',
      name: artist.name,
      url: pageUrl,
      ...(imageUrl ? { image: imageUrl } : {}),
      ...(isClaimed && profile?.bio ? { description: profile.bio } : {}),
      ...(isClaimed && sameAsUrls.length > 0 ? { sameAs: sameAsUrls } : {}),
      ...(locationText ? { foundingLocation: { '@type': 'Place', name: locationText } } : {}),
    };

    // --- Claimed artist: full rich profile ---
    if (isClaimed) {
      const bio = profile.bio ? escapeHtml(profile.bio) : '';
      const description = bio || `Support ${artist.name} directly on platforms that pay artists fairly.`;

      const featuredEmbedHtml = buildSafeEmbed(profile.featured_embed || '');

      // Only a claimed, verified profile can take tips, so the unclaimed template never asks.
      // Tip state is cached with the rest of the page (a day, purged by the artist-${slug} tag);
      // checkout re-checks eligibility on every request, so a stale link can't take a payment.
      const tipGoals = await readTipGoals(supabase, artist.id, profile.user_id);
      const tipSectionHtml = tipGoals ? renderTipSection(slug, artist.name, tipGoals) : '';

      // UNS-221: the claimed page renders its sections in the artist's saved order
      // (artist_profiles.section_order), the same model the SPA payload carries — this is the
      // crawler's view of the same page, so it must agree with RichArtistProfile. Official
      // pages are not artist-orderable and follow marketplaces wherever that lands; links
      // keep their own stored order and divider rules inside each section.
      const sectionHtml = renderClaimedSections({
        profile,
        platformsFiltered: platforms,
        isMainPlatform,
        tipSectionHtml,
        featuredEmbedHtml,
        bioHtml: bio ? `<p style="color:var(--muted);font-size:16px;margin-bottom:24px;text-align:left">${bio}</p>` : '',
      });

      const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${artistName} - Unstream | Listen on platforms that pay artists fairly</title>
  <meta name="description" content="${escapeHtml(description)}">
  <meta property="og:title" content="${artistName} - Unstream">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:url" content="${pageUrl}">
  <meta property="og:type" content="profile">
  <meta property="og:site_name" content="Unstream">
  ${imageUrl ? `<meta property="og:image" content="${escapeHtml(imageUrl)}">
  <meta property="og:image:alt" content="${artistName}">` : ''}
  <meta name="twitter:card" content="${imageUrl ? 'summary_large_image' : 'summary'}">
  <meta name="twitter:title" content="${artistName} - Unstream">
  <meta name="twitter:description" content="${escapeHtml(description)}">
  ${imageUrl ? `<meta name="twitter:image" content="${escapeHtml(imageUrl)}">` : ''}
  <link rel="canonical" href="${pageUrl}">
  <script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, '\\u003c')}</script>
  <link href="https://api.fonts.coollabs.io/css2?family=Darker+Grotesque:wght@300..900&family=Stack+Sans+Headline:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>${CSS}</style>
</head>
<body>
  <header class="site-header">
    <a href="/" class="brand">${LOGO_SVG} Unstream</a>
    <!-- Plain GET form, no JS: this page is pure SSR, so it can't render the
         React HeaderSearch. Submitting lands on /?q=… which is where the SPA
         renders results. Never point this at /search — that URL belongs to the
         noscript-search edge function. -->
    <form class="header-search" action="/" method="get" role="search">
      <input type="text" name="q" placeholder="Search artists..." aria-label="Search artists" enterkeyhint="search">
      <button type="submit">Search</button>
    </form>
  </header>

  <div class="page-content">
    <div class="container" style="padding-top:48px;padding-bottom:32px;text-align:center">
      <div class="avatar-wrap">
        ${imageUrl ? `<img src="${escapeHtml(imageUrl)}" alt="${artistName}" onerror="this.style.display='none';this.parentElement.querySelector('.avatar-fallback').style.display='flex'">` : ''}
        <span class="avatar-fallback" style="display:${imageUrl ? 'none' : 'flex'}">${escapeHtml((artist.name[0] || '?').toUpperCase())}</span>
      </div>
      <div style="display:flex;align-items:center;justify-content:center;gap:8px">
        <h1 style="font-size:28px;font-weight:700">${artistName}</h1>
        <span style="display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:999px;font-size:13px;font-weight:500;background:rgba(255,107,53,0.15);color:var(--accent)">
          <svg width="12" height="12" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/></svg>
          Verified
        </span>
      </div>
      ${locationHtml}
    </div>

    <div class="container" style="padding-bottom:32px">
      ${releasesHtml}
      ${sectionHtml}
    </div>
  </div>

  <div style="padding:24px 16px;text-align:center">
    <a href="https://unstream.stream" style="color:var(--text);text-decoration:none;font-weight:700;font-size:18px">Powered by Unstream</a>
    <p style="font-size:16px;color:var(--muted);margin-top:4px">Find music on platforms that pay artists fairly.</p>
  </div>

  <footer style="margin-top:auto;padding:24px 16px;border-top:1px solid var(--footer-border)">
    <div style="max-width:896px;margin:0 auto;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;font-size:16px;color:var(--muted)">
      <a href="https://bgreen.lol" target="_blank" rel="noopener noreferrer" style="color:var(--muted);text-decoration:none">Made with love in Massachusetts, USA</a>
      <nav style="display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:12px">
        <a href="/artists" style="color:var(--muted);text-decoration:none">Indie Artist Index</a>
        <span style="color:var(--muted);opacity:0.4;font-size:12px">&#x2022;</span>
        <a href="/platforms" style="color:var(--muted);text-decoration:none">Platforms</a>
        <span style="color:var(--muted);opacity:0.4;font-size:12px">&#x2022;</span>
        <a href="/changelog" style="color:var(--muted);text-decoration:none">Changelog</a>
        <span style="color:var(--muted);opacity:0.4;font-size:12px">&#x2022;</span>
        <a href="https://github.com/users/brandonlucasgreen/projects/4" target="_blank" rel="noopener noreferrer" style="color:var(--muted);text-decoration:none">Roadmap</a>
        <span style="color:var(--muted);opacity:0.4;font-size:12px">&#x2022;</span>
        <a href="https://github.com/brandonlucasgreen/unstream" target="_blank" rel="noopener noreferrer" style="color:var(--muted);text-decoration:none">Codebase</a>
        <span style="color:var(--muted);opacity:0.4;font-size:12px">&#x2022;</span>
        <a href="/support" style="color:var(--muted);text-decoration:none">Support</a>
        <span style="color:var(--muted);opacity:0.4;font-size:12px">&#x2022;</span>
        <a href="https://letterbird.co/hi-d2078591" target="_blank" rel="noopener noreferrer" style="color:var(--muted);text-decoration:none">Contact</a>
        <span style="color:var(--muted);opacity:0.4;font-size:12px">&#x2022;</span>
        <a href="/privacy-policy" style="color:var(--muted);text-decoration:none">Privacy policy</a>
        <span style="color:var(--muted);opacity:0.4;font-size:12px">&#x2022;</span>
        <a href="/terms" style="color:var(--muted);text-decoration:none">Terms of use</a>
      </nav>
    </div>
  </footer>
</body>
</html>`;

      return new Response(html, {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'public, max-age=0, must-revalidate',
          'CDN-Cache-Control': CDN_CACHE_CONTROL,
          'Cache-Tag': `artist-${slug}`,
        },
      });
    }

    // --- Unclaimed artist: simpler card ---
    const description = `Find ${artist.name} on platforms that pay artists fairly.`;

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${artistName} - Unstream | Find on platforms that pay artists fairly</title>
  <meta name="description" content="${escapeHtml(description)}">
  <meta property="og:title" content="${artistName} - Unstream">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:url" content="${pageUrl}">
  <meta property="og:type" content="profile">
  <meta property="og:site_name" content="Unstream">
  ${imageUrl ? `<meta property="og:image" content="${escapeHtml(imageUrl)}">
  <meta property="og:image:alt" content="${artistName}">` : ''}
  <meta name="twitter:card" content="${imageUrl ? 'summary_large_image' : 'summary'}">
  <meta name="twitter:title" content="${artistName} - Unstream">
  <meta name="twitter:description" content="${escapeHtml(description)}">
  ${imageUrl ? `<meta name="twitter:image" content="${escapeHtml(imageUrl)}">` : ''}
  <link rel="canonical" href="${pageUrl}">
  <script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, '\\u003c')}</script>
  <link href="https://api.fonts.coollabs.io/css2?family=Darker+Grotesque:wght@300..900&family=Stack+Sans+Headline:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>${CSS}</style>
</head>
<body>
  <header class="site-header">
    <a href="/" class="brand">${LOGO_SVG} Unstream</a>
    <!-- Plain GET form, no JS: this page is pure SSR, so it can't render the
         React HeaderSearch. Submitting lands on /?q=… which is where the SPA
         renders results. Never point this at /search — that URL belongs to the
         noscript-search edge function. -->
    <form class="header-search" action="/" method="get" role="search">
      <input type="text" name="q" placeholder="Search artists..." aria-label="Search artists" enterkeyhint="search">
      <button type="submit">Search</button>
    </form>
  </header>

  <div class="page-content">
    <div class="container" style="padding-top:48px;padding-bottom:32px;text-align:center">
      <div class="avatar-wrap">
        ${imageUrl ? `<img src="${escapeHtml(imageUrl)}" alt="${artistName}" onerror="this.style.display='none';this.parentElement.querySelector('.avatar-fallback').style.display='flex'">` : ''}
        <span class="avatar-fallback" style="display:${imageUrl ? 'none' : 'flex'}">${escapeHtml((artist.name[0] || '?').toUpperCase())}</span>
      </div>
      <h1 style="font-size:28px;font-weight:700">${artistName}</h1>
      ${locationHtml}
    </div>

    <div class="container" style="padding-bottom:32px">
      ${mainPlatforms.length > 0 ? `
        <h2 style="font-size:12px;text-transform:uppercase;letter-spacing:0.05em;color:var(--muted);margin-bottom:12px">Support directly</h2>
        <div style="display:grid;gap:8px">${platformLinksHtml}</div>
      ` : ''}
      ${socialLinksHtml}
      ${releasesHtml}
      <div style="margin-top:24px;padding:16px;border-radius:12px;border:1px solid var(--border);text-align:center">
        <p style="font-size:16px;color:var(--muted)">Are you ${artistName}?</p>
        <a href="/claim?slug=${escapeHtml(slug)}" class="claim-cta">Claim this profile</a>
      </div>
    </div>
  </div>

  <div style="padding:24px 16px;text-align:center">
    <a href="https://unstream.stream" style="color:var(--text);text-decoration:none;font-weight:700;font-size:18px">Powered by Unstream</a>
    <p style="font-size:16px;color:var(--muted);margin-top:4px">Find music on platforms that pay artists fairly.</p>
  </div>

  <footer style="margin-top:auto;padding:24px 16px;border-top:1px solid var(--footer-border)">
    <div style="max-width:896px;margin:0 auto;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;font-size:16px;color:var(--muted)">
      <a href="https://bgreen.lol" target="_blank" rel="noopener noreferrer" style="color:var(--muted);text-decoration:none">Made with love in Massachusetts, USA</a>
      <nav style="display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:12px">
        <a href="/artists" style="color:var(--muted);text-decoration:none">Indie Artist Index</a>
        <span style="color:var(--muted);opacity:0.4;font-size:12px">&#x2022;</span>
        <a href="/platforms" style="color:var(--muted);text-decoration:none">Platforms</a>
        <span style="color:var(--muted);opacity:0.4;font-size:12px">&#x2022;</span>
        <a href="/changelog" style="color:var(--muted);text-decoration:none">Changelog</a>
        <span style="color:var(--muted);opacity:0.4;font-size:12px">&#x2022;</span>
        <a href="https://github.com/users/brandonlucasgreen/projects/4" target="_blank" rel="noopener noreferrer" style="color:var(--muted);text-decoration:none">Roadmap</a>
        <span style="color:var(--muted);opacity:0.4;font-size:12px">&#x2022;</span>
        <a href="https://github.com/brandonlucasgreen/unstream" target="_blank" rel="noopener noreferrer" style="color:var(--muted);text-decoration:none">Codebase</a>
        <span style="color:var(--muted);opacity:0.4;font-size:12px">&#x2022;</span>
        <a href="/support" style="color:var(--muted);text-decoration:none">Support</a>
        <span style="color:var(--muted);opacity:0.4;font-size:12px">&#x2022;</span>
        <a href="https://letterbird.co/hi-d2078591" target="_blank" rel="noopener noreferrer" style="color:var(--muted);text-decoration:none">Contact</a>
        <span style="color:var(--muted);opacity:0.4;font-size:12px">&#x2022;</span>
        <a href="/privacy-policy" style="color:var(--muted);text-decoration:none">Privacy policy</a>
        <span style="color:var(--muted);opacity:0.4;font-size:12px">&#x2022;</span>
        <a href="/terms" style="color:var(--muted);text-decoration:none">Terms of use</a>
      </nav>
    </div>
  </footer>
</body>
</html>`;

    return new Response(html, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'public, max-age=0, must-revalidate',
        'CDN-Cache-Control': CDN_CACHE_CONTROL,
        'Cache-Tag': `artist-${slug}`,
      },
    });
  } catch {
    return context.next();
  }
}