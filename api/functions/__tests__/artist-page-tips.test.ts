// The tips block on the server-rendered artist page (api/shared/artist-page-tips.ts, used by
// api/edge/artist-page-static.ts). Artist names and goal titles are artist-controlled text landing
// in crawler HTML, so escaping is the point of most of these tests. The eligibility rules mirror
// api/functions/tips-db.ts and api/functions/stripe.ts, and are pinned here too.

import { describe, it, expect } from 'vitest';
import {
  stripeModeFromKey,
  isTipAccountTakingTips,
  renderTipSection,
  type TipAccountSnapshot,
} from '../../shared/artist-page-tips';

const ATTACK = `"><script>alert(1)</script>`;

const LIVE_ACCOUNT: TipAccountSnapshot = {
  user_id: 'owner-1',
  charges_enabled: true,
  tips_enabled: true,
  tips_approved_at: '2026-10-01T00:00:00Z',
  deauthorized_at: null,
};

describe('stripeModeFromKey', () => {
  it('reads the mode from the key prefix, like stripeMode()', () => {
    expect(stripeModeFromKey('sk_live_abc')).toBe('live');
    expect(stripeModeFromKey('rk_live_abc')).toBe('live');
    expect(stripeModeFromKey('sk_test_abc')).toBe('test');
    expect(stripeModeFromKey('rk_test_abc')).toBe('test');
  });

  it('treats a missing or unrecognised key as tips off', () => {
    expect(stripeModeFromKey(undefined)).toBeNull();
    expect(stripeModeFromKey('')).toBeNull();
    expect(stripeModeFromKey('pk_live_abc')).toBeNull();
  });
});

describe('isTipAccountTakingTips', () => {
  it('accepts an approved, enabled, connected account owned by the current owner', () => {
    expect(isTipAccountTakingTips(LIVE_ACCOUNT, 'owner-1')).toBe(true);
  });

  it('rejects each missing condition', () => {
    expect(isTipAccountTakingTips(null, 'owner-1')).toBe(false);
    expect(isTipAccountTakingTips(LIVE_ACCOUNT, null)).toBe(false);
    expect(isTipAccountTakingTips(LIVE_ACCOUNT, 'someone-else')).toBe(false);
    expect(isTipAccountTakingTips({ ...LIVE_ACCOUNT, charges_enabled: false }, 'owner-1')).toBe(false);
    expect(isTipAccountTakingTips({ ...LIVE_ACCOUNT, tips_enabled: false }, 'owner-1')).toBe(false);
    expect(isTipAccountTakingTips({ ...LIVE_ACCOUNT, tips_approved_at: null }, 'owner-1')).toBe(false);
    expect(isTipAccountTakingTips({ ...LIVE_ACCOUNT, deauthorized_at: '2026-10-02T00:00:00Z' }, 'owner-1')).toBe(false);
  });
});

describe('renderTipSection', () => {
  it('links "Tip <artist>" to /tip/<slug> with no script and no modal hook', () => {
    const html = renderTipSection('kid-lightbulbs', 'Kid Lightbulbs', []);
    expect(html).toContain('href="/tip/kid-lightbulbs"');
    expect(html).toContain('Tip Kid Lightbulbs</a>');
    expect(html).not.toContain('<script');
    expect(html).not.toMatch(/\son[a-z]+=/i);
  });

  it('escapes the artist name', () => {
    const html = renderTipSection('x', `Tom's "Band" ${ATTACK}`, []);
    expect(html).not.toContain('<script>');
    expect(html).toContain('Tip Tom&#39;s &quot;Band&quot; &quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;</a>');
  });

  it('escapes goal titles', () => {
    const html = renderTipSection('x', 'Artist', [
      { id: 'g1', title: `New van <img src=x onerror=alert(1)> & "gear"`, targetCents: 50000, raisedCents: 0 },
    ]);
    expect(html).not.toContain('<img');
    expect(html).toContain('New van &lt;img src=x onerror=alert(1)&gt; &amp; &quot;gear&quot;');
  });

  it('URL-encodes the slug and goal id so neither can break out of the href', () => {
    const html = renderTipSection(ATTACK, 'Artist', [
      { id: `g1"><script>&x=1`, title: 'Goal', targetCents: 100, raisedCents: 0 },
    ]);
    expect(html).not.toContain('<script>');
    // Every href holds only its own value: no quote or angle bracket inside it.
    const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map(m => m[1]);
    expect(hrefs).toHaveLength(2);
    for (const href of hrefs) expect(href).not.toMatch(/[<>"']/);
    expect(html).toContain(`href="/tip/${encodeURIComponent(ATTACK)}"`);
    expect(html).toContain(`?goal=${encodeURIComponent('g1"><script>&x=1')}"`);
  });

  it('shows each open goal as raised of target, linking to its goal', () => {
    const html = renderTipSection('kid-lightbulbs', 'Kid Lightbulbs', [
      { id: 'g1', title: 'Tour van', targetCents: 240000, raisedCents: 12050 },
    ]);
    expect(html).toContain('href="/tip/kid-lightbulbs?goal=g1"');
    expect(html).toContain('Tour van');
    expect(html).toContain('$120.50 of $2,400.00');
    expect(html).toContain('width:5%');
  });

  it('caps the bar at full when a goal passes its target', () => {
    const html = renderTipSection('x', 'Artist', [
      { id: 'g1', title: 'Goal', targetCents: 1000, raisedCents: 2500 },
    ]);
    expect(html).toContain('$25.00 of $10.00');
    expect(html).toContain('width:100%');
  });

  it('renders no goals list when there are none', () => {
    const html = renderTipSection('x', 'Artist', []);
    expect(html).not.toContain('?goal=');
  });
});
