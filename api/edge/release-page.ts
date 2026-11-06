// The release page: /a/{artist}/{release}
//
// A buying guide for one record — what formats exist, what they cost, and roughly how much
// reaches the artist. Odesli, the distributor landing pages and feature.fm all answer "where
// can I *stream* this", which is the opposite of what Unstream is for. Nobody answers this
// question, which is the whole reason the feature exists.
//
// **Pure SSR, and only SSR.** This URL is rendered here and nowhere else. The SPA must never
// try to take it over: one route with two renderers is the UNS-100 bifurcation class that
// produced a run of back-button and bfcache bugs where every fix partially reverted the last
// (see docs/postmortems/UNS-100-bifurcation-retro.md). Nothing on this page hydrates or re-renders
// client-side — the only script anywhere in it is an inline image-error fallback.
//
// **Route precedence.** netlify.toml declares this *before* `/a/*`, because `/a/*` also matches
// `/a/artist/release` and artist-page-static would otherwise answer first. The regex here
// matches exactly two path segments so single-segment artist URLs never reach it.

import { edgeEnv } from "../shared/edge-context.ts";
import type { Context } from "../shared/edge-context.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { PLATFORMS } from "../shared/platform-registry.ts";
import { isBandcampFriday } from "../shared/bandcamp-friday.ts";
import { platformLogoSvg } from "../shared/platform-logos.ts";
import { SITE_CHROME_CSS, siteFooterHtml, siteHeaderHtml } from "../shared/site-chrome.ts";
import {
  AVAILABILITY_LABELS,
  AVAILABILITY_ORDER,
  FORMAT_LABELS,
  formatOfferPrice,
  formatReleaseDate,
  oneSourcePerPlatform,
  payoutEstimate,
  payoutRank,
  relativeDays,
  releaseTypeLabel,
} from "../shared/release-display.ts";

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const CSS = `${SITE_CHROME_CSS}
  :root { --bg: #121212; --bg2: #1a1a1a; --text: #f0f0f0; --muted: #999; --border: #2a2a2a; --accent: #ff6b35; }
  @media (prefers-color-scheme: light) {
    :root { --bg: #fafafa; --bg2: #f5f5f5; --text: #1a1a1a; --muted: #555; --border: #e0e0e0; --accent: #e55a2b; }
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Stack Sans Headline', system-ui, sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; display: flex; flex-direction: column; }
  h1, h2 { font-family: 'Darker Grotesque', 'Stack Sans Headline', system-ui, sans-serif; }
  a { color: inherit; }
  /* 896px (Tailwind's max-w-4xl) to match the width ArtistPage.tsx and Footer.tsx use — this
     page has no SPA counterpart to fall through to (see the note at the top of this file), so
     it is what every real visitor sees and needs to look like the rest of the app, not a
     narrower one-off. The header and footer are the app's, from api/shared/site-chrome.ts. */
  .container { max-width: 896px; margin: 0 auto; padding: 0 24px; width: 100%; }
  .page-content { position: relative; flex: 1; display: flex; flex-direction: column; }
  @keyframes bc-pulse { 0%, 100% { opacity: 0.7; } 50% { opacity: 1; } }

  .release-head { display: flex; gap: 20px; align-items: flex-start; }
  .release-art { width: 160px; height: 160px; flex-shrink: 0; border-radius: 12px; border: 1px solid var(--border); background: var(--bg2); object-fit: cover; }
  .release-art-fallback { width: 160px; height: 160px; flex-shrink: 0; border-radius: 12px; border: 1px solid var(--border); background: var(--bg2); display: flex; align-items: center; justify-content: center; font-size: 40px; }

  /* Two columns on desktop — full-width cards were hard to scan when there were more than two
     or three platforms. align-items: start keeps each card its natural height instead of
     grid's default stretch, which would otherwise pad a short card (e.g. one offer) with empty
     space to match a taller neighbor. */
  .sources-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; align-items: start; margin-bottom: 12px; }
  @media (max-width: 700px) {
    .sources-grid { grid-template-columns: 1fr; }
  }
  .source { border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }
  .source-head { display: flex; align-items: center; gap: 10px; padding: 12px 16px; background: var(--bg2); }
  .offer { display: flex; align-items: baseline; gap: 12px; padding: 10px 16px; border-top: 1px solid var(--border); font-size: 14px; }
  .offer-format { flex: 0 0 88px; font-weight: 500; text-transform: capitalize; }
  /* Sized to content with a floor, not fixed: "$25" and "Name your price" both live in this
     column, and a width that suits one wraps the other onto two lines. Rows within a card still
     line up, because one artist's prices are all the same shape. */
  .offer-price { flex: 0 0 auto; min-width: 88px; }
  .offer-payout { flex: 1; color: var(--muted); font-size: 13px; }
  .offer.gone { color: var(--muted); }
  .buy { display: block; padding: 12px 16px; border-top: 1px solid var(--border); text-align: center; font-weight: 600; text-decoration: none; color: var(--accent); }
  .buy:hover { text-decoration: underline; }
  .note { font-size: 13px; color: var(--muted); margin-top: 16px; }

  /* Last, so these win over the base rules above — no media query beats a later rule of the
     same specificity, and this block sat earlier in the file at first, which quietly did
     nothing at all. */
  @media (max-width: 520px) {
    /* Stacked, but the art is capped rather than full-bleed: a square at 100% width fills the
       entire first screen on a phone and pushes the title, the date and every price below the
       fold — which is the whole reason someone opened the page. */
    .release-head { flex-direction: column; }
    .release-art, .release-art-fallback { width: 200px; height: 200px; }
    /* Narrower fixed columns so the payout estimate — the line this page exists for — stays on
       one line instead of wrapping under the price. */
    .offer-format { flex-basis: 64px; }
    .offer-price { min-width: 72px; }
  }
`;

interface OfferRow {
  format: string;
  price: number | null;
  currency: string | null;
  availability: string;
}

interface SourceRow {
  platform: string;
  url: string;
  source: string | null;
  detail_checked_at: string | null;
  release_offers: OfferRow[] | null;
}

// Every way out of this function that isn't the rendered page goes through here.
//
// This function opts into CDN caching (`cache = "manual"` in netlify.toml), so the CDN caches
// whatever it returns according to that response's headers — including whatever context.next()
// hands back, which is the SPA shell or the next edge function's response. A fall-through is what
// a database timeout looks like, and caching it would pin a blank page to a release URL: never
// cache uncertainty.
//
// Copied into a new Response rather than set in place, because a redirect from further down the
// chain can carry immutable headers.
async function passThrough(context: Context): Promise<Response> {
  const response = await context.next();
  const headers = new Headers(response.headers);
  headers.set('CDN-Cache-Control', 'no-store');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

// The answer when the database didn't answer — a timeout, a query error, missing configuration.
//
// Not a pass-through: the next renderer is the SPA, whose catch-all is NotFoundPage, so an outage
// read "this page doesn't exist" — permanent-sounding, and wrong. Not a second renderer either:
// this is a static document from the same function, so the one-route-one-renderer rule holds.
// A 503 with Retry-After tells crawlers to come back rather than drop the URL, and no-store keeps
// the CDN (this function opts into caching) from pinning the outage to the URL.
function temporarilyUnavailable(artistSlug?: string): Response {
  const artistLink = artistSlug
    ? `<a href="/a/${escapeHtml(encodeURIComponent(artistSlug))}">Go to the artist's page</a>`
    : `<a href="/">Go to Unstream</a>`;
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="noindex">
  <title>Temporarily unavailable | Unstream</title>
  <style>${CSS}
  .unavailable { max-width: 560px; margin: 0 auto; padding: 64px 24px; text-align: center; }
  .unavailable h1 { font-size: 32px; font-weight: 700; margin-bottom: 12px; }
  .unavailable p { color: var(--muted); font-size: 16px; line-height: 1.5; margin-bottom: 24px; }
  .unavailable nav { display: flex; gap: 24px; justify-content: center; flex-wrap: wrap; font-size: 16px; }
  </style>
</head>
<body>
  ${siteHeaderHtml()}
  <main class="unavailable">
    <h1>This page is temporarily unavailable</h1>
    <p>We couldn't load this release just now. It's still here; this is usually brief.</p>
    <nav><a href="">Try again</a>${artistLink}</nav>
  </main>
  ${siteFooterHtml()}
</body>
</html>`;
  return new Response(html, {
    status: 503,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'CDN-Cache-Control': 'no-store',
      'Retry-After': '60',
    },
  });
}

export default async function handler(request: Request, context: Context) {
  try {
    const url = new URL(request.url);
    const segments = url.pathname.replace(/\/$/, '').split('/').filter(Boolean);
    // ['a', artistSlug, releaseSlug] — the route regex guarantees the shape, but this function
    // is the thing that has to be right if that regex is ever loosened.
    if (segments.length !== 3 || segments[0] !== 'a') return passThrough(context);

    const artistSlug = decodeURIComponent(segments[1]);
    const releaseSlug = decodeURIComponent(segments[2]);

    const supabaseUrl = edgeEnv("SUPABASE_URL");
    const supabaseKey = edgeEnv("SUPABASE_SERVICE_KEY");
    if (!supabaseUrl || !supabaseKey) return temporarilyUnavailable(artistSlug);

    const supabase = createClient(supabaseUrl, supabaseKey);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    let artist: { id: string; name: string; image_url: string | null };
    let release: {
      title: string;
      release_type: string;
      release_date: string | null;
      date_precision: string | null;
      status: string;
      artwork_url: string | null;
      release_sources: SourceRow[] | null;
    };

    try {
      // A query error comes back as `error`, not a throw. Unchecked, it read as "no such
      // artist" (and below, "no such release"), so an outage became a not-found.
      const { data: artistData, error: artistError } = await supabase
        .from('artists')
        .select('id, name, image_url')
        .eq('slug', artistSlug)
        .abortSignal(controller.signal)
        .maybeSingle();
      if (artistError) throw artistError;

      // A retired slug still resolves. Most of the aliases in production (44 of them as of
      // 2026-08-07) came from the accent-folding reslug in #410 (`beyonc` -> `beyonce`), and a
      // release URL minted before that — in an alert, a shared link, a Mac app cache — is a URL
      // a fan can still be holding.
      // Falling through instead would hand it to artist-page-static, which hands non-crawlers to
      // the SPA, which has no route for a two-segment /a/ path: a blank page.
      //
      // Checked only *after* the live slug misses, so a real artist who later takes that slug
      // always wins.
      //
      // A 301 to the canonical URL rather than rendering here, matching artist-page-static:
      // rendering the same page at two URLs is duplicate content. The redirect is about the
      // artist slug alone — if the release doesn't exist under the canonical slug either, that
      // request answers with the usual bounce to the artist page.
      //
      // Duplicates resolveArtistSlugAlias in api/functions/db.ts — edge functions run on Deno and
      // cannot import from api/functions.
      if (!artistData) {
        const { data: alias, error: aliasError } = await supabase
          .from('artist_slug_aliases')
          .select('artists!inner(slug)')
          .eq('alias', artistSlug.toLowerCase())
          .abortSignal(controller.signal)
          .maybeSingle();
        if (aliasError) throw aliasError;

        const canonical = (alias as { artists?: { slug?: string } } | null)?.artists?.slug;
        clearTimeout(timeoutId);
        if (!canonical) return passThrough(context);

        // max-age=3600, not the year a permanent redirect invites: browsers cache a 301
        // aggressively, and a slug that gets reassigned to a real artist has to be able to stop
        // redirecting. Same cap artist-page-static uses.
        return new Response(null, {
          status: 301,
          headers: {
            Location: `/a/${encodeURIComponent(canonical)}/${encodeURIComponent(releaseSlug)}`,
            'Cache-Control': 'public, max-age=3600',
          },
        });
      }
      artist = artistData;

      // One round trip for the release, its sources and their offers. `is_hidden` is filtered
      // in the query rather than after: a suppressed release must be indistinguishable from one
      // that was never catalogued, which is the point of having the column.
      const { data: releaseData, error: releaseError } = await supabase
        .from('releases')
        .select(`
          title, release_type, release_date, date_precision, status, artwork_url,
          release_sources ( platform, url, source, detail_checked_at,
            release_offers ( format, price, currency, availability )
          )
        `)
        .eq('artist_id', artist.id)
        .eq('slug', releaseSlug)
        .eq('is_hidden', false)
        .abortSignal(controller.signal)
        .maybeSingle();
      if (releaseError) throw releaseError;

      if (!releaseData) {
        clearTimeout(timeoutId);
        // The artist exists but this release doesn't — a stale link from an old alert, a
        // mistyped slug, or a release an artist has since suppressed. Falling through would
        // hand it to the SPA, which has no route for a two-segment /a/ path and renders a
        // blank page. Send them somewhere useful instead. 302 rather than 301 because a
        // suppressed release can come back, and this deliberately doesn't distinguish
        // "hidden" from "never existed".
        return Response.redirect(`${url.origin}/a/${encodeURIComponent(artistSlug)}`, 302);
      }
      release = releaseData;
    } catch {
      // Timeout or query error: the release may well exist, so say "temporarily unavailable",
      // never the SPA's not-found page.
      clearTimeout(timeoutId);
      return temporarilyUnavailable(artistSlug);
    }

    clearTimeout(timeoutId);

    const artistName = escapeHtml(artist.name);
    const title = escapeHtml(release.title);
    const pageUrl = `https://unstream.stream/a/${encodeURIComponent(artistSlug)}/${encodeURIComponent(releaseSlug)}`;
    const artworkUrl = release.artwork_url || '';
    const bcFriday = isBandcampFriday();

    const dateText = formatReleaseDate(release.release_date, release.date_precision);
    // Upper-cased here, not in the helper: this page shouts the label where the lists sentence-case
    // it. Platforms come from the release's own sources, so a download-only release reads DIGITAL
    // rather than showing nothing where its kind is unknown.
    const typeLabel = releaseTypeLabel(
      release.release_type,
      (release.release_sources || []).map(s => s.platform)
    ).toUpperCase();
    const statusText = release.status === 'announced'
      ? (dateText ? `Coming ${dateText}` : 'Announced')
      : dateText;

    const sources = oneSourcePerPlatform(release.release_sources || []).sort(
      (a, b) => payoutRank(b.platform) - payoutRank(a.platform)
    );

    // The oldest check on the page is the honest freshness claim: saying "checked today"
    // because *one* source was re-read would overstate the rest. `detail_checked_at`, not the
    // offers' `captured_at`: the detail pass skips rewriting offers whose prices haven't moved,
    // so `captured_at` only advances when a price changes and would read as stale data we had
    // in fact just re-verified. `detail_checked_at` is stamped on every pass.
    const capturedTimes = sources
      .map(s => s.detail_checked_at)
      .filter(Boolean)
      .sort();
    const oldestCapture = capturedTimes[0] ?? null;

    const sourcesHtml = sources.map(source => {
      const info = PLATFORMS[source.platform];
      const name = info?.name || source.platform;
      const isBCFriday = source.platform === 'bandcamp' && bcFriday;
      // On a Bandcamp Friday Bandcamp waives its revenue share, so the usual range is simply
      // wrong for the next 24 hours. The rest of the product already models this; a page about
      // where to buy would be a strange place to ignore it.
      const payoutPercent = isBCFriday ? '~97%' : info?.payoutPercent;

      const offers = [...(source.release_offers || [])].sort((a, b) => {
        const availability = (AVAILABILITY_ORDER[a.availability] ?? 2) - (AVAILABILITY_ORDER[b.availability] ?? 2);
        if (availability !== 0) return availability;
        return (a.price ?? Infinity) - (b.price ?? Infinity);
      });

      const offersHtml = offers.map(offer => {
        const gone = offer.availability === 'sold_out';
        // Three columns, always the same three: what it is, what it costs, and what that
        // means for the artist. The availability label rides in the third column rather than
        // beside the price — a sold-out row has no payout to show, and "$14 · Sold out"
        // crammed into the price column wraps onto two lines on every phone.
        const priceText = formatOfferPrice(offer.price, offer.currency);
        const payout = gone ? '' : payoutEstimate(offer.price, offer.currency, payoutPercent);
        const note = [AVAILABILITY_LABELS[offer.availability] || '', payout]
          .filter(Boolean)
          .join(' · ');
        return `<div class="offer${gone ? ' gone' : ''}">
          <span class="offer-format">${escapeHtml(FORMAT_LABELS[offer.format] || offer.format)}</span>
          <span class="offer-price">${escapeHtml(priceText)}</span>
          <span class="offer-payout">${escapeHtml(note)}</span>
        </div>`;
      }).join('');

      // An honest empty state. Both branches say the same thing to a fan — we have no price to
      // show you — and neither says "this is free" or "there is nothing to buy". The wording no
      // longer promises that a price is on its way: a Faircamp release whose purchase page we
      // can't read has no price coming, and "still gathering" would be a promise we don't keep.
      const pendingHtml = offers.length === 0
        ? `<div class="offer"><span style="color:var(--muted)">${
            source.detail_checked_at
              ? 'No formats listed on this page.'
              : 'Price information not available.'
          }</span></div>`
        : '';

      return `<div class="source">
        <div class="source-head">
          <span style="font-size:18px">${platformLogoSvg(source.platform, 18) ?? info?.icon ?? '🔗'}</span>
          <span style="flex:1;font-weight:600">${escapeHtml(name)}</span>
          ${payoutPercent ? `<span style="font-size:12px;color:var(--muted)">${escapeHtml(payoutPercent)} to artist</span>` : ''}
          ${isBCFriday ? '<span style="font-size:12px;font-weight:700;color:#1da0c3;animation:bc-pulse 2s ease-in-out infinite">Bandcamp Friday!</span>' : ''}
        </div>
        ${offersHtml}${pendingHtml}
        <a class="buy" href="${escapeHtml(source.url)}" target="_blank" rel="noopener noreferrer">Buy on ${escapeHtml(name)} &rarr;</a>
      </div>`;
    }).join('');

    const description = `Where to buy ${release.title} by ${artist.name} — formats, prices, and how much reaches the artist.`;

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} by ${artistName} - Unstream | Where to buy</title>
  <meta name="description" content="${escapeHtml(description)}">
  <!-- noindex by design, not by oversight. Release pages are generated from a crawl, so a
       wrong one would mint a durable URL asserting an artist made a record they didn't, and a
       catalog of thin auto-generated pages is textbook scaled-content abuse — the penalty for
       which is site-wide, putting the artist-page and guide rankings already earned at risk.
       These pages exist as a destination for a release alert, not as a landing page for a
       stranger. Indexation is a later, deliberate decision for pages that clear a quality bar.
       "follow" so the links out to artists and platforms still count.

       There is deliberately no MusicRelease JSON-LD here for the same reason: structured data
       does nothing on a noindex page except make a machine-readable claim we aren't yet
       confident enough to publish. -->
  <meta name="robots" content="noindex, follow">
  <meta property="og:title" content="${title} by ${artistName}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:url" content="${pageUrl}">
  <meta property="og:type" content="music.album">
  <meta property="og:site_name" content="Unstream">
  ${artworkUrl ? `<meta property="og:image" content="${escapeHtml(artworkUrl)}">
  <meta property="og:image:alt" content="${title}">` : ''}
  <meta name="twitter:card" content="${artworkUrl ? 'summary_large_image' : 'summary'}">
  <link rel="canonical" href="${pageUrl}">
  <link href="https://api.fonts.coollabs.io/css2?family=Darker+Grotesque:wght@300..900&family=Stack+Sans+Headline:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>${CSS}</style>
</head>
<body>
  ${siteHeaderHtml()}

  <div class="page-content">
    <div class="container" style="padding-top:32px;padding-bottom:32px">
      <a href="/a/${escapeHtml(encodeURIComponent(artistSlug))}" style="font-size:16px;color:var(--muted);text-decoration:none">&larr; ${artistName}</a>

      <div class="release-head" style="margin-top:20px">
        <!-- Artwork is hotlinked from the platform's CDN, so a dead or blocked image is a
             normal outcome, not an edge case — and an empty bordered box on a buying page
             reads as broken. Same onerror swap artist-page-static uses. -->
        ${artworkUrl
          ? `<img class="release-art" src="${escapeHtml(artworkUrl)}" alt="${title}" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
             <div class="release-art-fallback" style="display:none">💿</div>`
          : `<div class="release-art-fallback">💿</div>`}
        <div>
          ${typeLabel ? `<div style="font-size:12px;letter-spacing:0.08em;color:var(--muted)">${escapeHtml(typeLabel)}</div>` : ''}
          <h1 style="font-size:32px;font-weight:700;line-height:1.1;margin-top:4px">${title}</h1>
          <div style="margin-top:6px;font-size:16px;color:var(--muted)">${artistName}</div>
          ${statusText ? `<div style="margin-top:10px;font-size:16px;color:var(--muted)">${escapeHtml(statusText)}</div>` : ''}
        </div>
      </div>
    </div>

    <div class="container" style="padding-bottom:32px">
      <h2 style="font-size:12px;text-transform:uppercase;letter-spacing:0.05em;color:var(--muted);margin-bottom:12px">Where to buy</h2>
      ${sourcesHtml ? `<div class="sources-grid">${sourcesHtml}</div>` : '<p style="font-size:16px;color:var(--muted)">We haven\'t found anywhere to buy this yet.</p>'}
      ${oldestCapture ? `<p class="note">Prices last checked ${escapeHtml(relativeDays(oldestCapture))}. Stock and prices may change. Payout figures are estimates based on each platform's published rates.</p>` : ''}
    </div>
  </div>

  ${siteFooterHtml()}
</body>
</html>`;

    return new Response(html, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'public, max-age=0, must-revalidate',
        // Unlike the artist page, this route is pure SSR for *everyone* — there is no SPA
        // fallback — so every human view and every crawler hit that misses the CDN costs two
        // Supabase queries, one of them a two-level nested embed. There are ~6,000 of these URLs
        // against ~800 artist pages, which is what makes the TTL here worth more than anywhere
        // else on the site.
        //
        // An hour rather than a day because the content is user-visible, paired with a long
        // stale-while-revalidate so a stale entry is still served instantly while one background
        // request refreshes it: steady-state cost is one query per URL per hour regardless of
        // traffic. Artist edits don't wait for it — they purge (see purgeArtistCaches in
        // api/functions/artist-releases.ts).
        //
        // This header does nothing on its own, and that is worth saying plainly because it fails
        // silently. Netlify caches an edge function's response only when the function opts in
        // (`cache = "manual"` on its netlify.toml entry). Until that line existed (2026-10-18)
        // every hit queried Supabase while looking perfectly healthy.
        //
        // `CDN-Cache-Control` rather than `Netlify-CDN-Cache-Control`: Netlify honours the
        // standard name, and so do other CDNs. The separate `Cache-Control` above is what the
        // *browser* is told, and it stays short because prices are user-visible.
        'CDN-Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=86400',
        // Two tags: the specific page, plus one shared by every release page of this artist.
        // Purging is by exact tag with no wildcards on both platforms, and an artist editing
        // their catalogue needs all of their release pages gone at once — this is the only way
        // to say that in one purge call.
        'Cache-Tag': `release-${artistSlug}-${releaseSlug},artist-releases-${artistSlug}`,
      },
    });
  } catch {
    return passThrough(context);
  }
}