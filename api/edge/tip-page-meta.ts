// Edge function: /tip/{slug} — the artist-specific share card (UNS-225).
//
// Without this, an unfurl of unstream.stream/tip/kid-lightbulbs shows the homepage's generic
// card (the SPA catch-all serves apps/web/index.html, and the meta tags TipPage sets client-side
// are invisible to anything that doesn't run JS). The /a/ pages solved this with
// artist-page-static.ts; this page needs the same answer with none of its weight — no link
// sections, no releases, no JSON-LD — so instead of rendering the full page it serves a small
// OG-only document: "Leave {artist} a tip on Unstream" plus the artist photo, built by the shared
// api/shared/tip-page-meta.ts.
//
// Same contract as static-page-meta.ts, which models after og-metadata.ts: social crawlers get
// the card, indexing crawlers and real browsers fall through to the SPA so the page they see is
// the page everyone else sees. The SPA's client-side document.title ("Tip {artist}") keeps
// matching what the card says.

import { edgeEnv } from "./edge-context.ts";
import type { Context } from "./edge-context.ts";
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { isSocialCrawler, isIndexingCrawler } from "../shared/crawler-detection.ts";
import { buildTipPageMetaHtml, isTipSlug, TIP_RESERVED_SLUGS } from "../shared/tip-page-meta.ts";

// The edge can't import api/functions, and /a/ does its own Supabase reads (artist-page-static
// is the precedent this follows — 5-second timeout with the signal on every query, fall through
// to the SPA on any failure so a database hiccup costs a generic card rather than an error page
// where a payment flow starts).
const DATA_TIMEOUT_MS = 5000;

// A day, like artist-page-static.ts: the render only ever reaches crawlers, each miss costs a
// Supabase read, and every purge site that already clears that page (`artist-${slug}` tag below)
// clears this one in the same call.
const CDN_CACHE_CONTROL = 'public, s-maxage=86400, stale-while-revalidate=86400';

/** The photo the /a/ page shows for this artist: profile custom image when claimed+verified, else the catalog image. */
interface NameAndImage {
  name: string;
  imageUrl: string;
}

// Same precedence artist-page-static.ts renders (`(claimed && custom_image_url) || image_url`) and
// tipEligibility overrides into the payload (`if (p.custom_image_url) artist.imageUrl = ...`), so
// the tip card and the artist card never disagree about whose face they show.
//
// Identity, not tips state: this read mirrors the catalog read (match_confidence + verified_at for
// the photo rule) and deliberately stops there. The /tip page itself answers the not-taking states
// with the same real name and photo (tips-checkout readTipPage), and eligibility re-checks live
// inside checkout on every payment, so a card is never the thing to gate an account behind.
export async function readTipPageNameAndImage(
  supabase: SupabaseClient,
  slug: string,
  signal: AbortSignal,
): Promise<NameAndImage | null> {
  const { data, error, status } = await supabase
    .from('artists')
    .select('name, image_url, match_confidence, artist_profiles ( custom_image_url, verified_at )')
    .eq('slug', slug)
    .abortSignal(signal)
    .single();

  if (error || !data) {
    // 42P01-style misses (PGRST on an unknown column or a schema hiccup) and code>400 read as "no
    // artist": the crawler gets the SPA's generic card instead of a broken unfurl.
    if (error && status !== 406 && status !== 404) console.error(`[tip-page-meta] artist read failed (HTTP ${status}):`, error.message);
    return null;
  }

  const profile = (data as { artist_profiles?: Array<{ custom_image_url: string | null; verified_at: string | null }> | { custom_image_url: string | null; verified_at: string | null } | null }).artist_profiles;
  const p = Array.isArray(profile) ? profile[0] : profile;
  const isClaimed = (data as { match_confidence: string }).match_confidence === 'claimed' && !!p?.verified_at;
  const imageUrl = (isClaimed && p.custom_image_url) || (data as { image_url: string | null }).image_url || '';
  return { name: (data as { name: string }).name, imageUrl };
}

export default async function handler(request: Request, context: Context) {
  try {
    const url = new URL(request.url);
    // Trailing slashes reach here as a distinct path; treat /tip/foo/ and /tip/foo the same.
    const slug = url.pathname.replace(/^\/tip\//, '').replace(/\/+$/, '');

    if (!slug || !isTipSlug(slug) || TIP_RESERVED_SLUGS.has(slug)) return context.next();

    const userAgent = request.headers.get('user-agent');
    if (isIndexingCrawler(userAgent)) return context.next();
    if (!isSocialCrawler(userAgent)) return context.next();

    const supabaseUrl = edgeEnv("SUPABASE_URL");
    const supabaseKey = edgeEnv("SUPABASE_SERVICE_KEY");
    if (!supabaseUrl || !supabaseKey) return context.next();

    const supabase = createClient(supabaseUrl, supabaseKey);

    const found = await (async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), DATA_TIMEOUT_MS);
      try {
        return await readTipPageNameAndImage(supabase, slug, controller.signal);
      } catch (err) {
        console.error('[tip-page-meta] artist read failed:', String(err));
        return null;
      } finally {
        clearTimeout(timeoutId);
      }
    })();

    // Unknown slug: the /tip SPA answers "We couldn't find that artist." A card claiming an
    // artist would be the lie here, so fall through — the generic Unstream card is the honest
    // answer for a link whose target doesn't exist.
    if (!found) return context.next();

    const html = buildTipPageMetaHtml({ slug, artistName: found.name, imageUrl: found.imageUrl });
    return new Response(html, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        // Browsers never see this render (only social crawlers), so no browser cache; the CDN
        // carries it for the day instead, same shape as artist-page-static.ts (whose TTL comment
        // applies unchanged — a stale card can only lag a photo swap by a purge, never a payment).
        'Cache-Control': 'public, max-age=0, must-revalidate',
        'CDN-Cache-Control': CDN_CACHE_CONTROL,
        // Same tag artist-page-static.ts serves under: every purge site that already exists for
        // an artist's edge pages (profile save, tips settings, admin approve, photo refresh) now
        // refreshes the tip card too — sharing the tag, not adding a new one, is what keeps this
        // from needing any purge-side code.
        'Cache-Tag': `artist-${slug}`,
      },
    });
  } catch (err) {
    console.error('[tip-page-meta] handler failed:', String(err));
    return context.next();
  }
}
