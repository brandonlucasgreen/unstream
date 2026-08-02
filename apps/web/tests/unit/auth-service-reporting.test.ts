import { describe, it, expect, vi, beforeEach } from 'vitest';

const captureMessage = vi.fn();
const signInWithPassword = vi.fn();
const signInWithOtp = vi.fn();
const resetPasswordForEmail = vi.fn();

vi.mock('@sentry/react', () => ({ captureMessage: (...args: unknown[]) => captureMessage(...args) }));
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ auth: { signInWithPassword, signInWithOtp, resetPasswordForEmail } }),
}));

vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co');
vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-key');

const authError = (message: string, status?: number, code?: string) => ({
  name: 'AuthApiError',
  message,
  status,
  code,
});

/**
 * Supabase hands auth failures back as `{ error }` rather than throwing, so the
 * try/catch in LoginPage never runs for them and nothing was ever reported.
 * These cover the reporting added at the service boundary — including the one
 * failure deliberately left silent.
 */
describe('auth service failure reporting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('reports a rate-limited sign-in', async () => {
    signInWithPassword.mockResolvedValue({ error: authError('Request rate limit reached', 429, 'over_request_rate_limit') });
    const { signInWithPassword: signIn } = await import('../../src/services/auth');

    const { error } = await signIn('artist@example.com', 'hunter2');

    expect(error).toBe('Request rate limit reached');
    expect(captureMessage).toHaveBeenCalledTimes(1);
    const [message, options] = captureMessage.mock.calls[0];
    expect(message).toBe('Auth failed: passwordLogin');
    expect(options.tags).toMatchObject({ context: 'auth.service', auth_operation: 'passwordLogin', auth_status: '429' });
    expect(options.extra).toMatchObject({ errorMessage: 'Request rate limit reached', errorCode: 'over_request_rate_limit' });
  });

  it('stays silent on a wrong password', async () => {
    // The common case by a wide margin. Reporting it would bury every real
    // failure under thousands of user typos.
    signInWithPassword.mockResolvedValue({ error: authError('Invalid login credentials', 400, 'invalid_credentials') });
    const { signInWithPassword: signIn } = await import('../../src/services/auth');

    const { error } = await signIn('artist@example.com', 'wrong');

    expect(error).toBe('Invalid login credentials');
    expect(captureMessage).not.toHaveBeenCalled();
  });

  it('reports a magic link failure', async () => {
    signInWithOtp.mockResolvedValue({ error: authError('Email logins are disabled', 422, 'email_provider_disabled') });
    const { signInWithMagicLink } = await import('../../src/services/auth');

    await signInWithMagicLink('artist@example.com', 'https://unstream.stream/login');

    expect(captureMessage).toHaveBeenCalledTimes(1);
    expect(captureMessage.mock.calls[0][0]).toBe('Auth failed: magicLink');
  });

  it('reports a password reset failure', async () => {
    resetPasswordForEmail.mockResolvedValue({ error: authError('Database error', 500) });
    const { resetPasswordForEmail: reset } = await import('../../src/services/auth');

    await reset('artist@example.com', 'https://unstream.stream/reset-password');

    expect(captureMessage).toHaveBeenCalledTimes(1);
    expect(captureMessage.mock.calls[0][0]).toBe('Auth failed: resetPassword');
  });

  it('reports nothing when a call succeeds', async () => {
    signInWithPassword.mockResolvedValue({ error: null });
    const { signInWithPassword: signIn } = await import('../../src/services/auth');

    const { error } = await signIn('artist@example.com', 'correct');

    expect(error).toBeNull();
    expect(captureMessage).not.toHaveBeenCalled();
  });
});
