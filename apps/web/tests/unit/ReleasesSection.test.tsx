// @vitest-environment jsdom
// The releases list on an artist page.
//
// This section shipped once already into the wrong renderer — it went into the
// artist-page-static edge function, which PR #369 had made crawler-only, so Googlebot saw an
// artist's discography with prices and no human ever did. These tests exercise the component
// real browsers actually render.
//
// What's worth locking is the set of things that would be quietly wrong rather than broken: a
// fabricated date on a year-only release, a price quoted from a sold-out format, and a heading
// with nothing under it.
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { ReleasesSection } from 'src/components/ReleasesSection';
import type { ArtistPagePayload } from 'src/types/artist-page';

type Release = NonNullable<ArtistPagePayload['releases']>[number];

function release(overrides: Partial<Release> = {}): Release {
  return {
    slug: 'a-record',
    title: 'A Record',
    releaseType: 'album',
    releaseDate: '2024-06-01',
    datePrecision: 'day',
    status: 'released',
    artworkUrl: null,
    offers: [],
    ...overrides,
  };
}

// Rendered with **no Router on purpose**. A react-router <Link> throws without one, so this
// harness is what keeps the rows real anchors: `/a/{artist}/{release}` is served only by the
// release-page edge function, and a client-side navigation there matches no SPA route, renders
// a blank page and strands the Back button.
function show(releases: Release[], total = releases.length) {
  return render(
    <ReleasesSection releases={releases} total={total} artistSlug="kid-lightbulbs" />
  );
}

afterEach(cleanup);

describe('ReleasesSection', () => {
  it('links each release to its buying guide', () => {
    show([release({ slug: 'ruined-castle', title: 'RUINED CASTLE' })]);
    expect(screen.getByRole('link', { name: /RUINED CASTLE/ }).getAttribute('href')).toBe(
      '/a/kid-lightbulbs/ruined-castle'
    );
  });

  // The regression this file exists to prevent, spelled out: a <Link> here produced a blank
  // page on click and a dead Back button, because that URL has no SPA route. Rendering without
  // a Router is the assertion — <Link> cannot mount outside one.
  it('navigates for real rather than client-side routing to a URL the SPA cannot render', () => {
    expect(() => show([release()])).not.toThrow();
  });

  // An empty "Releases" heading reads as broken; its absence reads as "nothing here yet", which
  // is the truth for any artist nobody has saved or searched.
  it('renders nothing at all when there are no releases', () => {
    const { container } = show([]);
    expect(container.innerHTML).toBe('');
  });

  it('shows type, date and the cheapest price together', () => {
    show([
      release({
        offers: [
          { price: 25, currency: 'USD', availability: 'available' },
          { price: 7, currency: 'USD', availability: 'available' },
        ],
      }),
    ]);
    expect(screen.getByText('Album · 1 June 2024 · from $7')).toBeTruthy();
  });

  // Quoting the price of a record nobody can buy is the one genuinely misleading number this
  // list could show.
  it('never quotes a sold-out format as the price', () => {
    show([
      release({
        offers: [
          { price: 7, currency: 'USD', availability: 'sold_out' },
          { price: 25, currency: 'USD', availability: 'available' },
        ],
      }),
    ]);
    expect(screen.getByText(/from \$25/)).toBeTruthy();
    expect(screen.queryByText(/from \$7/)).toBeNull();
  });

  // Bandcamp reports name-your-price as 0, and "from $0" would tell a fan the record is free.
  it('reads a zero price as name-your-price', () => {
    show([release({ offers: [{ price: 0, currency: 'USD', availability: 'available' }] })]);
    expect(screen.getByText(/Name your price/)).toBeTruthy();
  });

  // Grid ingest stores year-only and undated releases; rendering "1 January" would state a fact
  // no source ever gave us.
  it('does not invent a date it was not given', () => {
    show([
      release({ title: 'Year Only', releaseDate: '2024-01-01', datePrecision: 'year' }),
      release({ slug: 'undated', title: 'Undated', releaseDate: null, datePrecision: 'unknown' }),
    ]);
    expect(screen.getByText('Album · 2024')).toBeTruthy();
    expect(screen.getAllByText('Album').length).toBe(1);
    expect(screen.queryByText(/January/)).toBeNull();
  });

  it('flags an upcoming release', () => {
    show([release({ status: 'announced' })]);
    expect(screen.getByText('Coming')).toBeTruthy();
  });

  it('says how many releases are not shown', () => {
    show([release()], 9);
    expect(screen.getByText('and 8 more')).toBeTruthy();
  });

  it('says nothing about a count when everything is shown', () => {
    show([release()], 1);
    expect(screen.queryByText(/more$/)).toBeNull();
  });
});
