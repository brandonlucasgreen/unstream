import { describe, it, expect } from 'vitest';
import { KOFI_URL, UPCOMING_COSTS } from '../../src/data/support';

describe('support page data', () => {
  // The one way to give. A typo here silently sends every supporter to a 404.
  it('links to the Ko-fi page over https', () => {
    const url = new URL(KOFI_URL);
    expect(url.protocol).toBe('https:');
    expect(url.hostname).toBe('ko-fi.com');
    expect(url.pathname).toBe('/bgreenlol');
  });

  it('lists each cost with a name and a rough monthly figure', () => {
    expect(UPCOMING_COSTS.length).toBeGreaterThan(0);
    for (const cost of UPCOMING_COSTS) {
      expect(cost.service).not.toBe('');
      expect(cost.monthly).not.toBe('');
    }
  });

  // Vendors are being reconsidered, so the page names what the money pays for, not who.
  it('does not name infrastructure vendors', () => {
    const text = UPCOMING_COSTS.map((cost) => `${cost.service} ${cost.what ?? ''}`).join(' ');
    expect(text).not.toMatch(/supabase|upstash|redis|netlify/i);
  });
});
