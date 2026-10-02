import { describe, it, expect } from 'vitest';
import { isTamperedErrorConstructorError } from '../../src/services/sentry';

/**
 * Supabase auth's lock-timeout error sets `isAcquireTimeout` on itself in its
 * constructor. That only fails when a script injected ahead of ours has replaced the
 * global `Error` with one that returns non-extensible objects.
 */
describe('isTamperedErrorConstructorError', () => {
  it('matches the reported Chrome error', () => {
    expect(isTamperedErrorConstructorError(
      'TypeError: Cannot add property isAcquireTimeout, object is not extensible'
    )).toBe(true);
  });

  it("matches Firefox's wording", () => {
    expect(isTamperedErrorConstructorError(
      'TypeError: can\'t define property "isAcquireTimeout": Object is not extensible'
    )).toBe(true);
  });

  it('leaves other non-extensible errors alone', () => {
    expect(isTamperedErrorConstructorError(
      'TypeError: Cannot add property releases, object is not extensible'
    )).toBe(false);
  });

  it('leaves other auth lock errors alone', () => {
    expect(isTamperedErrorConstructorError(
      "TypeError: Cannot read properties of undefined (reading 'isAcquireTimeout')"
    )).toBe(false);
  });
});
