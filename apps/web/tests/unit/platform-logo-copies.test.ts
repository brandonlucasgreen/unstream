// The extension and the Mac app keep their own copies of the platform logos in
// api/shared/platform-logos.ts, because neither can import from api/. A copy that drifts draws a
// different (or broken) Subvert logo in one client only, which nobody would notice until a fan did.

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { PLATFORM_LOGO_PATHS, platformLogoSvg } from '../../../../api/shared/platform-logos';
import { SIMPLE_ICON_PATHS } from '../../src/components/PlatformIcon';
import { SOCIAL_ICON_PATHS } from '../../../../api/shared/social-icon-paths';
import { sources, sourceCategories } from '../../src/services/sources';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const extensionPopup = read('../../../extension/popup/popup.js');
const macBrandIcons = read('../../../mac/Unstream/Views/Shared/BrandIcons.swift');
const widget = read('../../public/widget.js');

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

// The embed widget (public/widget.js) runs on artists' own sites and is served as-is, so it keeps
// its own table. It drew emoji for most platforms (🎵 for Bandcamp) and skipped any platform it
// didn't list (Subvert), while the embed preview on the artist page showed no icons at all.
describe('embed widget platforms', () => {
  // widget.js keeps every emoji as \u escapes: a partner page served in another charset would
  // otherwise decode the script's raw UTF-8 into mojibake.
  const jsEscape = (text: string) =>
    [...text]
      .flatMap((ch) => [...Array(ch.length).keys()].map((i) => ch.charCodeAt(i)))
      .map((code) => '\\u' + code.toString(16).toUpperCase().padStart(4, '0'))
      .join('');

  it('has no raw non-ASCII text outside its comments', () => {
    const code = widget.split('\n').filter((line) => !line.trimStart().startsWith('//'));
    expect(code.filter((line) => /[^\x00-\x7F]/.test(line))).toEqual([]);
  });

  const widgetTable = new Map(
    [...widget.matchAll(/^ {4}([a-z]+): \{ name: '([^']*)', (d|emoji): /gm)].map((m) => [m[1], m[2]]),
  );
  const platformIds = Object.keys(sources).filter(
    (id) => !(id in sourceCategories) && id !== 'other',
  ) as (keyof typeof sources)[];

  it('lists every platform the site draws, by the same name', () => {
    expect(Object.fromEntries(widgetTable)).toEqual(
      Object.fromEntries(platformIds.map((id) => [id, sources[id].name])),
    );
  });

  it.each(platformIds)('%s has the same mark (or emoji) as the site', (id) => {
    const mark = SIMPLE_ICON_PATHS[id as keyof typeof SIMPLE_ICON_PATHS] ?? SOCIAL_ICON_PATHS[id];
    const name = sources[id].name;
    if (mark) {
      const rule = 'fillRule' in mark && mark.fillRule ? `, fillRule: '${mark.fillRule}'` : '';
      expect(widget).toContain(`    ${id}: { name: '${name}', d: '${mark.d}'${rule} },`);
    } else {
      expect(widget).toContain(`    ${id}: { name: '${name}', emoji: '${jsEscape(sources[id].icon)}' },`);
    }
  });
});

describe('platformLogoSvg', () => {
  it('draws the logo in the surrounding text colour', () => {
    const svg = platformLogoSvg('subvert', 18)!;
    expect(svg).toContain('width="18" height="18" viewBox="0 0 24 24" fill="currentColor"');
    expect(svg).toContain(`d="${PLATFORM_LOGO_PATHS.subvert}"`);
  });

  // Every mark the SPA draws, not only the logos platforms sent us: the edge pages had only
  // Subvert's until 2026-11-06, so every Bandcamp card on a release page showed 🎵.
  it.each(markIds)('draws the %s mark on the edge-rendered pages too', (id) => {
    expect(platformLogoSvg(id, 18)).toContain(`d="${SIMPLE_ICON_PATHS[id]!.d}"`);
  });

  it('keeps the fill rule the mark needs', () => {
    expect(platformLogoSvg('ampwall', 18)).toContain('fill-rule="evenodd"');
    expect(platformLogoSvg('bandcamp', 18)).not.toContain('fill-rule');
  });

  it('returns null for a platform without one, so the page prints its emoji', () => {
    expect(platformLogoSvg('steady', 18)).toBeNull();
  });
});
