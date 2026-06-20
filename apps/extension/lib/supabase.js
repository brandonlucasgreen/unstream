// Supabase auth client for the Unstream browser extension.
// Implements the auth REST API directly (no SDK dependency) because
// the extension has no build step and can't import @supabase/supabase-js.
// Tokens are persisted to chrome.storage.local so users stay signed in
// across browser restarts and service worker cold starts.

const SUPABASE_URL = 'https://bwogclqzpsbvqbyhhqbz.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJ3b2djbHF6cHNidnFieWhocWJ6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMzMTMyODcsImV4cCI6MjA4ODg4OTI4N30.AUcgWjqcsIbcTm-RkjaY2jtVMYmAHaPVE52oGeOsblM';

const AUTH_URL = `${SUPABASE_URL}/auth/v1`;

function authHeaders(accessToken) {
  const headers = {
    'apikey': SUPABASE_ANON_KEY,
    'Content-Type': 'application/json',
  };
  if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;
  return headers;
}

// ---- Session persistence ----

const SESSION_KEY = 'unstream_auth_session';

export async function getStoredSession() {
  const result = await chrome.storage.local.get(SESSION_KEY);
  const session = result[SESSION_KEY];
  if (!session || !session.access_token) return null;
  // Check expiry (refresh 60s before it actually expires)
  if (session.expires_at && session.expires_at * 1000 < Date.now() + 60000) {
    // Token expired — try refresh
    const refreshed = await refreshSession(session);
    if (refreshed) return refreshed;
    // Refresh failed — clear session
    await clearSession();
    return null;
  }
  return session;
}

async function storeSession(session) {
  if (session) {
    await chrome.storage.local.set({ [SESSION_KEY]: session });
  } else {
    await chrome.storage.local.remove(SESSION_KEY);
  }
}

async function clearSession() {
  await chrome.storage.local.remove(SESSION_KEY);
}

// ---- Auth API ----

// Sign in with email + password
export async function signInWithPassword(email, password) {
  const response = await fetch(`${AUTH_URL}/token?grant_type=password`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ email, password }),
  });

  const data = await response.json();

  if (!response.ok) {
    return { error: data.error_description || data.msg || data.message || 'Sign in failed' };
  }

  const session = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: data.expires_at,
    user: data.user,
  };

  await storeSession(session);
  return { session };
}

// Send a magic link (OTP) to the user's email
export async function signInWithOtp(email, redirectTo) {
  const body = { email };
  if (redirectTo) body.options = { emailRedirectTo: redirectTo };

  const response = await fetch(`${AUTH_URL}/otp`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  });

  const data = await response.json();

  if (!response.ok) {
    return { error: data.error_description || data.msg || data.message || 'Failed to send magic link' };
  }

  return { success: true };
}

// Sign out — revoke the refresh token
export async function signOut() {
  const session = await getStoredSession();
  if (session?.refresh_token) {
    try {
      await fetch(`${AUTH_URL}/logout`, {
        method: 'POST',
        headers: authHeaders(session.access_token),
        body: JSON.stringify({ refresh_token: session.refresh_token }),
      });
    } catch {
      // Best effort — if the network call fails, we still clear locally
    }
  }
  await clearSession();
}

// Refresh an expired access token
async function refreshSession(session) {
  if (!session?.refresh_token) return null;

  try {
    const response = await fetch(`${AUTH_URL}/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ refresh_token: session.refresh_token }),
    });

    if (!response.ok) return null;

    const data = await response.json();
    const newSession = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: data.expires_at,
      user: data.user,
    };

    await storeSession(newSession);
    return newSession;
  } catch {
    return null;
  }
}

// Get a valid access token (refreshing if needed)
export async function getAccessToken() {
  const session = await getStoredSession();
  return session?.access_token || null;
}

// Get current user info from stored session
export async function getCurrentUser() {
  const session = await getStoredSession();
  return session?.user || null;
}

// Handle magic link callback — extract tokens from URL hash/params
// and store the session
export async function handleMagicLinkCallback(url) {
  try {
    const parsed = new URL(url);
    let accessToken, refreshToken, expiresIn, tokenType;

    // Check hash fragment first (Supabase default)
    const hash = parsed.hash.substring(1);
    const hashParams = new URLSearchParams(hash);
    accessToken = hashParams.get('access_token');
    refreshToken = hashParams.get('refresh_token');
    expiresIn = hashParams.get('expires_in');
    tokenType = hashParams.get('token_type');

    // Fallback to query params
    if (!accessToken) {
      accessToken = parsed.searchParams.get('access_token');
      refreshToken = parsed.searchParams.get('refresh_token');
      expiresIn = parsed.searchParams.get('expires_in');
      tokenType = parsed.searchParams.get('token_type');
    }

    if (!accessToken) return null;

    // Fetch user info with the access token
    const userResponse = await fetch(`${AUTH_URL}/user`, {
      headers: authHeaders(accessToken),
    });

    if (!userResponse.ok) return null;

    const user = await userResponse.json();
    const expiresAt = expiresIn ? Math.floor(Date.now() / 1000) + parseInt(expiresIn, 10) : null;

    const session = {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_at: expiresAt,
      user,
    };

    await storeSession(session);
    return session;
  } catch {
    return null;
  }
}

// ---- Device ID ----

const DEVICE_ID_KEY = 'unstream_device_id';
let deviceIdCache = null;

export async function getDeviceId() {
  if (deviceIdCache) return deviceIdCache;
  const result = await chrome.storage.local.get(DEVICE_ID_KEY);
  if (result[DEVICE_ID_KEY]) {
    deviceIdCache = result[DEVICE_ID_KEY];
    return deviceIdCache;
  }
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ [DEVICE_ID_KEY]: id });
  deviceIdCache = id;
  return id;
}