// @vitest-environment jsdom
// The "Releases" section on /my-collection — Upcoming, Recent and the calendar under one
// heading. The web's first
// fan-facing release surface.
//
// What's worth locking here is the set of things that would be quietly wrong rather than broken:
// an unreleased album filed under "Recent", a fabricated date on a year-only release, a secondhand
// marketplace ranked above a direct purchase, an empty state that vanishes instead of explaining
// itself, and a subscribe control that mints a credential nobody asked for.
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
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
function show(
  lists: { upcoming?: RecentRelease[]; recent?: RecentRelease[] },
  error: string | null = null
) {
  return render(
    <RecentReleasesSection
      upcoming={lists.upcoming ?? []}
      recent={lists.recent ?? []}
      error={error}
      subscribePanel={<p>subscribe panel</p>}
    />
  );
}

afterEach(cleanup);

describe('RecentReleasesSection', () => {
  it('links each release to its buying guide, by the release’s own artist', () => {
    show({
      recent: [
        release({ artistSlug: 'explosions-in-the-sky', releaseSlug: 'the-earth', title: 'The Earth' }),
      ],
    });

    expect(screen.getByRole('link', { name: /The Earth/ }).getAttribute('href')).toBe(
      '/a/explosions-in-the-sky/the-earth'
    );
  });

  it('names the artist on every row — the one thing an artist page never has to say', () => {
    show({ recent: [release({ artistName: 'Explosions in the Sky' })] });
    expect(screen.getByText('Explosions in the Sky')).toBeTruthy();
  });

  it('never states a date more precisely than the source did', () => {
    show({ recent: [release({ releaseDate: '2024-01-01', datePrecision: 'year' })] });

    expect(screen.getByText(/2024/).textContent).toContain('2024');
    expect(screen.queryByText(/1 January 2024/)).toBeNull();
  });

  it('quotes the price from the artist-paying source, not the cheapest one', () => {
    show({
      recent: [
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
      ],
    });

    // Bandcamp pays the artist far more than a Discogs secondhand listing, so it leads even
    // though it is nearly ten times the price.
    expect(screen.getByText(/from \$25/)).toBeTruthy();
    expect(screen.queryByText(/\$2\.64/)).toBeNull();
  });

  it('heads the two lists separately under one section, upcoming first', () => {
    show({
      upcoming: [release({ releaseSlug: 'announced', title: 'Announced' })],
      recent: [release({ releaseSlug: 'out', title: 'Out Now' })],
    });

    // One h2 for the group, a smaller one per item, calendar last.
    const headings = screen.getAllByRole('heading').map(h => h.textContent);
    expect(headings).toEqual(['Releases', 'Upcoming', 'Recent', 'Release calendar']);
    expect(screen.getByRole('heading', { name: 'Releases' }).tagName).toBe('H2');
    expect(screen.getByRole('heading', { name: 'Upcoming' }).tagName).toBe('H3');

    // And each row sits under its own heading — the whole point of the split.
    const order = screen.getAllByRole('link').map(a => a.getAttribute('href'));
    expect(order).toEqual(['/a/kid-lightbulbs/announced', '/a/kid-lightbulbs/out']);
  });

  it('renders only the list that has something in it', () => {
    show({ recent: [release()] });

    expect(screen.getAllByRole('heading').map(h => h.textContent)).toEqual(['Releases', 'Recent', 'Release calendar']);
  });

  it('explains itself when there is nothing new, rather than disappearing', () => {
    show({});
    expect(screen.getByText(/Nothing new from your saved artists this month/)).toBeTruthy();
    // One box, not two empty subheadings explaining the same silence.
    expect(screen.getAllByRole('heading').map(h => h.textContent)).toEqual(['Releases', 'Release calendar']);
    // The calendar has to survive the empty state — a fan with nothing out this month is exactly
    // who wants to be told when something is.
    expect(screen.getByText('subscribe panel')).toBeTruthy();
  });

  it('says so when the read failed, instead of claiming there is nothing new', () => {
    show({}, "Couldn't load recent releases. Try refreshing.");
    expect(screen.getByText(/Couldn't load recent releases/)).toBeTruthy();
    expect(screen.queryByText(/Nothing new from your saved artists/)).toBeNull();
  });

  it('keeps the calendar at the foot of the section, with no toggle in the way', () => {
    show({ recent: [release()] });

    // It used to hide behind a reveal button, on the theory that a feed token is a credential.
    // ReleaseFeedControls already handles that — it asks for a token only when pressed — so the
    // panel renders outright and the section needs no button of its own.
    expect(screen.getByText('subscribe panel')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();

    const headings = screen.getAllByRole('heading').map(h => h.textContent);
    expect(headings[headings.length - 1]).toBe('Release calendar');
  });

  it('offers one calendar for the pair, not one per list', () => {
    show({ upcoming: [release({ releaseSlug: 'announced' })], recent: [release()] });
    // Both lists come out of the same feed token, so a second subscribe panel would be a second
    // treatment for one action.
    expect(screen.getAllByText('subscribe panel')).toHaveLength(1);
  });

  it('names the platforms for a screen reader, which the icons alone cannot', () => {
    show({
      recent: [
        release({
          sources: [{ platform: 'jamcoop', offers: [] }],
        }),
      ],
    });

    // The registry's name, not the raw id.
    expect(screen.getByText(/Available on Jam\.coop/)).toBeTruthy();
  });
});
