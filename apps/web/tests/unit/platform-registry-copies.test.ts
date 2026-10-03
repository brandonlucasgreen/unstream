// The web client's and the extension's platform tables must agree with the shared registry.
//
// api/shared/platform-registry.ts is the source of truth: the server-rendered artist page, the
// no-JS search page, the release page and the social posts all read it. The web client keeps its
// own copy in services/sources.ts (it adds client-only fields), and the extension ships plain JS
// with a payout table of its own. A payout present in one copy and missing from another means the
// same link shows "~97% to artist" in one place and nothing in another — Liberapay did exactly
// that until the registry gained its figure.

import { describe, it, expect } from 'vitest';
import { PLATFORMS } from '../../../../api/shared/platform-registry';
import { sources } from '../../src/services/sources';
import { PAYOUT_PERCENTAGES } from '../../../../apps/extension/lib/constants.js';

const sharedIds = Object.keys(PLATFORMS).filter((id) => id in sources);

describe('services/sources.ts matches the platform registry', () => {
  it('shares most platforms with it, so the checks below cover something', () => {
    expect(sharedIds.length).toBeGreaterThanOrEqual(25);
  });

  it.each(sharedIds)('%s has the same payout', (id) => {
    const web = sources[id as keyof typeof sources];
    expect(web.artistPayoutPercent).toBe(PLATFORMS[id].payoutPercent);
  });

  it.each(sharedIds)('%s has the same name, icon and category', (id) => {
    const web = sources[id as keyof typeof sources];
    const registry = PLATFORMS[id];
    expect({ name: web.name, icon: web.icon, category: web.category }).toEqual({
      name: registry.name,
      icon: registry.icon,
      category: registry.category,
    });
  });
});

describe("the extension's payout table matches the platform registry", () => {
  it.each(Object.entries(PAYOUT_PERCENTAGES))('%s pays %s', (id, payout) => {
    expect(PLATFORMS[id]?.payoutPercent).toBe(payout);
  });
});
