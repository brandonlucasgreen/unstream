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
// (see docs/retros/UNS-100-bifurcation-retro.md). Nothing on this page hydrates or re-renders
// client-side — the only script anywhere in it is an inline image-error fallback.
//
// **Route precedence.** netlify.toml declares this *before* `/a/*`, because `/a/*` also matches
// `/a/artist/release` and artist-page-static would otherwise answer first. The regex here
// matches exactly two path segments so single-segment artist URLs never reach it.

import { Context } from "https://edge.netlify.com";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { PLATFORMS } from "../shared/platform-registry.ts";
import { isBandcampFriday } from "../shared/bandcamp-friday.ts";
import {
  AVAILABILITY_LABELS,
  AVAILABILITY_ORDER,
  FORMAT_LABELS,
  formatOfferPrice,
  formatReleaseDate,
  payoutEstimate,
  payoutRank,
  relativeDays,
  releaseTypeLabel,
} from "../shared/release-display.ts";

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const LOGO_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 110 110" aria-hidden="true"><defs><filter id="gs"><feColorMatrix type="saturate" values="0"/></filter></defs><g transform="translate(22,22) scale(1.8333)" filter="url(#gs)"><path fill="#50A5E6" d="M30 22c-3 0-6.688 7.094-7 10-.421 3.915 2 4 2 4h11V26s-3.438-4-6-4z"/><ellipse transform="rotate(-60 27.574 28.49)" fill="#1C6399" cx="27.574" cy="28.489" rx="5.848" ry="1.638"/><path fill="#F9CA55" d="M20.086 0c1.181 0 2.138.957 2.138 2.138 0 .789.668 10.824.668 10.824L17.948 18V2.138C17.948.957 18.905 0 20.086 0z"/><path fill="#FFDC5D" d="M18.875 4.323c0-1.099.852-1.989 1.903-1.989 1.051 0 1.903.891 1.903 1.989 0 0 .535 5.942 1.192 9.37.878 1.866 1.369 4.682 1.261 6.248.054.398 5.625 5.006 5.625 5.006-.281 1.813-2.259 6.155-4.759 8.159l-3.521-2.924c-2.885-.404-4.458-3.331-4.458-4.264 0-2.984.854-21.595.854-21.595z"/><path fill="#50A5E6" d="M6 22c3 0 6.688 7.094 7 10 .421 3.915-2 4-2 4H0V26s3.438-4 6-4z"/><ellipse transform="rotate(-30 8.424 28.489)" fill="#1C6399" cx="8.426" cy="28.489" rx="1.638" ry="5.848"/><path fill="#F9CA55" d="M16.061.011c-1.266-.127-2.333.864-2.333 2.103 0 .78-.184 10.319-.184 10.319L17.895 18l.062-15.765c0-1.106-.795-2.114-1.896-2.224z"/><path fill="#FFDC5D" d="M17.125 4.323c0-1.099-.852-1.989-1.903-1.989-1.051 0-1.903.891-1.903 1.989 0 0-.535 5.942-1.192 9.37-.878 1.866-1.369 4.682-1.261 6.248-.054.398-5.625 5.006-5.625 5.006C5.522 26.76 7.5 31.102 10 33.106l3.521-2.924c2.885-.404 4.458-3.331 4.458-4.264 0-2.984-.854-21.595-.854-21.595z"/><path fill="#F9CA55" d="M17.958 25.823c-.414 0-.75-.336-.75-.75V2.792c0-.414.336-.75.75-.75s.75.336.75.75v22.282c.001.413-.335.749-.75.749z"/></g><path d="M14,52 A41,41 0 0,1 96,52" fill="none" stroke="currentColor" stroke-width="8" stroke-linecap="round"/><line x1="14" y1="52" x2="14" y2="64" stroke="currentColor" stroke-width="7" stroke-linecap="round"/><line x1="96" y1="52" x2="96" y2="64" stroke="currentColor" stroke-width="7" stroke-linecap="round"/><rect x="3" y="60" width="22" height="28" rx="9" fill="currentColor"/><rect x="85" y="60" width="22" height="28" rx="9" fill="currentColor"/></svg>';

const CSS = `
  :root { --bg: #121212; --bg2: #1a1a1a; --text: #f0f0f0; --muted: #999; --border: #2a2a2a; --accent: #ff6b35; --footer-border: #1a1a1a; }
  @media (prefers-color-scheme: light) {
    :root { --bg: #fafafa; --bg2: #f5f5f5; --text: #1a1a1a; --muted: #555; --border: #e0e0e0; --accent: #e55a2b; --footer-border: #e0e0e0; }
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Stack Sans Headline', system-ui, sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; display: flex; flex-direction: column; }
  h1, h2 { font-family: 'Darker Grotesque', 'Stack Sans Headline', system-ui, sans-serif; }
  a { color: inherit; }
  /* 896px (Tailwind's max-w-4xl) to match the width ArtistPage.tsx and Footer.tsx use — this
     page has no SPA counterpart to fall through to (see the note at the top of this file), so
     its hand-rolled header/footer is what every real visitor sees and needs to look like the
     rest of the app, not a narrower one-off. */
  .container { max-width: 896px; margin: 0 auto; padding: 0 24px; width: 100%; }
  .page-content { position: relative; flex: 1; display: flex; flex-direction: column; }
  @keyframes bc-pulse { 0%, 100% { opacity: 0.7; } 50% { opacity: 1; } }
  .site-header { padding: 16px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; gap: 16px; }
  .site-header .brand { display: flex; align-items: center; gap: 8px; font-size: 20px; font-weight: 700; color: var(--text); text-decoration: none; flex-shrink: 0; }
  .site-header .brand:hover { opacity: 0.8; }
  /* Matches the React HeaderSearch this page can't render: a magnifying glass inside the
     field and no submit button. Enter submits the form, which is what the icon implies and
     what every other page in the app does — a separate "Search" button only appeared here
     because plain SSR made it the obvious way to submit. */
  .site-header .header-search { position: relative; flex: 1; max-width: 420px; margin: 0 auto; }
  .site-header .header-search-icon { position: absolute; left: 12px; top: 50%; transform: translateY(-50%); width: 16px; height: 16px; color: var(--muted); pointer-events: none; }
  .site-header .header-search input { width: 100%; min-width: 0; background: var(--bg2); border: 1px solid var(--border); border-radius: 8px; padding: 8px 12px 8px 36px; font-size: 14px; color: var(--text); font-family: inherit; }
  .site-header .header-search input::placeholder { color: var(--muted); }
  .site-header .header-search input:focus { outline: none; border-color: var(--accent); }
  @media (max-width: 640px) { .site-header .header-search { display: none; } }
  /* Unlike artist-page-static, this page has no SPA counterpart to hand real browsers off to
     (see the note at the top of this file) — every visitor sees this exact header, so it's the
     only place a signed-out fan following a release alert can reach the login page. */
  .site-header .nav-right { display: flex; align-items: center; flex-shrink: 0; }
  /* A filled accent button, matching the React header's Login. It was a muted text link here,
     which read as secondary navigation rather than the primary action for a signed-out fan
     arriving from a release alert. */
  .site-header .nav-button { padding: 8px 16px; border-radius: 8px; background: var(--accent); color: #fff; text-decoration: none; font-size: 14px; font-weight: 600; box-shadow: 0 1px 2px rgba(0,0,0,0.2); }
  .site-header .nav-button:hover { opacity: 0.9; }

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
  captured_at: string;
}

interface SourceRow {
  platform: string;
  url: string;
  detail_checked_at: string | null;
  release_offers: OfferRow[] | null;
}

export default async function handler(request: Request, context: Context) {
  try {
    const url = new URL(request.url);
    const segments = url.pathname.replace(/\/$/, '').split('/').filter(Boolean);
    // ['a', artistSlug, releaseSlug] — the route regex guarantees the shape, but this function
    // is the thing that has to be right if that regex is ever loosened.
    if (segments.length !== 3 || segments[0] !== 'a') return context.next();

    const artistSlug = decodeURIComponent(segments[1]);
    const releaseSlug = decodeURIComponent(segments[2]);

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_KEY");
    if (!supabaseUrl || !supabaseKey) return context.next();

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
      const { data: artistData } = await supabase
        .from('artists')
        .select('id, name, image_url')
        .eq('slug', artistSlug)
        .maybeSingle()
        .abortSignal(controller.signal);

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
        const { data: alias } = await supabase
          .from('artist_slug_aliases')
          .select('artists!inner(slug)')
          .eq('alias', artistSlug.toLowerCase())
          .maybeSingle()
          .abortSignal(controller.signal);

        const canonical = (alias as { artists?: { slug?: string } } | null)?.artists?.slug;
        clearTimeout(timeoutId);
        if (!canonical) return context.next();

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
      const { data: releaseData } = await supabase
        .from('releases')
        .select(`
          title, release_type, release_date, date_precision, status, artwork_url,
          release_sources ( platform, url, detail_checked_at,
            release_offers ( format, price, currency, availability, captured_at )
          )
        `)
        .eq('artist_id', artist.id)
        .eq('slug', releaseSlug)
        .eq('is_hidden', false)
        .maybeSingle()
        .abortSignal(controller.signal);

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
      // Timeout or error — fall through to the SPA rather than showing a broken page.
      clearTimeout(timeoutId);
      return context.next();
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

    const sources = [...(release.release_sources || [])].sort(
      (a, b) => payoutRank(b.platform) - payoutRank(a.platform)
    );

    // The oldest price on the page is the honest freshness claim: saying "checked today"
    // because *one* source was re-read would overstate the rest.
    const capturedTimes = sources
      .flatMap(s => (s.release_offers || []).map(o => o.captured_at))
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
          <span style="font-size:18px">${info?.icon || '🔗'}</span>
          <span style="flex:1;font-weight:600">${escapeHtml(name)}</span>
          ${payoutPercent ? `<span style="font-size:12px;color:var(--muted)">${escapeHtml(payoutPercent)} to artist</span>` : ''}
          ${isBCFriday ? '<span style="font-size:11px;font-weight:700;color:#1da0c3;animation:bc-pulse 2s ease-in-out infinite">Bandcamp Friday!</span>' : ''}
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
  <link href="https://fonts.googleapis.com/css2?family=Darker+Grotesque:wght@300..900&family=Stack+Sans+Headline:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>${CSS}</style>
</head>
<body>
  <header class="site-header">
    <a href="/" class="brand">${LOGO_SVG} Unstream</a>
    <!-- Plain GET form, no JS: this page is pure SSR, so it can't render the React
         HeaderSearch. Submitting lands on /?q=… where the SPA renders results. Never point
         this at /search — that URL belongs to the noscript-search edge function. -->
    <form class="header-search" action="/" method="get" role="search">
      <svg class="header-search-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/></svg>
      <input type="text" name="q" placeholder="Search artists..." aria-label="Search artists" enterkeyhint="search">
    </form>
    <div class="nav-right">
      <a href="/login" class="nav-button">Login</a>
    </div>
  </header>

  <div class="page-content">
    <div class="container" style="padding-top:32px;padding-bottom:32px">
      <a href="/a/${escapeHtml(encodeURIComponent(artistSlug))}" style="font-size:14px;color:var(--muted);text-decoration:none">&larr; ${artistName}</a>

      <div class="release-head" style="margin-top:20px">
        <!-- Artwork is hotlinked from the platform's CDN, so a dead or blocked image is a
             normal outcome, not an edge case — and an empty bordered box on a buying page
             reads as broken. Same onerror swap artist-page-static uses. -->
        ${artworkUrl
          ? `<img class="release-art" src="${escapeHtml(artworkUrl)}" alt="${title}" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
             <div class="release-art-fallback" style="display:none">💿</div>`
          : `<div class="release-art-fallback">💿</div>`}
        <div>
          ${typeLabel ? `<div style="font-size:11px;letter-spacing:0.08em;color:var(--muted)">${escapeHtml(typeLabel)}</div>` : ''}
          <h1 style="font-size:32px;font-weight:700;line-height:1.1;margin-top:4px">${title}</h1>
          <div style="margin-top:6px;font-size:15px;color:var(--muted)">${artistName}</div>
          ${statusText ? `<div style="margin-top:10px;font-size:14px;color:var(--muted)">${escapeHtml(statusText)}</div>` : ''}
        </div>
      </div>
    </div>

    <div class="container" style="padding-bottom:32px">
      <h2 style="font-size:11px;text-transform:uppercase;letter-spacing:0.05em;color:var(--muted);margin-bottom:12px">Where to buy</h2>
      ${sourcesHtml ? `<div class="sources-grid">${sourcesHtml}</div>` : '<p style="font-size:14px;color:var(--muted)">We haven\'t found anywhere to buy this yet.</p>'}
      ${oldestCapture ? `<p class="note">Prices last checked ${escapeHtml(relativeDays(oldestCapture))}. Stock and prices may change. Payout figures are estimates based on each platform's published rates.</p>` : ''}
    </div>
  </div>

  <div style="padding:24px 16px;text-align:center">
    <a href="https://unstream.stream" style="color:var(--text);text-decoration:none;font-weight:700;font-size:18px">Powered by Unstream</a>
    <p style="font-size:14px;color:var(--muted);margin-top:4px">Find music on platforms that pay artists fairly.</p>
  </div>

  <footer style="margin-top:auto;padding:24px 16px;border-top:1px solid var(--footer-border)">
    <div style="max-width:896px;margin:0 auto;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;font-size:14px;color:var(--muted)">
      <a href="https://bgreen.lol" target="_blank" rel="noopener noreferrer" style="color:var(--muted);text-decoration:none">Made with love in Massachusetts, USA</a>
      <nav style="display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:12px">
        <a href="/artists" style="color:var(--muted);text-decoration:none">Indie Artist Index</a>
        <span style="color:var(--muted);opacity:0.4;font-size:10px">&#x2022;</span>
        <a href="/guides" style="color:var(--muted);text-decoration:none">Guides</a>
        <span style="color:var(--muted);opacity:0.4;font-size:10px">&#x2022;</span>
        <a href="/changelog" style="color:var(--muted);text-decoration:none">Changelog</a>
        <span style="color:var(--muted);opacity:0.4;font-size:10px">&#x2022;</span>
        <a href="https://github.com/brandonlucasgreen/unstream" target="_blank" rel="noopener noreferrer" style="color:var(--muted);text-decoration:none">Codebase</a>
        <span style="color:var(--muted);opacity:0.4;font-size:10px">&#x2022;</span>
        <a href="/support" style="color:var(--muted);text-decoration:none">Donate</a>
        <span style="color:var(--muted);opacity:0.4;font-size:10px">&#x2022;</span>
        <a href="/faq" style="color:var(--muted);text-decoration:none">FAQ</a>
        <span style="color:var(--muted);opacity:0.4;font-size:10px">&#x2022;</span>
        <a href="https://letterbird.co/hi-d2078591" target="_blank" rel="noopener noreferrer" style="color:var(--muted);text-decoration:none">Contact</a>
        <span style="color:var(--muted);opacity:0.4;font-size:10px">&#x2022;</span>
        <a href="/privacy-policy" style="color:var(--muted);text-decoration:none">Privacy policy</a>
        <span style="color:var(--muted);opacity:0.4;font-size:10px">&#x2022;</span>
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
        'Netlify-CDN-Cache-Control': 'public, s-maxage=300, stale-while-revalidate=300',
        'Cache-Tag': `release-${artistSlug}-${releaseSlug}`,
      },
    });
  } catch {
    return context.next();
  }
}
