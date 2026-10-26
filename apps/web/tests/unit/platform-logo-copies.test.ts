// The extension and the Mac app keep their own copies of the platform logos in
// api/shared/platform-logos.ts, because neither can import from api/. A copy that drifts draws a
// different (or broken) Subvert logo in one client only, which nobody would notice until a fan did.

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { PLATFORM_LOGO_PATHS, platformLogoSvg } from '../../../../api/shared/platform-logos';
import { SIMPLE_ICON_PATHS } from '../../src/components/PlatformIcon';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const extensionPopup = read('../../../extension/popup/popup.js');
const macBrandIcons = read('../../../mac/Unstream/Views/Shared/BrandIcons.swift');

const logoIds = Object.keys(PLATFORM_LOGO_PATHS);

describe('platform logo copies', () => {
  it('has a logo to check', () => {
    expect(logoIds).toContain('subvert');
  });

  it.each(logoIds)('%s is drawn by the web PlatformIcon', (id) => {
    expect(SIMPLE_ICON_PATHS[id as keyof typeof SIMPLE_ICON_PATHS]?.d).toBe(PLATFORM_LOGO_PATHS[id]);
  });

  it.each(logoIds)('%s is the same path in the extension popup', (id) => {
    expect(extensionPopup).toContain(`  ${id}: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="currentColor" d="${PLATFORM_LOGO_PATHS[id]}"/></svg>',`);
  });

  it.each(logoIds)('%s is the same path in the Mac app', (id) => {
    expect(macBrandIcons).toContain(`static let ${id} = "${PLATFORM_LOGO_PATHS[id]}"`);
  });
});

const markIds = Object.keys(SIMPLE_ICON_PATHS) as (keyof typeof SIMPLE_ICON_PATHS)[];

// The extension popup's result pills draw every mark the web's PlatformIcon does (PLATFORM_LOGOS
// in popup.js), in the pill's text colour.
describe('extension platform marks', () => {
  it.each(markIds)('%s is the same path and fill rule in the extension pills', (id) => {
    const icon = SIMPLE_ICON_PATHS[id]!;
    const rule = icon.fillRule === 'evenodd' ? ' fill-rule="evenodd"' : '';
    expect(extensionPopup).toContain(
      `  ${id}: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="currentColor"${rule} d="${icon.d}"/></svg>',`
    );
  });
});

// The Mac app's platform pills draw every mark the web's PlatformIcon does (platformLogos in
// BrandIcons.swift), from copies of SIMPLE_ICON_PATHS.
describe('Mac app platform marks', () => {

  it.each(markIds)('%s is the same path in the Mac app', (id) => {
    expect(macBrandIcons).toContain(`static let ${id} = "${SIMPLE_ICON_PATHS[id]!.d}"`);
  });

  it.each(markIds)('%s is drawn in the Mac app with the same fill rule', (id) => {
    const evenOdd = SIMPLE_ICON_PATHS[id]!.fillRule === 'evenodd' ? ', evenOdd: true' : '';
    expect(macBrandIcons).toContain(`"${id}": PlatformLogo(path: BrandIconPaths.${id}${evenOdd}),`);
  });
});

describe('platformLogoSvg', () => {
  it('draws the logo in the surrounding text colour', () => {
    const svg = platformLogoSvg('subvert', 18)!;
    expect(svg).toContain('width="18" height="18" viewBox="0 0 24 24" fill="currentColor"');
    expect(svg).toContain(`d="${PLATFORM_LOGO_PATHS.subvert}"`);
  });

  it('returns null for a platform without one, so the page prints its emoji', () => {
    expect(platformLogoSvg('bandcamp', 18)).toBeNull();
  });
});
