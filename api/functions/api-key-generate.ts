// API endpoint: POST/GET/DELETE /api/v1/keys
// Manages API keys for the public v1 API.
// - POST: Generate a new API key (requires Supabase auth)
// - GET: List user's API keys (requires Supabase auth)
// - DELETE: Revoke an API key (requires Supabase auth)

import { getClient } from './db';
import { authenticateBearer, buildCorsHeaders } from './middleware';

const MAX_KEYS_PER_USER = 3;

interface NetlifyEvent {
  httpMethod: string;
  headers: Record<string, string | undefined>;
  queryStringParameters?: Record<string, string>;
  body?: string;
}

export async function handler(event: NetlifyEvent) {
  const origin = event.headers.origin || event.headers.Origin;
  const corsHeaders = buildCorsHeaders(origin, false, {
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  });

  // CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders, body: '' };
  }

  // Authenticate user via Supabase JWT
  const authHeader = event.headers.authorization || event.headers.Authorization;
  const user = await authenticateBearer(authHeader);

  if (!user) {
    return {
      statusCode: 401,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Authentication required' }),
    };
  }

  const client = getClient();
  if (!client) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Server configuration error' }),
    };
  }

  try {
    switch (event.httpMethod) {
      case 'POST':
        return await handleCreateKey(user, client, corsHeaders);
      case 'GET':
        return await handleListKeys(user, client, corsHeaders);
      case 'DELETE':
        return await handleDeleteKey(user, event, client, corsHeaders);
      default:
        return {
          statusCode: 405,
          headers: corsHeaders,
          body: JSON.stringify({ error: 'Method not allowed' }),
        };
    }
  } catch (err) {
    console.error('[API Keys] Error:', err);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
}

async function handleCreateKey(
  user: { userId: string; email: string },
  client: NonNullable<ReturnType<typeof getClient>>,
  corsHeaders: Record<string, string>,
) {
  // Check key count limit
  const { data: existingKeys, error: countError } = await client
    .from('api_keys')
    .select('id')
    .eq('owner_email', user.email)
    .eq('is_active', true);

  if (countError) {
    console.error('[API Keys] Error checking existing keys:', countError);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Failed to check existing keys' }),
    };
  }

  if (existingKeys && existingKeys.length >= MAX_KEYS_PER_USER) {
    return {
      statusCode: 403,
      headers: corsHeaders,
      body: JSON.stringify({ error: `Maximum of ${MAX_KEYS_PER_USER} API keys allowed per account` }),
    };
  }

  // Generate a new API key
  // Format: usk_{32 random hex chars}
  const keyBytes = new Uint8Array(16);
  crypto.getRandomValues(keyBytes);
  const keyValue = 'usk_' + Array.from(keyBytes).map(b => b.toString(16).padStart(2, '0')).join('');
  const keyPrefix = keyValue.slice(0, 8);

  // Hash the key with SHA-256
  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(keyValue));
  const keyHash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');

  // Default tier limits
  const tierLimits = {
    free: { daily_limit: 100, per_second: 5 },
    pro: { daily_limit: 10000, per_second: 10 },
    internal: { daily_limit: 0, per_second: 30 },
  };

  const defaultTier = 'free';
  const limits = tierLimits[defaultTier];

  // Insert the key into the database
  const { data, error } = await client
    .from('api_keys')
    .insert({
      owner_email: user.email,
      owner_name: user.email.split('@')[0],
      key_prefix: keyPrefix,
      key_hash: keyHash,
      tier: defaultTier,
      daily_limit: limits.daily_limit,
      per_second: limits.per_second,
      is_active: true,
    })
    .select('id, key_prefix, tier, daily_limit, per_second, created_at')
    .single();

  if (error) {
    console.error('[API Keys] Error creating key:', error);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Failed to create API key' }),
    };
  }

  return {
    statusCode: 201,
    headers: corsHeaders,
    body: JSON.stringify({
      api_key: keyValue, // Only returned once, on creation
      key_info: {
        id: data.id,
        prefix: data.key_prefix,
        tier: data.tier,
        daily_limit: data.daily_limit,
        per_second: data.per_second,
        created_at: data.created_at,
      },
    }),
  };
}

async function handleListKeys(
  user: { userId: string; email: string },
  client: NonNullable<ReturnType<typeof getClient>>,
  corsHeaders: Record<string, string>,
) {
  const { data, error } = await client
    .from('api_keys')
    .select('id, key_prefix, tier, daily_limit, per_second, is_active, created_at, last_used_at, description')
    .eq('owner_email', user.email);

  if (error) {
    console.error('[API Keys] Error listing keys:', error);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Failed to list API keys' }),
    };
  }

  return {
    statusCode: 200,
    headers: corsHeaders,
    body: JSON.stringify({ keys: data || [] }),
  };
}

async function handleDeleteKey(
  user: { userId: string; email: string },
  event: NetlifyEvent,
  client: NonNullable<ReturnType<typeof getClient>>,
  corsHeaders: Record<string, string>,
) {
  let keyId: string | undefined;
  // Accept key ID from query string or request body
  keyId = event.queryStringParameters?.id;
  if (!keyId && event.body) {
    try {
      const body = JSON.parse(event.body);
      keyId = body.id;
    } catch {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'Invalid JSON body' }),
      };
    }
  }

  if (!keyId) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Key ID is required' }),
    };
  }

  // Revoke the key (soft delete by setting is_active = false)
  const { data, error } = await client
    .from('api_keys')
    .update({ is_active: false, revoked_at: new Date().toISOString() })
    .eq('id', keyId)
    .eq('owner_email', user.email) // Ensure user can only revoke their own keys
    .eq('is_active', true) // Only revoke active keys
    .select('id')
    .single();

  if (error || !data) {
    return {
      statusCode: 404,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'API key not found or already revoked' }),
    };
  }

  return {
    statusCode: 200,
    headers: corsHeaders,
    body: JSON.stringify({ message: 'API key revoked' }),
  };
}