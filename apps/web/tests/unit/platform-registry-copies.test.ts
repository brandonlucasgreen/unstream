// The web client's, the extension's and the Mac app's platform tables must agree with the shared
// registry.
//
// api/shared/platform-registry.ts is the source of truth: the server-rendered artist page, the
// no-JS search page, the release page and the social posts all read it. The web client keeps its
// own copy in services/sources.ts (it adds client-only fields), the extension ships plain JS
// with a payout table of its own, and the Mac app keeps one in Swift (PlatformCatalog.swift). A payout present in one copy and missing from another means the
// same link shows "~97% to artist" in one place and nothing in another — Liberapay did exactly
// that until the registry gained its figure.

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { PLATFORMS } from '../../../../api/shared/platform-registry';
import { sources } from '../../src/services/sources';
import { PAYOUT_PERCENTAGES } from '../../../../apps/extension/lib/constants.js';

const sharedIds = Object.keys(PLATFORMS).filter((id) => id in sources);
const paidIds = Object.keys(PLATFORMS).filter((id) => PLATFORMS[id].payoutPercent);

// The Mac table, read from its Swift source: one `"id": PlatformConfig(name: "…", …)` per line.
const macSource = readFileSync(
  new URL('../../../mac/Unstream/Models/PlatformCatalog.swift', import.meta.url),
  'utf8',
);
const macCatalog = new Map(
  [...macSource.matchAll(/^\s*"([a-z_]+)": PlatformConfig\(name: "([^"]+)".*$/gm)].map((m) => [
    m[1],
    { name: m[2], payout: m[0].match(/artistPayoutPercent: "([^"]+)"/)?.[1] },
  ]),
);

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

  it.each(paidIds)('%s has a payout in the extension', (id) => {
    expect(PAYOUT_PERCENTAGES[id as keyof typeof PAYOUT_PERCENTAGES]).toBe(PLATFORMS[id].payoutPercent);
  });
});

describe("the Mac app's platform catalog matches the platform registry", () => {
  it('parses the Swift table, so the checks below cover something', () => {
    expect(macCatalog.size).toBeGreaterThanOrEqual(20);
  });

  it.each(paidIds)('%s is in the catalog with the same payout', (id) => {
    expect(macCatalog.get(id)?.payout).toBe(PLATFORMS[id].payoutPercent);
  });

  it.each([...macCatalog.keys()].filter((id) => id in PLATFORMS))('%s has the same name and payout', (id) => {
    expect(macCatalog.get(id)).toEqual({ name: PLATFORMS[id].name, payout: PLATFORMS[id].payoutPercent });
  });
});
