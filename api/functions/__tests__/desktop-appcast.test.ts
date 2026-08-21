import { describe, it, expect } from 'vitest';
import { buildAppcast } from '../desktop-appcast';
import { MAC_RELEASE, isSparkleReady, type MacRelease } from '../../shared/desktop-release';

const SIGNED: MacRelease = {
  shortVersion: '3.6.0',
  build: '16',
  url: 'https://github.com/brandonlucasgreen/unstream/releases/download/v3.6.0/Unstream-3.6.0.dmg',
  lengthBytes: 12_345_678,
  edSignature: 'oPBNSDb/S8xqO2b1s6lRe0uMOLxvOJHJ5w0kbEXAMPLEsignatureBASE64==',
  publishedAt: '2026-08-21T14:30:00Z',
  minimumSystemVersion: '13.0',
  releaseNotes: 'Sparkle updates & "quoted" <notes>',
  releasesPageUrl: 'https://github.com/brandonlucasgreen/unstream/releases',
};

describe('buildAppcast', () => {
  it('publishes the build number as sparkle:version, not the marketing version', () => {
    // Sparkle compares sparkle:version against the installed CFBundleVersion. Publishing
    // "3.6.0" there against a CFBundleVersion of "16" makes every install think it's newer
    // than the update, and the update is silently never offered.
    const xml = buildAppcast(SIGNED);
    expect(xml).toContain('<sparkle:version>16</sparkle:version>');
    expect(xml).toContain('<sparkle:shortVersionString>3.6.0</sparkle:shortVersionString>');
  });

  it('carries the enclosure Sparkle needs to verify the download', () => {
    const xml = buildAppcast(SIGNED);
    expect(xml).toContain(`url="${SIGNED.url}"`);
    expect(xml).toContain('length="12345678"');
    expect(xml).toContain(`sparkle:edSignature="${SIGNED.edSignature}"`);
  });

  it('formats pubDate as RFC 822 rather than ISO 8601', () => {
    expect(buildAppcast(SIGNED)).toContain('<pubDate>Fri, 21 Aug 2026 14:30:00 GMT</pubDate>');
  });

  it('escapes release notes instead of emitting invalid XML', () => {
    const xml = buildAppcast(SIGNED);
    expect(xml).toContain('Sparkle updates &amp; &quot;quoted&quot; &lt;notes&gt;');
    expect(xml).not.toContain('<notes>');
  });

  it('serves an empty channel rather than an unsigned item', () => {
    // An item with no signature parses fine and is then rejected by every client, which
    // reads to the user as "no update available" — a silent failure. Better to publish
    // nothing until the release is actually signed.
    const xml = buildAppcast({ ...SIGNED, edSignature: '', lengthBytes: 0 });
    expect(xml).not.toContain('<item>');
    expect(xml).toContain('<title>Unstream for Mac</title>');
  });

  it('requires both a signature and a length before publishing', () => {
    expect(isSparkleReady(SIGNED)).toBe(true);
    expect(isSparkleReady({ ...SIGNED, edSignature: '' })).toBe(false);
    expect(isSparkleReady({ ...SIGNED, lengthBytes: 0 })).toBe(false);
  });
});

describe('MAC_RELEASE', () => {
  it('names a DMG under the tag matching its own version', () => {
    // The release checklist edits several fields by hand; this catches the copy-paste where
    // the version moves but the download URL still points at the previous tag.
    expect(MAC_RELEASE.url).toContain(`/v${MAC_RELEASE.shortVersion}/`);
  });

  it('has a build number Sparkle can compare numerically', () => {
    expect(Number(MAC_RELEASE.build)).toBeGreaterThan(0);
  });
});
