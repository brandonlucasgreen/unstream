// The tips feature flags, decided in one place for both runtimes (UNS-215).
//
// Why this exists as well as api/functions/feature-flags.ts: the SEO edge function
// (api/edge/artist-page-static.ts) reads the same flag, and edge functions run on Deno — they
// cannot import from api/functions, which pulls in the Upstash SDK and Sentry. That is the same
// fork that forced the tips *rules* to be duplicated (api/shared/artist-page-tips.ts); this file
// keeps the *decision*, and the hash key it reads, from drifting the same way. The node side
// reads it through feature-flags.ts, which imports both of the exports below.
//
// UNS-215 split the one `tips` flag into two orthogonal ones:
//   tipsArtists — the artist side. On, a claimed artist may start Stripe Connect onboarding and
//                 switch tips on. Off, both refuse; the rest of the dashboard stays open.
//   tipsFans    — the fan side. On, fans see and can act on tips: search result buttons, the
//                 artist page payload, the SEO page block, tip checkout.
// Neither implies the other, and nothing in code ties them together. What actually limits who can
// be paid is the admin approval gate — takingTips() requires tips_approved_at, which only an
// admin sets (/api/admin/tips) — so `tipsArtists` being on does not by itself open the till.
//
// The contract is exactly feature-flags.ts's: a flag is on only when its own field of the
// `feature-flags` hash holds the string "on". Missing hash, missing field, any other value
// ("ON", "true", a boolean, null) — and a read that failed, which the edge caller passes through
// as an Error — all mean OFF.
//
// FAIL CLOSED, deliberately, like the store it mirrors: a flag that reads "on" by accident ships
// a half-built feature to everyone, while one that reads "off" by accident only keeps a finished
// feature invisible until the next read.

/**
 * The one Redis hash every flag lives in.
 *
 * Defined here rather than in feature-flags.ts so the edge copy reads the same key: two
 * hand-kept copies of a Redis key name is exactly the drift that would let the edge render tips
 * while the node side hides them.
 */
export const FLAGS_HASH_KEY = 'feature-flags';

/** The field in that hash the artist-onboarding gate reads. */
export const TIPS_ARTISTS_FLAG_FIELD = 'tipsArtists';

/** The field in that hash every fan-facing tips surface reads. */
export const TIPS_FANS_FLAG_FIELD = 'tipsFans';

/**
 * Whether a raw flag value means "live to everyone" — true only for the exact string "on".
 *
 * `raw` is whatever the read produced and is deliberately `unknown`: "on"/"off" from the hash,
 * null/undefined for a missing hash or field, or the Error from a failed read. Nothing about a
 * failed read can look like "on".
 */
export function flagIsOn(raw: unknown): boolean {
  return raw === 'on';
}
