// API endpoint: POST /api/admin/merge-override
// Admin-only endpoint for creating artist merge overrides from the UI.

import { createClient } from '@supabase/supabase-js';
import { getClient } from './db';

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'info@kidlightbulbs.com';

async function authenticateAdmin(authHeader: string | undefined): Promise<{ userId: string; email: string } | null> {
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);

  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;

  const anonClient = createClient(url, anonKey);
  const { data, error } = await anonClient.auth.getUser(token);
  if (error || !data.user || !data.user.email) return null;

  if (data.user.email.toLowerCase() !== ADMIN_EMAIL) return null;

  return { userId: data.user.id, email: data.user.email };
}

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

export async function handler(event: {
  httpMethod: string;
  headers: Record<string, string | undefined>;
  body?: string;
}) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }

  const admin = await authenticateAdmin(event.headers['authorization'] || event.headers['Authorization'] || undefined);
  if (!admin) {
    return {
      statusCode: 401,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Unauthorized' }),
    };
  }

  let body: {
    group_name?: string;
    platform_urls?: string[];
    excluded_urls?: string[];
    canonical_image_url?: string | null;
    notes?: string | null;
  };

  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Invalid JSON' }),
    };
  }

  const { group_name, platform_urls, excluded_urls, canonical_image_url, notes } = body;

  if (!group_name?.trim()) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'group_name is required' }),
    };
  }

  if (!Array.isArray(platform_urls) || platform_urls.length < 2) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'At least 2 platform_urls are required' }),
    };
  }

  const client = getClient();
  if (!client) {
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Database not configured' }),
    };
  }

  const { data, error } = await client
    .from('artist_merge_overrides')
    .insert({
      group_name: group_name.trim(),
      platform_urls,
      excluded_urls: excluded_urls || [],
      canonical_image_url: canonical_image_url || null,
      notes: notes || null,
    })
    .select()
    .single();

  if (error) {
    console.error('[Admin] Failed to insert merge override:', error);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        error: 'Failed to save merge override',
        detail: error.message || error.code || String(error),
      }),
    };
  }

  return {
    statusCode: 201,
    headers: CORS_HEADERS,
    body: JSON.stringify({ success: true, override: data }),
  };
}
