// @vitest-environment jsdom
// Pure helpers for two-step verification. The interesting one is
// needsSecondFactor: it decides when the whole app is held behind the sign-in
// challenge, so its edge cases matter — especially that an unreadable token
// counts as *needing* the challenge (fail closed) rather than not.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Session, User } from '@supabase/supabase-js';
import {
  decodeAalClaim,
  friendlyTotpError,
  hasVerifiedSecondFactor,
  needsSecondFactor,
  normalizeTotpCode,
} from 'src/utils/mfa';
import { shouldShowSecurityNudge, SECURITY_NUDGE_DISMISSED_KEY } from 'src/utils/securityNudge';
import { totpQrDataUri, passkeysSupported } from 'src/services/mfa';

function encode(payload: Record<string, unknown>): string {
  return btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function tokenWith(payload: Record<string, unknown>): string {
  return `header.${encode(payload)}.signature`;
}

const AAL1_TOKEN = tokenWith({ aal: 'aal1', sub: 'user-1' });
const AAL2_TOKEN = tokenWith({ aal: 'aal2', sub: 'user-1' });

function makeFactor(status: 'verified' | 'unverified', type: 'totp' | 'webauthn' = 'totp') {
  return {
    id: `factor-${type}`,
    factor_type: type,
    status,
    created_at: '2026-11-01T00:00:00Z',
    updated_at: '2026-11-01T00:00:00Z',
  };
}

function makeUser(factors: ReturnType<typeof makeFactor>[] = []): User {
  return {
    id: 'user-1',
    email: 'fan@example.com',
    aud: 'authenticated',
    app_metadata: {},
    user_metadata: {},
    created_at: '2026-10-01T00:00:00Z',
    factors,
  } as unknown as User;
}

function makeSession(user: User, accessToken: string): Session {
  return {
    access_token: accessToken,
    refresh_token: 'refresh',
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user,
  } as unknown as Session;
}

describe('decodeAalClaim', () => {
  it('reads aal2 from a token that completed the second factor', () => {
    expect(decodeAalClaim(AAL2_TOKEN)).toBe('aal2');
  });

  it('reads aal1 from a single-factor token', () => {
    expect(decodeAalClaim(AAL1_TOKEN)).toBe('aal1');
  });

  it('returns null when the token carries no aal claim', () => {
    expect(decodeAalClaim(tokenWith({ sub: 'user-1' }))).toBeNull();
  });

  it('returns null for something that is not a JWT', () => {
    expect(decodeAalClaim('not-a-jwt')).toBeNull();
  });

  it('returns null when the payload is not valid base64url', () => {
    expect(decodeAalClaim('header.!!!!.signature')).toBeNull();
  });

  it('handles base64url alphabets (dash and underscore)', () => {
    const payload = { sub: 'a-b_c', aal: 'aal1' };
    expect(decodeAalClaim(tokenWith(payload))).toBe('aal1');
  });
});

describe('hasVerifiedSecondFactor', () => {
  it('is true with a verified factor', () => {
    expect(hasVerifiedSecondFactor(makeUser([makeFactor('verified')]))).toBe(true);
  });

  it('is false when the only factor is unverified', () => {
    expect(hasVerifiedSecondFactor(makeUser([makeFactor('unverified')]))).toBe(false);
  });

  it('is false with no factors or no user', () => {
    expect(hasVerifiedSecondFactor(makeUser())).toBe(false);
    expect(hasVerifiedSecondFactor(null)).toBe(false);
  });
});

describe('needsSecondFactor', () => {
  it('is false without a session', () => {
    expect(needsSecondFactor(null)).toBe(false);
  });

  it('is false for an account with no factors, even at aal1', () => {
    expect(needsSecondFactor(makeSession(makeUser(), AAL1_TOKEN))).toBe(false);
  });

  it('is false for an account whose only factor is unverified', () => {
    const user = makeUser([makeFactor('unverified')]);
    expect(needsSecondFactor(makeSession(user, AAL1_TOKEN))).toBe(false);
  });

  it('is true when a verified factor exists and the session is aal1', () => {
    const user = makeUser([makeFactor('verified')]);
    expect(needsSecondFactor(makeSession(user, AAL1_TOKEN))).toBe(true);
  });

  it('is false once the session has completed the second factor (aal2)', () => {
    const user = makeUser([makeFactor('verified')]);
    expect(needsSecondFactor(makeSession(user, AAL2_TOKEN))).toBe(false);
  });

  it('is true when a verified factor exists but the token is unreadable — the gate fails closed', () => {
    const user = makeUser([makeFactor('verified')]);
    expect(needsSecondFactor(makeSession(user, 'garbage'))).toBe(true);
  });
});

describe('shouldShowSecurityNudge', () => {
  it('is true for a signed-in account with no second factor', () => {
    expect(shouldShowSecurityNudge(makeUser())).toBe(true);
  });

  it('is true when the only factor is unverified', () => {
    expect(shouldShowSecurityNudge(makeUser([makeFactor('unverified')]))).toBe(true);
  });

  it('is false once a factor is verified', () => {
    expect(shouldShowSecurityNudge(makeUser([makeFactor('verified')]))).toBe(false);
  });

  it('is false after dismissal, and other metadata does not count as one', () => {
    const dismissed = {
      ...makeUser(),
      user_metadata: { [SECURITY_NUDGE_DISMISSED_KEY]: '2026-11-01T00:00:00Z' },
    } as unknown as User;
    expect(shouldShowSecurityNudge(dismissed)).toBe(false);

    const hasPassword = { ...makeUser(), user_metadata: { has_password: true } } as unknown as User;
    expect(shouldShowSecurityNudge(hasPassword)).toBe(true);
  });

  it('is false without a user', () => {
    expect(shouldShowSecurityNudge(null)).toBe(false);
  });
});

describe('totpQrDataUri', () => {
  it('wraps raw SVG markup in a data URI, encoding URL-unsafe characters', () => {
    const uri = totpQrDataUri('<svg xmlns="#">...</svg>');
    expect(uri).toBe(`data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="#">...</svg>')}`);
  });

  it('passes through a value that is already a data URI', () => {
    expect(totpQrDataUri('data:image/svg+xml;utf8,already')).toBe('data:image/svg+xml;utf8,already');
  });
});

describe('passkeysSupported', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is false where the browser has no WebAuthn support', () => {
    expect(passkeysSupported()).toBe(false);
  });

  it('is false on an insecure page even with WebAuthn support', () => {
    vi.stubGlobal('PublicKeyCredential', class {});
    vi.stubGlobal('isSecureContext', false);
    expect(passkeysSupported()).toBe(false);
  });

  it('is true on a secure page with WebAuthn support', () => {
    vi.stubGlobal('PublicKeyCredential', class {});
    vi.stubGlobal('isSecureContext', true);
    expect(passkeysSupported()).toBe(true);
  });
});

describe('normalizeTotpCode', () => {
  it('keeps six digits, with or without the space apps display', () => {
    expect(normalizeTotpCode('123456')).toBe('123456');
    expect(normalizeTotpCode('123 456')).toBe('123456');
    expect(normalizeTotpCode(' 123456 ')).toBe('123456');
  });

  it('rejects anything that is not six digits', () => {
    expect(normalizeTotpCode('12345')).toBeNull();
    expect(normalizeTotpCode('1234567')).toBeNull();
    expect(normalizeTotpCode('')).toBeNull();
  });
});

describe('friendlyTotpError', () => {
  it('rewrites Supabase\'s wrong-code message', () => {
    expect(friendlyTotpError('Invalid TOTP code entered')).toMatch(/didn't match/);
  });

  it('passes anything else through', () => {
    expect(friendlyTotpError('Too many requests')).toBe('Too many requests');
  });
});
