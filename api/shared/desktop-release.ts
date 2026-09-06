// The current Mac release. Single source of truth for the two endpoints that describe it:
// /appcast.xml (what Sparkle reads inside the app) and /api/desktop/version (the older,
// hand-rolled check that versions up to 3.5.0 still poll).
//
// Update this on every Mac release — see apps/mac/docs/sparkle-updates.md for the steps that
// produce `lengthBytes` and `edSignature`. A stale value here is not a harmless nit: it tells
// people they're up to date when they aren't, which is exactly what happened when this lived
// in desktop-version.ts and sat at 2.1.0 while the app shipped 3.2.0.

export interface MacRelease {
  /** CFBundleShortVersionString — the version people see, e.g. "3.6.0". */
  shortVersion: string;
  /**
   * CFBundleVersion — the build number, e.g. "16". This is what Sparkle actually compares
   * against the installed app, so it MUST match Info-macOS.plist's CFBundleVersion and must
   * increase on every release. A short version that went up while this stayed put means
   * Sparkle sees no update.
   */
  build: string;
  /** The notarized, stapled DMG Sparkle downloads and installs. */
  url: string;
  /** Byte length of that DMG, from `sign_update`. Sparkle rejects a mismatch. */
  lengthBytes: number;
  /** EdDSA signature of that DMG, from `sign_update`. */
  edSignature: string;
  /** ISO 8601. Rendered as the appcast item's RFC 822 pubDate. */
  publishedAt: string;
  /** Matches the Mac deployment target in apps/mac/project.yml. */
  minimumSystemVersion: string;
  /** Shown in Sparkle's update alert and in the legacy endpoint's response. */
  releaseNotes: string;
  /** Where "Version History" and the website's download button point. */
  releasesPageUrl: string;
}

export const MAC_RELEASE: MacRelease = {
  shortVersion: '3.6.1',
  build: '17',
  url: 'https://github.com/brandonlucasgreen/unstream/releases/download/v3.6.1/Unstream-3.6.1.dmg',
  lengthBytes: 4301800,
  edSignature: 'dPBq5G6415V6qaPj9byMyeENv97VS7rnjZXUeXutb5vaj2QLAQkhg/gVUqxtxJa1YEoVVWiFDpTv/EmDKXEQCw==',
  publishedAt: '2026-09-06T00:00:00Z',
  minimumSystemVersion: '13.0',
  releaseNotes:
    'Unstream now updates itself instead of sending you to GitHub. Also fixes magic-link sign-in.',
  releasesPageUrl: 'https://github.com/brandonlucasgreen/unstream/releases',
};

/**
 * Whether the release above is ready to be offered to Sparkle.
 *
 * An unsigned or zero-length entry would be served as a perfectly well-formed appcast that
 * every client then rejects at the signature check — a silent failure that looks like "no
 * update available". Better to serve an empty feed and say why. 3.6.1 is the first signed
 * release; 3.5.0 and earlier predate Sparkle and were served with these fields empty.
 */
export function isSparkleReady(release: MacRelease): boolean {
  return release.edSignature.length > 0 && release.lengthBytes > 0;
}
