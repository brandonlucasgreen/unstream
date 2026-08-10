import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'crypto';
import {
  encryptCredential,
  decryptCredential,
  isCredentialKeyConfigured,
} from '../credential-crypto';

const TEST_KEY = randomBytes(32).toString('base64');

describe('credential-crypto', () => {
  const originalKey = process.env.BANDCAMP_CREDENTIAL_KEY;

  beforeEach(() => {
    process.env.BANDCAMP_CREDENTIAL_KEY = TEST_KEY;
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.BANDCAMP_CREDENTIAL_KEY;
    else process.env.BANDCAMP_CREDENTIAL_KEY = originalKey;
  });

  it('round-trips a credential payload', () => {
    const payload = JSON.stringify({ t: 'abcdef0123456789', s: 'somesalt' });
    const blob = encryptCredential(payload);
    expect(decryptCredential(blob)).toBe(payload);
  });

  it('produces a different blob each time (fresh IV), both decryptable', () => {
    const a = encryptCredential('secret');
    const b = encryptCredential('secret');
    expect(a).not.toBe(b);
    expect(decryptCredential(a)).toBe('secret');
    expect(decryptCredential(b)).toBe('secret');
  });

  it('never contains the plaintext in the stored blob', () => {
    const blob = encryptCredential('supersecretpassword');
    expect(blob).not.toContain('supersecretpassword');
    expect(Buffer.from(blob.split('.')[2], 'base64').toString('utf8')).not.toContain(
      'supersecretpassword'
    );
  });

  it('throws on decryption with a different key', () => {
    const blob = encryptCredential('secret');
    process.env.BANDCAMP_CREDENTIAL_KEY = randomBytes(32).toString('base64');
    expect(() => decryptCredential(blob)).toThrow();
  });

  it('throws on a tampered blob (GCM auth)', () => {
    const blob = encryptCredential('secret');
    const parts = blob.split('.');
    const ct = Buffer.from(parts[2], 'base64');
    ct[0] = ct[0] ^ 0xff;
    const tampered = `${parts[0]}.${parts[1]}.${ct.toString('base64')}`;
    expect(() => decryptCredential(tampered)).toThrow();
  });

  it('throws on a malformed blob', () => {
    expect(() => decryptCredential('not-a-real-blob')).toThrow('Malformed credential ciphertext');
  });

  it('throws when the key is missing', () => {
    delete process.env.BANDCAMP_CREDENTIAL_KEY;
    expect(() => encryptCredential('secret')).toThrow('BANDCAMP_CREDENTIAL_KEY is not configured');
    expect(isCredentialKeyConfigured()).toBe(false);
  });

  it('throws when the key is the wrong length', () => {
    process.env.BANDCAMP_CREDENTIAL_KEY = randomBytes(16).toString('base64');
    expect(() => encryptCredential('secret')).toThrow('32 bytes');
    expect(isCredentialKeyConfigured()).toBe(false);
  });

  it('reports configured with a valid key', () => {
    expect(isCredentialKeyConfigured()).toBe(true);
  });
});
