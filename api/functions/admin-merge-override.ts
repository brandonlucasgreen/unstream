// API endpoint: POST /api/admin/merge-override
// Admin-only endpoint for creating artist merge overrides from the UI.

import { createClient } from '@supabase/supabase-js';
import { getClient } from './db';

const ADMIN_EMAIL = 'info@kidlightbulbs.com';

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

export default async function handler(request: Request) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: CORS_HEADERS,
    });
  }

  const admin = await authenticateAdmin(request.headers.get('Authorization') || undefined);
  if (!admin) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: CORS_HEADERS,
    });
  }

  let body: {
    group_name?: string;
    platform_urls?: string[];
    excluded_urls?: string[];
    canonical_image_url?: string | null;
    notes?: string | null;
  };

  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400,
      headers: CORS_HEADERS,
    });
  }

  const { group_name, platform_urls, excluded_urls, canonical_image_url, notes } = body;

  if (!group_name?.trim()) {
    return new Response(JSON.stringify({ error: 'group_name is required' }), {
      status: 400,
      headers: CORS_HEADERS,
    });
  }

  if (!Array.isArray(platform_urls) || platform_urls.length < 2) {
    return new Response(JSON.stringify({ error: 'At least 2 platform_urls are required' }), {
      status: 400,
      headers: CORS_HEADERS,
    });
  }

  const client = getClient();
  if (!client) {
    return new Response(JSON.stringify({ error: 'Database not configured' }), {
      status: 500,
      headers: CORS_HEADERS,
    });
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
    return new Response(JSON.stringify({ error: 'Failed to save merge override' }), {
      status: 500,
      headers: CORS_HEADERS,
    });
  }

  return new Response(JSON.stringify({ success: true, override: data }), {
    status: 201,
    headers: CORS_HEADERS,
  });
}
