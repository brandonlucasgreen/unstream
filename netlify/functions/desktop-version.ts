import type { Handler } from '@netlify/functions';

// Desktop app version info - update this when releasing new versions
const VERSION_INFO = {
  latestVersion: '1.2.3',
  downloadUrl: 'https://github.com/brandonlucasgreen/unstream/releases/latest',
  releaseNotes: 'Social media links for artists (Instagram, TikTok, YouTube, Threads, Bluesky, Facebook, X)',
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
