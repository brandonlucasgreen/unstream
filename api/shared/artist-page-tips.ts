// The tips block on the server-rendered artist page (api/edge/artist-page-static.ts): a plain
// "Tip <artist>" link and the artist's open goals, all linking to /tip/{slug}, which the SPA owns
// (docs/specs/artist-patronage-spec.md §7). No script and no modal — the edge never hands off to
// the SPA's tip window, which is the "one route, one renderer" rule.
//
// Edge functions run on Deno and can't import api/functions/, so the two eligibility rules below
// duplicate `stripeMode` (api/functions/stripe.ts) and `isAccountLive` plus the ownership check
// in `tipEligibility` (api/functions/tips-db.ts). Keep them in step: a disagreement shows crawlers
// a Tip link that checkout then refuses, or hides one it would accept. Checkout re-checks
// everything on every request, so this page can only ever be wrong about what it *shows*.

import { formatUsd } from './tips.ts';

export type StripeMode = 'live' | 'test';

/** Mirror of `stripeMode` in api/functions/stripe.ts: the mode is read from the key's prefix. */
export function stripeModeFromKey(key: string | null | undefined): StripeMode | null {
  if (!key) return null;
  if (key.startsWith('sk_test_') || key.startsWith('rk_test_')) return 'test';
  if (key.startsWith('sk_live_') || key.startsWith('rk_live_')) return 'live';
  return null;
}

/** The artist_tip_accounts columns the page needs, read for the server's Stripe mode only. */
export interface TipAccountSnapshot {
  user_id: string;
  charges_enabled: boolean;
  tips_enabled: boolean;
  tips_approved_at: string | null;
  deauthorized_at: string | null;
}

/**
 * Taking tips right now: Stripe enables charges, an admin approved, the artist switched tips on,
 * the account is still connected (not deauthorized from Stripe's side), and it was connected by
 * the profile's *current* verified owner. The caller has already checked the profile is claimed
 * and verified, and read the account for the server's Stripe mode.
 */
export function isTipAccountTakingTips(account: TipAccountSnapshot | null, ownerUserId: string | null | undefined): boolean {
  return !!account
    && !!ownerUserId
    && account.user_id === ownerUserId
    && account.charges_enabled
    && account.tips_enabled
    && !!account.tips_approved_at
    && !account.deauthorized_at;
}

export interface OpenGoal {
  id: string;
  title: string;
  targetCents: number;
  raisedCents: number;
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function tipHref(slug: string, goalId?: string): string {
  const base = `/tip/${encodeURIComponent(slug)}`;
  return goalId ? `${base}?goal=${encodeURIComponent(goalId)}` : base;
}

/**
 * One goal: title, "$120.00 of $500.00", and a bar. Goals are trackers and can pass their target,
 * so the bar caps at full while the figures keep counting — same as GoalProgress in the SPA.
 */
function renderGoal(goal: OpenGoal, slug: string): string {
  const percent = goal.targetCents > 0 ? Math.round((goal.raisedCents / goal.targetCents) * 100) : 0;
  const width = Math.max(0, Math.min(percent, 100));
  return `<a href="${escapeHtml(tipHref(slug, goal.id))}" style="display:block;padding:8px 12px;border-radius:12px;border:1px solid var(--border);text-decoration:none;color:var(--text)">
    <span style="display:flex;justify-content:space-between;gap:12px;font-size:14px">
      <span style="font-weight:500">${escapeHtml(goal.title)}</span>
      <span style="color:var(--muted);white-space:nowrap">${formatUsd(goal.raisedCents)} of ${formatUsd(goal.targetCents)}</span>
    </span>
    <span style="display:block;margin-top:6px;height:6px;border-radius:999px;background:var(--bg2);overflow:hidden"><span style="display:block;height:100%;width:${width}%;background:var(--accent)"></span></span>
  </a>`;
}

/**
 * The "Tip directly" block, first in the content like the SPA's RichArtistProfile. `artistName` is
 * the raw name; everything is escaped here. Callers render nothing at all when the artist isn't
 * taking tips — there is no "tips off" state on the page.
 */
export function renderTipSection(slug: string, artistName: string, goals: OpenGoal[]): string {
  return `
      <div style="margin-bottom:24px;text-align:left">
        <h2 style="font-size:11px;text-transform:uppercase;letter-spacing:0.05em;color:var(--muted);margin-bottom:12px">Tip directly</h2>
        <a href="${escapeHtml(tipHref(slug))}" style="display:inline-flex;align-items:center;gap:6px;padding:10px 16px;border-radius:12px;background:var(--accent);color:#fff;font-weight:600;font-size:14px;text-decoration:none"><span aria-hidden="true">&#9829;</span> Tip ${escapeHtml(artistName)}</a>
        ${goals.length > 0 ? `<div style="display:grid;gap:8px;margin-top:12px">${goals.map(g => renderGoal(g, slug)).join('')}</div>` : ''}
      </div>
  `;
}
