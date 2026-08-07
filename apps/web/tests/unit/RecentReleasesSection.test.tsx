// @vitest-environment jsdom
// The "Recent Releases" shortlist on /dashboard — the web's first fan-facing release surface.
//
// What's worth locking here is the set of things that would be quietly wrong rather than broken:
// a fabricated date on a year-only release, a secondhand marketplace ranked above a direct
// purchase, an empty state that vanishes instead of explaining itself, and a subscribe control
// that mints a credential nobody asked for.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, within, fireEvent } from '@testing-library/react';
import { RecentReleasesSection, type RecentRelease } from 'src/components/RecentReleasesSection';

function release(overrides: Partial<RecentRelease> = {}): RecentRelease {
  return {
    artistName: 'Kid Lightbulbs',
    artistSlug: 'kid-lightbulbs',
    title: 'A Record',
    releaseSlug: 'a-record',
    releaseDate: '2024-06-01',
    datePrecision: 'day',
    artworkUrl: null,
    sources: [],
    ...overrides,
  };
}

// Rendered with **no Router on purpose**, the same as ReleasesSection's tests: a react-router
// <Link> throws without one, so this harness is what keeps the rows real anchors.
// `/a/{artist}/{release}` is served only by the release-page edge function, and a client-side
// navigation there matches no SPA route and renders a blank page.
function show(releases: RecentRelease[], error: string | null = null) {
  return render(
    <RecentReleasesSection
      releases={releases}
      error={error}
      subscribePanel={<p>subscribe panel</p>}
    />
  );
}

afterEach(cleanup);

describe('RecentReleasesSection', () => {
  it('links each release to its buying guide, by the release’s own artist', () => {
    show([
      release({ artistSlug: 'explosions-in-the-sky', releaseSlug: 'the-earth', title: 'The Earth' }),
    ]);

    expect(screen.getByRole('link', { name: /The Earth/ }).getAttribute('href')).toBe(
      '/a/explosions-in-the-sky/the-earth'
    );
  });

  it('names the artist on every row — the one thing an artist page never has to say', () => {
    show([release({ artistName: 'Explosions in the Sky' })]);
    expect(screen.getByText('Explosions in the Sky')).toBeTruthy();
  });

  it('never states a date more precisely than the source did', () => {
    show([release({ releaseDate: '2024-01-01', datePrecision: 'year' })]);

    expect(screen.getByText(/2024/).textContent).toContain('2024');
    expect(screen.queryByText(/1 January 2024/)).toBeNull();
  });

  it('quotes the price from the artist-paying source, not the cheapest one', () => {
    show([
      release({
        sources: [
          {
            platform: 'discogs',
            offers: [{ price: 2.64, currency: 'USD', availability: 'available' }],
          },
          {
            platform: 'bandcamp',
            offers: [{ price: 25, currency: 'USD', availability: 'available' }],
          },
        ],
      }),
    ]);

    // Bandcamp pays the artist far more than a Discogs secondhand listing, so it leads even
    // though it is nearly ten times the price.
    expect(screen.getByText(/from \$25/)).toBeTruthy();
    expect(screen.queryByText(/\$2\.64/)).toBeNull();
  });

  it('marks a release dated in the future as coming', () => {
    const nextYear = String(new Date().getUTCFullYear() + 1);
    show([
      release({ releaseDate: `${nextYear}-03-01`, releaseSlug: 'later' }),
      release({ releaseDate: '2020-03-01', releaseSlug: 'earlier' }),
    ]);

    const rows = screen.getAllByRole('link');
    expect(within(rows[0]).getByText('Coming')).toBeTruthy();
    expect(within(rows[1]).queryByText('Coming')).toBeNull();
  });

  it('explains itself when there is nothing new, rather than disappearing', () => {
    show([]);
    expect(screen.getByText(/Nothing new from your saved artists this month/)).toBeTruthy();
    // The subscribe control has to survive the empty state — a fan with nothing out this month
    // is exactly who wants to be told when something is.
    expect(screen.getByRole('button', { name: /Subscribe to these releases/ })).toBeTruthy();
  });

  it('says so when the read failed, instead of claiming there is nothing new', () => {
    show([], "Couldn't load recent releases. Try refreshing.");
    expect(screen.getByText(/Couldn't load recent releases/)).toBeTruthy();
    expect(screen.queryByText(/Nothing new from your saved artists/)).toBeNull();
  });

  it('reveals the subscribe panel only on request', () => {
    show([release()]);

    // Collapsed on mount: a feed token is a credential, and the panel behind this button is
    // where one gets minted.
    expect(screen.queryByText('subscribe panel')).toBeNull();

    const toggle = screen.getByRole('button', { name: /Subscribe to these releases/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(toggle);
    expect(screen.getByText('subscribe panel')).toBeTruthy();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
  });

  it('offers one subscribe control, not one per format', () => {
    show([release()]);
    // Two marks, one action. Two buttons hitting the same feed token would be two treatments
    // for one action.
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });

  it('names the platforms for a screen reader, which the icons alone cannot', () => {
    show([
      release({
        sources: [{ platform: 'jamcoop', offers: [] }],
      }),
    ]);

    // The registry's name, not the raw id.
    expect(screen.getByText(/Available on Jam\.coop/)).toBeTruthy();
  });
});

describe('RecentReleasesSection date boundary', () => {
  afterEach(() => vi.useRealTimers());

  it('does not call today’s release "coming"', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-07T12:00:00Z'));

    show([release({ releaseDate: '2026-08-07' })]);
    expect(screen.queryByText('Coming')).toBeNull();
  });
});
