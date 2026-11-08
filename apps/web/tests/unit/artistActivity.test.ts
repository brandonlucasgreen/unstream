// The sentences on an artist's Analytics page. They have to be true at the sizes artists actually
// see — one save, two clicks — and never name or place a fan.
import { describe, it, expect } from 'vitest';
import { describeActivity, describeDay, type ActivityItem } from 'src/utils/artistActivity';

const names: Record<string, string> = { bandcamp: 'Bandcamp', mirlo: 'Mirlo', ampwall: 'Ampwall' };
const say = (item: Omit<ActivityItem, 'day'>) => describeActivity({ day: '2026-11-03', ...item }, id => names[id] ?? id);

describe('describeActivity', () => {
  it('has a one and a many for each kind', () => {
    expect(say({ kind: 'saved', count: 1 })).toBe('A fan saved you');
    expect(say({ kind: 'saved', count: 3 })).toBe('3 fans saved you');
    expect(say({ kind: 'view', count: 1 })).toBe('1 view of your Unstream page');
    expect(say({ kind: 'search', count: 2 })).toBe('You came up in 2 searches');
    expect(say({ kind: 'release_alert', count: 1, release: 'Lightbulbs' })).toBe('Your release alert for Lightbulbs went to 1 fan');
  });

  it('names every platform clicked through to', () => {
    expect(say({ kind: 'click', count: 1, platforms: ['bandcamp'] })).toBe('1 click through to your Bandcamp');
    expect(say({ kind: 'click', count: 4, platforms: ['bandcamp', 'mirlo', 'ampwall'] }))
      .toBe('4 clicks through to your Bandcamp, Mirlo and Ampwall');
  });

  it('gives tip amounts as money', () => {
    expect(say({ kind: 'tip', count: 1, amountCents: 500 })).toBe('You got a $5.00 tip');
    expect(say({ kind: 'tip', count: 2, amountCents: 1250 })).toBe('You got 2 tips, $12.50 in all');
  });

  it('says what "heard while streaming" means', () => {
    expect(say({ kind: 'streaming', count: 1 })).toMatch(/listening to you on a streaming service/);
  });
});

describe('describeDay', () => {
  const today = new Date('2026-11-08T15:00:00Z');
  it('says today and yesterday in words', () => {
    expect(describeDay('2026-11-08', today)).toBe('Today');
    expect(describeDay('2026-11-07', today)).toBe('Yesterday');
  });

  it('shows the year only when it differs', () => {
    expect(describeDay('2026-10-03', today)).not.toMatch(/2026/);
    expect(describeDay('2025-10-03', today)).toMatch(/2025/);
  });
});
