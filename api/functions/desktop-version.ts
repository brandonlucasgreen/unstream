import type { Handler } from '@netlify/functions';

// Desktop app version info — update this on every Mac release.
//
// This is what the Mac app's automatic update check reads. It sat at 2.1.0 while the
// app shipped 3.2.0, which went unnoticed because nothing called the checker; as of
// v3.3.0 it runs at launch, so a stale value here means users are told they're up to
// date when they aren't. Keep it in step with Info-macOS.plist.
const VERSION_INFO = {
  latestVersion: '3.5.0',
  downloadUrl: 'https://github.com/brandonlucasgreen/unstream/releases/latest',
  releaseNotes: 'Release alerts now sync dismissals across your Macs, catch more platforms, and never lose releases after time away',
};

export const handler: Handler = async (event) => {
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
};
