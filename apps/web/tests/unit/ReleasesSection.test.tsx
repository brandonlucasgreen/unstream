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
    sources: [],
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

  it('shows type, date, the cheapest price, and the payout estimate together', () => {
    show([
      release({
        sources: [
          {
            platform: 'bandcamp',
            offers: [
              { price: 25, currency: 'USD', availability: 'available' },
              { price: 7, currency: 'USD', availability: 'available' },
            ],
          },
        ],
      }),
    ]);
    expect(screen.getByText('Album · 1 June 2024 · from $7 · ≈$5.60–$5.95 to artist')).toBeTruthy();
  });

  // Quoting the price of a record nobody can buy is the one genuinely misleading number this
  // list could show.
  it('never quotes a sold-out format as the price', () => {
    show([
      release({
        sources: [
          {
            platform: 'bandcamp',
            offers: [
              { price: 7, currency: 'USD', availability: 'sold_out' },
              { price: 25, currency: 'USD', availability: 'available' },
            ],
          },
        ],
      }),
    ]);
    expect(screen.getByText(/from \$25/)).toBeTruthy();
    expect(screen.queryByText(/from \$7/)).toBeNull();
  });

  // Bandcamp reports name-your-price as 0, and "from $0" would tell a fan the record is free.
  it('reads a zero price as name-your-price', () => {
    show([
      release({
        sources: [{ platform: 'bandcamp', offers: [{ price: 0, currency: 'USD', availability: 'available' }] }],
      }),
    ]);
    expect(screen.getByText(/Name your price/)).toBeTruthy();
  });

  // Where a fan can actually go to get it — the thing this whole task exists to surface.
  it('shows which platforms the release is available on', () => {
    show([
      release({
        sources: [
          { platform: 'bandcamp', offers: [] },
          { platform: 'discogs', offers: [] },
        ],
      }),
    ]);
    expect(screen.getByText('Available on Bandcamp, Discogs')).toBeTruthy();
  });

  // The whole reason this isn't just "cheapest price across every source": once Discogs (no
  // payout figure, secondhand) is a second source, picking the absolute cheapest could rank a
  // used copy above the artist's own store — see leadingOfferSummary's own doc.
  it('prefers the artist-paying source even when a lower-payout source is cheaper', () => {
    show([
      release({
        sources: [
          { platform: 'discogs', offers: [{ price: 3, currency: 'USD', availability: 'available' }] },
          { platform: 'bandcamp', offers: [{ price: 25, currency: 'USD', availability: 'available' }] },
        ],
      }),
    ]);
    expect(screen.getByText(/from \$25/)).toBeTruthy();
    expect(screen.queryByText(/from \$3/)).toBeNull();
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

describe('release type label', () => {
  afterEach(cleanup);

  it('shows Digital for a Mirlo release whose kind Mirlo never told us', () => {
    // Mirlo leaves `type` null on the overwhelming majority of releases (204 of 209 measured
    // live), so 'other' is the normal outcome and this row would otherwise carry no type at all.
    show([
      release({
        releaseType: 'other',
        sources: [{ platform: 'mirlo', offers: [{ price: 4, currency: 'USD', availability: 'available' }] }],
      }),
    ]);

    expect(screen.getByText(/Digital/)).toBeTruthy();
  });

  it('does not claim Digital when the release is also on a platform that sells physical', () => {
    // Bandcamp presses vinyl. "Digital" on a row that links to a vinyl listing is a wrong claim
    // about a physical product, so one non-digital platform drops the label entirely.
    show([
      release({
        releaseType: 'other',
        sources: [
          { platform: 'mirlo', offers: [{ price: 4, currency: 'USD', availability: 'available' }] },
          { platform: 'bandcamp', offers: [{ price: 25, currency: 'USD', availability: 'available' }] },
        ],
      }),
    ]);

    expect(screen.queryByText(/Digital/)).toBeNull();
  });

  it('never renders the word "Other" to a fan', () => {
    show([release({ releaseType: 'other', sources: [] })]);
    expect(screen.queryByText(/\bOther\b/)).toBeNull();
  });

  it('still prefers a real upstream type over the digital fallback', () => {
    show([
      release({
        releaseType: 'ep',
        sources: [{ platform: 'mirlo', offers: [] }],
      }),
    ]);
    expect(screen.getByText(/Ep/)).toBeTruthy();
    expect(screen.queryByText(/Digital/)).toBeNull();
  });
});
