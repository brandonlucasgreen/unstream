import { MAC_RELEASE } from '../shared/desktop-release';

// The pre-Sparkle update check: versions up to 3.5.0 poll this at launch and, if it reports
// something newer, post a notification linking to the download. 3.6.0 and later use Sparkle
// (/appcast.xml) and never call this — but old installs are exactly the ones that need to be
// told an update exists, so it stays, reading the same release constant as the appcast.
const VERSION_INFO = {
  latestVersion: MAC_RELEASE.shortVersion,
  downloadUrl: MAC_RELEASE.releasesPageUrl,
  releaseNotes: MAC_RELEASE.releaseNotes,
};

export async function handler(event: { httpMethod?: string }) {
  // Handle CORS
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify(VERSION_INFO),
  };
}
