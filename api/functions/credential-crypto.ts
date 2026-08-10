// Encryption for stored third-party credentials (bandcamp_connections.credential_ciphertext).
//
// This is the repo's first at-rest encryption, so the choice is deliberate rather than an
// implementation detail. Three options were on the table:
//
//   - pgcrypto: the key is passed inside SQL text, so it lands in Postgres logs and
//     pg_stat_statements. Rejected.
//   - Supabase Vault: key and ciphertext live in the same trust domain (the database), and
//     decryption can't be unit-tested without a live DB. Rejected.
//   - App-level AES-256-GCM with the key in a Netlify env var (this file): the ciphertext
//     lives in Supabase, the key lives in Netlify — a leak of either store alone reveals
//     nothing. Same handling as BUTTONDOWN_API_KEY. Chosen.
//
// Node's crypto module, not crypto.subtle — Netlify's Node runtime has had gaps in
// crypto.subtle support before (see me-feed-token.ts history).
//
// Key: BANDCAMP_CREDENTIAL_KEY, 32 bytes, base64-encoded. Generate one with:
//   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
//
// Rotating the key invalidates every stored credential; users would reconnect. That is the
// accepted trade-off for never writing the key anywhere but the env.

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // NIST-recommended nonce size for GCM

function getKey(): Buffer {
  const raw = process.env.BANDCAMP_CREDENTIAL_KEY;
  if (!raw) {
    throw new Error('BANDCAMP_CREDENTIAL_KEY is not configured');
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error('BANDCAMP_CREDENTIAL_KEY must be 32 bytes, base64-encoded');
  }
  return key;
}

/** True when the env carries a usable key. Callers use this to fail fast with a clear 500. */
export function isCredentialKeyConfigured(): boolean {
  try {
    getKey();
    return true;
  } catch {
    return false;
  }
}

/**
 * Encrypt a plaintext string. Returns `base64(iv).base64(authTag).base64(ciphertext)` —
 * dot-separated so it stores as one opaque text column.
 */
export function encryptCredential(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${authTag.toString('base64')}.${ciphertext.toString('base64')}`;
}

/**
 * Decrypt a value produced by encryptCredential. Throws on a malformed blob, a wrong key,
 * or any tampering (GCM authenticates) — callers treat a throw as "credential unusable,
 * user must reconnect", never as an empty credential.
 */
export function decryptCredential(blob: string): string {
  const key = getKey();
  const parts = blob.split('.');
  if (parts.length !== 3) {
    throw new Error('Malformed credential ciphertext');
  }
  const [iv, authTag, ciphertext] = parts.map(p => Buffer.from(p, 'base64'));
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
