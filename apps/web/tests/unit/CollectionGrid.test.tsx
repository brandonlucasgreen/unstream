// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { CollectionGrid } from '../../src/components/CollectionGrid';
import {
  COLLECTION_PAGE_SIZE,
  pageWindow,
  sortItems,
  type CollectionGridItem,
} from '../../src/utils/collection-grid';

function item(over: Partial<CollectionGridItem> & { key: string }): CollectionGridItem {
  return {
    title: 'A Title',
    artistName: 'An Artist',
    artUrl: null,
    acquiredAt: null,
    releaseUrl: null,
    artistUrl: null,
    ...over,
  };
}

function manyItems(n: number) {
  return Array.from({ length: n }, (_, i) =>
    item({ key: `k${i}`, title: `Album ${String(i).padStart(3, '0')}` })
  );
}

function renderGrid(items: CollectionGridItem[]) {
  return render(
    <MemoryRouter>
      <CollectionGrid items={items} />
    </MemoryRouter>
  );
}

describe('pageWindow', () => {
  it('lists every page when there are few', () => {
    expect(pageWindow(1, 5)).toEqual([1, 2, 3, 4, 5]);
  });

  it('always keeps the first and last page reachable', () => {
    const w = pageWindow(7, 13);
    expect(w[0]).toBe(1);
    expect(w[w.length - 1]).toBe(13);
    expect(w).toContain(7);
  });

  it('marks gaps with nulls rather than dropping them silently', () => {
    expect(pageWindow(7, 13)).toEqual([1, null, 5, 6, 7, 8, 9, null, 13]);
  });

  it('keeps a full run of pages reachable at either end', () => {
    expect(pageWindow(1, 13)).toEqual([1, 2, 3, 4, 5, null, 13]);
    expect(pageWindow(13, 13)).toEqual([1, null, 9, 10, 11, 12, 13]);
  });
});

describe('sortItems', () => {
  const unsorted = [
    item({ key: 'b', title: 'Bravo', artistName: 'Zed', acquiredAt: '2024-01-01T00:00:00Z' }),
    item({ key: 'a', title: 'alpha', artistName: 'Ada', acquiredAt: '2026-01-01T00:00:00Z' }),
    item({ key: 'c', title: 'Charlie', artistName: 'Moe', acquiredAt: null }),
  ];

  it('sorts by album name case-insensitively', () => {
    expect(sortItems(unsorted, 'album').map(i => i.key)).toEqual(['a', 'b', 'c']);
  });

  it('sorts by artist name', () => {
    expect(sortItems(unsorted, 'artist').map(i => i.key)).toEqual(['a', 'c', 'b']);
  });

  it('sorts newest acquisition first, with undated items last', () => {
    // An unknown date must not masquerade as the most recent purchase.
    expect(sortItems(unsorted, 'added').map(i => i.key)).toEqual(['a', 'b', 'c']);
  });

  it('does not mutate the input', () => {
    const input = [...unsorted];
    sortItems(input, 'album');
    expect(input.map(i => i.key)).toEqual(['b', 'a', 'c']);
  });
});

describe('CollectionGrid', () => {
  afterEach(cleanup);

  it('shows only one page of tiles and reports the full count', () => {
    renderGrid(manyItems(190));
    expect(screen.getByText('190 releases')).not.toBeNull();
    expect(screen.getByText('Album 000')).not.toBeNull();
    expect(screen.getByText(`Album ${String(COLLECTION_PAGE_SIZE - 1).padStart(3, '0')}`)).not.toBeNull();
    // The 16th item belongs to page 2.
    expect(screen.queryByText(`Album ${String(COLLECTION_PAGE_SIZE).padStart(3, '0')}`)).toBeNull();
  });

  it('jumps to a numbered page', () => {
    renderGrid(manyItems(190));
    fireEvent.click(screen.getByRole('button', { name: 'Page 3' }));
    // Page 3 starts at index 30.
    expect(screen.getByText('Album 030')).not.toBeNull();
    expect(screen.queryByText('Album 000')).toBeNull();
  });

  it('renders no pagination for a single page', () => {
    renderGrid(manyItems(5));
    expect(screen.queryByRole('navigation', { name: 'Collection pages' })).toBeNull();
  });

  it('returns to page 1 when the sort changes, so the view is never stranded', () => {
    renderGrid(manyItems(190));
    fireEvent.click(screen.getByRole('button', { name: 'Page 3' }));
    expect(screen.queryByText('Album 000')).toBeNull();

    fireEvent.change(screen.getByLabelText('Sort collection'), { target: { value: 'album' } });
    expect(screen.getByText('Album 000')).not.toBeNull();
  });

  it('links the release and the artist only when a page exists for them', () => {
    renderGrid([
      item({
        key: 'linked',
        title: 'Illinois',
        artistName: 'Sufjan Stevens',
        releaseUrl: '/a/sufjan-stevens/illinois',
        artistUrl: '/a/sufjan-stevens',
      }),
      item({ key: 'plain', title: 'Obscure Tape', artistName: 'Nobody We Know' }),
    ]);

    expect(screen.getByRole('link', { name: 'Illinois' }).getAttribute('href')).toBe('/a/sufjan-stevens/illinois');
    expect(screen.getByRole('link', { name: 'Sufjan Stevens' }).getAttribute('href')).toBe('/a/sufjan-stevens');
    // Unlinkable ones render as text, not as links to a 404.
    expect(screen.queryByRole('link', { name: 'Obscure Tape' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Nobody We Know' })).toBeNull();
    expect(screen.getByText('Obscure Tape')).not.toBeNull();
  });

  it('navigates to a release as a document, not through the client-side router', () => {
    // /a/{artist}/{release} is rendered by an edge function and has no route in main.tsx. A
    // <Link> there pushed the URL and rendered nothing — a blank page at the release's own URL,
    // and a Back button that needed a hard refresh afterwards. A router <Link> cancels the
    // click; a plain anchor lets the browser navigate, which is the whole fix.
    renderGrid([
      item({
        key: 'linked',
        title: 'Illinois',
        artistName: 'Sufjan Stevens',
        releaseUrl: '/a/sufjan-stevens/illinois',
        artistUrl: '/a/sufjan-stevens',
      }),
    ]);

    const release = screen.getByRole('link', { name: 'Illinois' });
    expect(fireEvent.click(release)).toBe(true);

    // The artist page is a real SPA route, so that one stays client-side.
    const artist = screen.getByRole('link', { name: 'Sufjan Stevens' });
    expect(fireEvent.click(artist)).toBe(false);
  });

  it('drops to the placeholder, keeping the caption, when cover art fails to load', () => {
    renderGrid([item({ key: 'a', title: 'Missing Art', artUrl: '/api/collection/art/a' })]);

    const img = screen.getByAltText('Missing Art by An Artist');
    // The art proxy 404s when Bandcamp has no cover — an expected outcome, not an error.
    fireEvent.error(img);
    expect(screen.queryByAltText('Missing Art by An Artist')).toBeNull();
    expect(screen.getByText('Missing Art')).not.toBeNull();
  });
});
