// @vitest-environment jsdom
// The duplicate-artist review queue on /admin/verify.
//
// What's worth locking is a workflow property rather than any single render: **an action must not
// re-fetch the listing.** Brandon, reviewing the first version: "when I 'fix slug' in the current
// /admin/verify UI, it drives a full page reload - I lose my place and the full list of issues to
// review takes seconds to reload."
//
// Both halves of that were real. `load()` set the flag that gates the whole section, so the list
// unmounted and came back; and the GET behind it pages ~20,000 rows across six tables. So every
// action now patches local state, and the tests below fail if any of them goes back to re-fetching.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { AdminDuplicateArtists } from 'src/components/AdminDuplicateArtists';

const session = { access_token: 'admin-token' } as never;

function row(over: Record<string, unknown> = {}) {
  return {
    id: 'id-1', slug: 'slug-1', name: 'Name One', matchConfidence: 'unverified',
    linkCount: 3, releaseCount: 0, hasProfile: false, ...over,
  };
}

function pair(over: Record<string, unknown> = {}) {
  return {
    key: 'somekey',
    winner: row({ id: 'w', slug: 'tigercub', name: 'Tigercub' }),
    loser: row({ id: 'l', slug: 'tiger-cub', name: 'Tiger Cub', linkCount: 1 }),
    evidence: 'name-only',
    sharedTitles: [],
    blockers: [],
    dismissed: false,
    dismissal: null,
    ...over,
  };
}

const LISTING = {
  pairs: [pair()],
  reslugCandidates: [{ id: 'a1', name: 'Björk', from: 'bj-rk', to: 'bjork' }],
  reslugSkippedChosen: 24,
};

/** Every GET the component makes, so a re-fetch after an action is visible. */
let gets: number;
let posts: Record<string, unknown>[];
let postReply: Record<string, unknown>;

beforeEach(() => {
  gets = 0;
  posts = [];
  postReply = { ok: true };
  global.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
    if (!init || init.method !== 'POST') {
      gets++;
      return { ok: true, json: async () => LISTING } as Response;
    }
    posts.push(JSON.parse(init.body as string));
    return { ok: true, json: async () => postReply } as Response;
  }) as unknown as typeof fetch;
});

afterEach(() => cleanup());

/** Render and wait for the one initial fetch to settle. */
async function mounted() {
  render(<AdminDuplicateArtists session={session} />);
  await waitFor(() => expect(screen.getByText(/Slugs to fix/)).toBeTruthy());
  expect(gets).toBe(1);
}

describe('AdminDuplicateArtists — an action never re-fetches the listing', () => {
  it('fixes a slug without re-reading the list', async () => {
    await mounted();

    fireEvent.click(screen.getByRole('button', { name: 'Fix slug' }));
    await waitFor(() => expect(posts).toHaveLength(1));

    expect(posts[0]).toMatchObject({ action: 'reslug', artistId: 'a1', dryRun: false });
    // The whole point: no second GET. A re-fetch here is what cost the reviewer their place.
    expect(gets).toBe(1);
    // The row it acted on is gone, from local state alone.
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Fix slug' })).toBeNull());
  });

  it('keeps the rest of the queue mounted through an action', async () => {
    await mounted();

    fireEvent.click(screen.getByRole('button', { name: 'Fix slug' }));
    await waitFor(() => expect(posts).toHaveLength(1));

    // The section must never fall back to its first-load placeholder — that unmount is what threw
    // away the scroll position.
    expect(screen.queryByText(/Loading duplicate artists/)).toBeNull();
    expect(screen.getByText(/Duplicate artist rows/)).toBeTruthy();
    expect(screen.getByText('Tigercub')).toBeTruthy();
  });

  it('dismisses a pair in place, showing what the server recorded', async () => {
    postReply = {
      ok: true,
      dismissal: { note: 'two bands, Brighton vs Leeds', dismissedBy: 'admin@example.test', at: '2026-08-03T15:00:00Z' },
    };
    await mounted();

    fireEvent.click(screen.getByRole('button', { name: 'Not duplicates' }));
    await waitFor(() => expect(screen.getByText(/Marked as different artists/)).toBeTruthy());

    expect(gets).toBe(1);
    // The note and author come from the response, not a local guess, so the row is accurate without
    // a re-read.
    expect(screen.getByText(/two bands, Brighton vs Leeds/)).toBeTruthy();
    expect(screen.getByText(/admin@example\.test/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Not duplicates' })).toBeNull();
  });

  it('restores a dismissed pair in place', async () => {
    await mounted();
    fireEvent.click(screen.getByRole('button', { name: 'Not duplicates' }));
    await waitFor(() => expect(screen.getByText(/Marked as different artists/)).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Put back in the queue' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Not duplicates' })).toBeTruthy());

    expect(posts.map(p => p.action)).toEqual(['dismiss', 'restore']);
    expect(gets).toBe(1);
  });

  it('removes a merged pair without re-fetching', async () => {
    postReply = { ok: true, dryRun: true, steps: [{ table: 'artist_links', action: 'reassign', count: 1 }] };
    await mounted();

    fireEvent.click(screen.getByRole('button', { name: 'Preview merge' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Merge anyway' })).toBeTruthy());

    postReply = { ok: true, dryRun: false, steps: [] };
    fireEvent.click(screen.getByRole('button', { name: 'Merge anyway' }));

    await waitFor(() => expect(screen.queryByText('Tigercub')).toBeNull());
    expect(gets).toBe(1);
    // Review pairs merge with force — they have no automatic evidence, so the admin is the evidence.
    expect(posts.at(-1)).toMatchObject({ action: 'merge', dryRun: false, force: true });
  });

  it('re-fetches only when the reviewer asks', async () => {
    await mounted();

    fireEvent.click(screen.getByRole('button', { name: 'Refresh list' }));

    await waitFor(() => expect(gets).toBe(2));
    expect(screen.queryByText(/Loading duplicate artists/)).toBeNull();
  });

  it('keeps the list on screen WHILE a refresh is in flight', async () => {
    // The assertion above only sees the settled state, so it would miss a placeholder that flashes
    // during the request — which is exactly the unmount Brandon reported. Holding the response open
    // is the only way to observe it.
    await mounted();

    let release: () => void = () => {};
    const held = new Promise<void>(resolve => { release = resolve; });
    global.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      if (!init || init.method !== 'POST') {
        gets++;
        await held;
        return { ok: true, json: async () => LISTING } as Response;
      }
      posts.push(JSON.parse(init.body as string));
      return { ok: true, json: async () => postReply } as Response;
    }) as unknown as typeof fetch;

    fireEvent.click(screen.getByRole('button', { name: 'Refresh list' }));
    await waitFor(() => expect(screen.getByText(/Refreshing/)).toBeTruthy());

    // Mid-flight: the queue is still there and the first-load placeholder is not.
    expect(screen.queryByText(/Loading duplicate artists/)).toBeNull();
    expect(screen.getByText('Tigercub')).toBeTruthy();
    expect(screen.getByText(/Duplicate artist rows/)).toBeTruthy();

    release();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh list' })).toBeTruthy());
  });
});
