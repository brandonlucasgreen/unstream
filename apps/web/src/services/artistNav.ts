import * as Sentry from '@sentry/react';
import type { NavGroup, NavItem } from '../components/MobileNav';

// What the header's artist menu shows (GET /api/me/artist-nav): the artists this account has a
// verified claim on, and whether Tips and Promote are open to it. Only the server reads feature
// flags, so the menu asks rather than guessing from `isAdmin`.
//
// **Asked once per browser session.** Every page renders its own <Header>, so asking on mount
// would be a request (and a metered rate-limit command) per navigation for every signed-in person
// — nearly all of them fans, whose answer is "no artists". The answer is kept in memory for the
// SPA's lifetime and in sessionStorage across reloads, keyed by user so a different sign-in in the
// same tab never sees someone else's menu. `forgetArtistNav` drops it when a claim is verified.

export interface ArtistNav {
  artists: Array<{ name: string; slug: string }>;
  tips: boolean;
  promote: boolean;
}

const STORAGE_KEY = 'unstream:artist-nav';

let memo: { userId: string; promise: Promise<ArtistNav | null> } | null = null;

function readStored(userId: string): ArtistNav | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const stored = JSON.parse(raw) as { userId?: string; nav?: ArtistNav };
    return stored.userId === userId && stored.nav && Array.isArray(stored.nav.artists) ? stored.nav : null;
  } catch {
    return null;
  }
}

function writeStored(userId: string, nav: ArtistNav) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ userId, nav }));
  } catch {
    // Storage blocked: the in-memory answer still covers this page's lifetime.
  }
}

/** The menu for this user, or null if it couldn't be loaded (no menu rather than a wrong one). */
export function getArtistNav(userId: string, accessToken: string): Promise<ArtistNav | null> {
  if (memo?.userId === userId) return memo.promise;

  const stored = readStored(userId);
  const promise = stored
    ? Promise.resolve(stored)
    : fetch('/api/me/artist-nav', { headers: { Authorization: `Bearer ${accessToken}` } })
        .then(res => {
          if (!res.ok) throw new Error(`artist-nav failed: ${res.status}`);
          return res.json() as Promise<ArtistNav>;
        })
        .then(nav => {
          writeStored(userId, nav);
          return nav;
        })
        .catch(err => {
          // Forget the failure so the next page asks again, rather than hiding the menu for the
          // rest of the session.
          memo = null;
          if (!(err instanceof Error && /: 401$/.test(err.message))) {
            Sentry.captureException(err, { extra: { context: 'artistNav.load' } });
          }
          return null;
        });
  memo = { userId, promise };
  return promise;
}

/** Drop the remembered answer, e.g. once a claim is verified, so the next page asks afresh. */
export function forgetArtistNav() {
  memo = null;
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing stored, or storage blocked.
  }
}

/** The words the menu uses, from the locale file (nav.artist.*). */
export interface ArtistMenuLabels {
  yourArtists: string;
  analytics: string;
  viewPage: string;
  editProfile: string;
  releases: string;
  tips: string;
  promote: string;
}

/**
 * The header's artist menu, or null for an account with no verified artist.
 *
 * One artist: a menu named after them, with their six pages (Brandon, 2026-11-08). Several: one
 * "Your artists" menu with the same pages under each artist's name, so the header gains one item
 * however many artists there are. As of November 2026 no account has more than two; a label with
 * dozens would need a different shape (a list of names, each to its own hub), and this one should
 * be revisited before that.
 */
export function buildArtistMenu(nav: ArtistNav | null, labels: ArtistMenuLabels): NavGroup | null {
  if (!nav || !Array.isArray(nav.artists) || nav.artists.length === 0) return null;
  const several = nav.artists.length > 1;

  const items: NavItem[] = nav.artists.flatMap(({ name, slug }) => {
    const s = encodeURIComponent(slug);
    const section = several ? name : undefined;
    return [
      { to: `/analytics/${s}`, label: labels.analytics, section },
      { to: `/a/${s}`, label: labels.viewPage, section },
      { to: `/artist-edit/${s}`, label: labels.editProfile, section },
      { to: `/releases/${s}`, label: labels.releases, section },
      ...(nav.tips ? [{ to: `/tips/${s}`, label: labels.tips, section }] : []),
      ...(nav.promote ? [{ to: `/promote/${s}`, label: labels.promote, section }] : []),
    ];
  });

  return { label: several ? labels.yourArtists : nav.artists[0].name, items };
}
