import { describe, it, expect } from 'vitest';
import { KOFI_URL } from '../../src/data/support';

describe('support page data', () => {
  // The one way to give. A typo here silently sends every supporter to a 404.
  it('links to the Ko-fi page over https', () => {
    const url = new URL(KOFI_URL);
    expect(url.protocol).toBe('https:');
    expect(url.hostname).toBe('ko-fi.com');
    expect(url.pathname).toBe('/bgreenlol');
  });
});
