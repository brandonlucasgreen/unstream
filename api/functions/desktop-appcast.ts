import { withSentry } from '../lib/sentry';
import { MAC_RELEASE, isSparkleReady, type MacRelease } from '../shared/desktop-release';
import { escapeXml } from '../shared/feed-format';
import { endpoint, type EndpointResult } from './http/endpoint';

// The Sparkle appcast the Mac app reads (SUFeedURL in apps/mac/Unstream/Info-macOS.plist).
// Routed at /appcast.xml — the conventional path, and the one baked into shipped builds, so
// treat it as a stable contract rather than an internal endpoint.
//
// Served from a constant rather than derived from the GitHub releases API on purpose: the
// EdDSA signature isn't in GitHub's release metadata, and an appcast without a valid one is
// rejected by every client. Keeping version, URL, length and signature in one committed
// object means they can't drift apart.

export function buildAppcast(release: MacRelease): string {
  const items = isSparkleReady(release)
    ? `
    <item>
      <title>Version ${escapeXml(release.shortVersion)}</title>
      <link>${escapeXml(release.releasesPageUrl)}</link>
      <description>${escapeXml(release.releaseNotes)}</description>
      <pubDate>${new Date(release.publishedAt).toUTCString()}</pubDate>
      <sparkle:version>${escapeXml(release.build)}</sparkle:version>
      <sparkle:shortVersionString>${escapeXml(release.shortVersion)}</sparkle:shortVersionString>
      <sparkle:fullReleaseNotesLink>${escapeXml(release.releasesPageUrl)}</sparkle:fullReleaseNotesLink>
      <sparkle:minimumSystemVersion>${escapeXml(release.minimumSystemVersion)}</sparkle:minimumSystemVersion>
      <enclosure url="${escapeXml(release.url)}" length="${release.lengthBytes}" type="application/octet-stream" sparkle:edSignature="${escapeXml(release.edSignature)}" />
    </item>`
    : '';

  return `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
  <channel>
    <title>Unstream for Mac</title>
    <link>https://unstream.stream/appcast.xml</link>
    <description>Updates for the Unstream Mac app.</description>
    <language>en</language>${items}
  </channel>
</rss>
`;
}

async function handleRequest(): Promise<EndpointResult> {
  const headers = {
    'Content-Type': 'application/xml; charset=utf-8',
    // Sparkle checks once a day per install, so this only smooths bursts — but it also means
    // a freshly published release takes up to 15 minutes to appear. Don't raise it much.
    'Cache-Control': 'public, max-age=900',
  };

  return { status: 200, raw: buildAppcast(MAC_RELEASE), headers };
}

export const handler = withSentry(endpoint({
  cors: 'none',
  methods: ['GET'],
  auth: 'none',
  rateLimit: 'none',
  jsonBody: false,
}, handleRequest));
