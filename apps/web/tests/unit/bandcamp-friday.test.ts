import { describe, it, expect } from 'vitest';
import { isBandcampFriday } from '../../src/utils/bandcamp-friday';

describe('isBandcampFriday', () => {
  it('returns true for a known Bandcamp Friday date', () => {
    // 2026-03-06 is a known Bandcamp Friday
    // Create a date in the middle of the day Pacific time
    const date = new Date('2026-03-06T12:00:00-08:00');
    expect(isBandcampFriday(date)).toBe(true);
  });

  it('returns true for another known Bandcamp Friday date', () => {
    const date = new Date('2026-05-02T15:00:00-07:00');
    expect(isBandcampFriday(date)).toBe(true);
  });

  it('returns false for a non-Bandcamp-Friday date', () => {
    const date = new Date('2026-03-07T12:00:00-08:00');
    expect(isBandcampFriday(date)).toBe(false);
  });

  it('returns false for a regular weekday', () => {
    const date = new Date('2026-01-15T12:00:00-08:00');
    expect(isBandcampFriday(date)).toBe(false);
  });

  it('handles timezone boundary: 11:59 PM PT on Bandcamp Friday is still true', () => {
    // 11:59 PM Pacific on March 6, 2026
    const date = new Date('2026-03-07T07:59:00Z'); // UTC equivalent
    expect(isBandcampFriday(date)).toBe(true);
  });

  it('handles timezone boundary: midnight PT after Bandcamp Friday is false', () => {
    // 12:00 AM Pacific on March 7, 2026 = Bandcamp Friday is over
    const date = new Date('2026-03-07T08:00:00Z'); // UTC equivalent
    expect(isBandcampFriday(date)).toBe(false);
  });

  it('accepts a custom Date parameter', () => {
    const date = new Date('2026-12-04T10:00:00-08:00');
    expect(isBandcampFriday(date)).toBe(true);
  });

  it('checks all 2026 Bandcamp Friday dates', () => {
    const dates = [
      '2026-03-06', '2026-05-02', '2026-08-07',
      '2026-09-04', '2026-10-02', '2026-11-06', '2026-12-04',
    ];

    for (const dateStr of dates) {
      const date = new Date(`${dateStr}T12:00:00-08:00`);
      expect(isBandcampFriday(date)).toBe(true);
    }
  });
});
