import type { Handler } from '@netlify/functions';

// Desktop app version info - update this when releasing new versions
const VERSION_INFO = {
  latestVersion: '1.1.1',
  downloadUrl: 'https://github.com/brandonlucasgreen/unstream/releases/latest',
  releaseNotes: 'Improved update checker with download link',
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
