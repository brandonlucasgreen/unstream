import { withSentry } from '../lib/sentry';
import { MAC_RELEASE } from '../shared/desktop-release';
import { endpoint, type EndpointResult } from './http/endpoint';

// The pre-Sparkle update check: versions up to 3.5.0 poll this at launch and, if it reports
// something newer, post a notification linking to the download. 3.6.0 and later use Sparkle
// (/appcast.xml) and never call this — but old installs are exactly the ones that need to be
// told an update exists, so it stays, reading the same release constant as the appcast.
const VERSION_INFO = {
  latestVersion: MAC_RELEASE.shortVersion,
  downloadUrl: MAC_RELEASE.releasesPageUrl,
  releaseNotes: MAC_RELEASE.releaseNotes,
};

async function handleRequest(): Promise<EndpointResult> {
  return { status: 200, body: VERSION_INFO };
}

export const handler = withSentry(endpoint({
  cors: 'public',
  methods: ['GET'],
  auth: 'none',
  rateLimit: 'none',
  jsonBody: false,
}, handleRequest));
