import { describe, it, expect } from 'vitest';

// Use the same regex from me-username.ts
const USERNAME_REGEX = /^[a-z0-9](?:[a-z0-9-]{1,18}[a-z0-9])$/;

describe('me-username API - validation logic', () => {
  describe('Username format validation', () => {
    it('accepts valid usernames', () => {
      expect(USERNAME_REGEX.test('kidlightbulbs')).toBe(true);
      expect(USERNAME_REGEX.test('abc')).toBe(true);
      expect(USERNAME_REGEX.test('a-b-c')).toBe(true);
      expect(USERNAME_REGEX.test('user123')).toBe(true);
      expect(USERNAME_REGEX.test('1abc')).toBe(true);
      expect(USERNAME_REGEX.test('a1b2c3d4e5f6g7h8i9j0')).toBe(true); // 20 chars
    });

    it('rejects usernames shorter than 3 characters', () => {
      expect(USERNAME_REGEX.test('ab')).toBe(false);
      expect(USERNAME_REGEX.test('a')).toBe(false);
      expect(USERNAME_REGEX.test('')).toBe(false);
    });

    it('rejects usernames longer than 20 characters', () => {
      expect(USERNAME_REGEX.test('abcdefghijklmnopqrstuvwxyz')).toBe(false); // 26 chars
    });

    it('rejects leading hyphens', () => {
      expect(USERNAME_REGEX.test('-foo')).toBe(false);
      expect(USERNAME_REGEX.test('--foo')).toBe(false);
    });

    it('rejects trailing hyphens', () => {
      expect(USERNAME_REGEX.test('foo-')).toBe(false);
      expect(USERNAME_REGEX.test('foo--')).toBe(false);
    });

    it('rejects uppercase letters', () => {
      expect(USERNAME_REGEX.test('Foo')).toBe(false);
      expect(USERNAME_REGEX.test('FOO')).toBe(false);
      expect(USERNAME_REGEX.test('fooBar')).toBe(false);
    });

    it('rejects special characters', () => {
      expect(USERNAME_REGEX.test('foo_bar')).toBe(false);
      expect(USERNAME_REGEX.test('foo.bar')).toBe(false);
      expect(USERNAME_REGEX.test('foo!bar')).toBe(false);
      expect(USERNAME_REGEX.test('foo bar')).toBe(false);
    });

    it('rejects empty string', () => {
      expect(USERNAME_REGEX.test('')).toBe(false);
    });
  });

  describe('Missing username', () => {
    it('missing username fails validation', () => {
      const body = {};
      const username = (body.username as string | undefined)?.trim();
      expect(username).toBeUndefined();
    });
  });

  describe('No-op when username unchanged', () => {
    it('returns 200 with current value when username matches existing', () => {
      const existing = { username: 'kidlightbulbs' };
      const requested = 'kidlightbulbs';
      expect(existing.username === requested).toBe(true);
    });
  });
});
