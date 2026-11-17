// API endpoint: POST/GET/DELETE /api/v1/keys
// Manages API keys for the public v1 API.
// - POST: Generate a new API key (requires Supabase auth)
// - GET: List user's API keys (requires Supabase auth)
// - DELETE: Revoke an API key (requires Supabase auth)

import { withSentry } from '../lib/sentry';
import { getClient } from './db';
import { endpoint, type EndpointResult, type SignedInRequest } from './http/endpoint';

const MAX_KEYS_PER_USER = 3;

// Invitation-only beta: comma-separated list of emails allowed to create API keys.
// Set via ALLOWED_API_EMAILS env var in Netlify. Admin email is always allowed.
function isEmailAllowedForApiKeys(email: string): boolean {
  const adminEmail = process.env.ADMIN_EMAIL;
  if (adminEmail && email.toLowerCase() === adminEmail.toLowerCase()) return true;

  const allowedEmails = process.env.ALLOWED_API_EMAILS;
  if (!allowedEmails) return false;

  const allowlist = allowedEmails.split(',').map(e => e.trim().toLowerCase());
  return allowlist.includes(email.toLowerCase());
}

async function handleRequest({ method, user, query, body }: SignedInRequest): Promise<EndpointResult> {
  const client = getClient();
  if (!client) {
    return { status: 500, body: { error: 'Server configuration error' } };
  }

  if (method === 'POST') {
    // Invitation-only: check if user is allowed to create API keys
    if (!isEmailAllowedForApiKeys(user.email)) {
      return { status: 403, body: { error: 'API key creation is currently available by invitation only. Contact api@unstream.stream to request access.' } };
    }
    return await handleCreateKey(user, client);
  }
  if (method === 'GET') return await handleListKeys(user, client);
  // DELETE from here on: the wrapper has already refused every other method.
  return await handleDeleteKey(user, query, body, client);
}

async function handleCreateKey(
  user: { userId: string; email: string },
  client: NonNullable<ReturnType<typeof getClient>>,
): Promise<EndpointResult> {
  // Check key count limit
  const { data: existingKeys, error: countError } = await client
    .from('api_keys')
    .select('id')
    .eq('owner_email', user.email)
    .eq('is_active', true);

  if (countError) {
    console.error('[API Keys] Error checking existing keys:', countError);
    return { status: 500, body: { error: 'Failed to check existing keys' } };
  }

  if (existingKeys && existingKeys.length >= MAX_KEYS_PER_USER) {
    return { status: 403, body: { error: `Maximum of ${MAX_KEYS_PER_USER} API keys allowed per account` } };
  }

  // Generate a new API key
  // Format: usk_{32 random hex chars}
  const keyBytes = new Uint8Array(16);
  crypto.getRandomValues(keyBytes);
  const keyValue = 'usk_' + Array.from(keyBytes).map(b => b.toString(16).padStart(2, '0')).join('');
  const keyPrefix = keyValue.slice(0, 12); // usk_ + 8 hex chars = 4 billion possible prefixes

  // Hash the key with SHA-256
  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(keyValue));
  const keyHash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');

  // Default tier limits
  const tierLimits = {
    free: { daily_limit: 100, per_minute: 30 },
    pro: { daily_limit: 10000, per_minute: 100 },
    internal: { daily_limit: 0, per_minute: 300 },
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
      per_minute: limits.per_minute,
      is_active: true,
    })
    .select('id, key_prefix, tier, daily_limit, per_minute, created_at')
    .single();

  if (error) {
    console.error('[API Keys] Error creating key:', error);
    return { status: 500, body: { error: 'Failed to create API key' } };
  }

  return {
    status: 201,
    body: {
      api_key: keyValue, // Only returned once, on creation
      key_info: {
        id: data.id,
        prefix: data.key_prefix,
        tier: data.tier,
        daily_limit: data.daily_limit,
        per_minute: data.per_minute,
        created_at: data.created_at,
      },
    },
  };
}

async function handleListKeys(
  user: { userId: string; email: string },
  client: NonNullable<ReturnType<typeof getClient>>,
): Promise<EndpointResult> {
  const { data, error } = await client
    .from('api_keys')
    .select('id, key_prefix, tier, daily_limit, per_minute, is_active, created_at, last_used_at, description')
    .eq('owner_email', user.email);

  if (error) {
    console.error('[API Keys] Error listing keys:', error);
    return { status: 500, body: { error: 'Failed to list API keys' } };
  }

  return { status: 200, body: { keys: data || [] } };
}

async function handleDeleteKey(
  user: { userId: string; email: string },
  query: SignedInRequest['query'],
  body: SignedInRequest['body'],
  client: NonNullable<ReturnType<typeof getClient>>,
): Promise<EndpointResult> {
  // Accept key ID from query string or request body
  const keyId = query.id || (body.id as string | undefined);

  if (!keyId) {
    return { status: 400, body: { error: 'Key ID is required' } };
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
    return { status: 404, body: { error: 'API key not found or already revoked' } };
  }

  return { status: 200, body: { message: 'API key revoked' } };
}

export const handler = withSentry(endpoint({
  cors: 'site',
  methods: ['POST', 'GET', 'DELETE'],
  auth: 'bearer',
  rateLimit: 'none',
  // Only DELETE reads a body (the key's id, when it isn't in the query string).
  jsonBody: true,
  envelope: 'v1',
}, handleRequest));
