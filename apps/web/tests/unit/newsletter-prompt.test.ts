import { describe, it, expect } from 'vitest';
import { isNewAccount } from '../../src/components/NewsletterPrompt';

// The dashboard prompt greets an account as new for its first day, because the sign-in page
// can't ask new users (see NewsletterCheckbox) and this is their sign-up moment instead.
describe('isNewAccount', () => {
  const now = Date.parse('2026-09-28T12:00:00Z');

  it('is true within a day of creation', () => {
    expect(isNewAccount('2026-09-28T11:59:00Z', now)).toBe(true);
    expect(isNewAccount('2026-09-27T12:30:00Z', now)).toBe(true);
  });

  it('is false for older accounts', () => {
    expect(isNewAccount('2026-09-27T11:00:00Z', now)).toBe(false);
  });

  it('is false when the date is missing, unparseable or in the future', () => {
    expect(isNewAccount(undefined, now)).toBe(false);
    expect(isNewAccount('not a date', now)).toBe(false);
    expect(isNewAccount('2026-09-29T12:00:00Z', now)).toBe(false);
  });
});
