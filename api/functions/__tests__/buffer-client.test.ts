// The Buffer transport: error surfacing, tag lookup/creation, and how each mutation's two-shaped
// response is mapped.
//
// The query shapes themselves were verified against the live API on 2026-10-27 (see the spec's
// Open questions) rather than asserted here — a stubbed fetch can only confirm our own model of
// Buffer, never Buffer. What these tests do cover is the mapping logic, which is ours.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  BufferError,
  addPostToContentItem,
  bufferGraphQL,
  bufferOrgId,
  createContentItem,
  createPost,
  ensureTag,
  listChannels,
} from '../buffer-client';

const fetchMock = vi.fn();

/** A Buffer 200 carrying a GraphQL data payload. */
const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  process.env.BUFFER_CURATOR_ACCESS_TOKEN = 'buffer-token';
  process.env.BUFFER_CURATOR_ORG_ID = 'org_1';
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.BUFFER_CURATOR_ACCESS_TOKEN;
  delete process.env.BUFFER_CURATOR_ORG_ID;
});

describe('bufferOrgId', () => {
  it('is null unless both the token and the organization are set', () => {
    expect(bufferOrgId()).toBe('org_1');

    delete process.env.BUFFER_CURATOR_ACCESS_TOKEN;
    expect(bufferOrgId()).toBeNull();

    process.env.BUFFER_CURATOR_ACCESS_TOKEN = 'buffer-token';
    delete process.env.BUFFER_CURATOR_ORG_ID;
    expect(bufferOrgId()).toBeNull();
  });
});

describe('bufferGraphQL', () => {
  it('sends the token and the query to Buffer', async () => {
    fetchMock.mockResolvedValue(ok({ hello: 'world' }));
    const data = await bufferGraphQL<{ hello: string }>('query { hello }', { a: 1 });

    expect(data).toEqual({ hello: 'world' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.buffer.com');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer buffer-token');
    expect(JSON.parse(init.body)).toEqual({ query: 'query { hello }', variables: { a: 1 } });
  });

  // The trap this whole wrapper exists for: Buffer reports a failed operation as HTTP 200 with
  // an `errors` array, so a caller checking only res.ok would read it as a success.
  it('throws on a 200 that carries GraphQL errors', async () => {
    fetchMock.mockResolvedValue(new Response(
      JSON.stringify({ errors: [{ message: 'Variable "$orgId" of type "ID!" used in position expecting type "OrganizationId!".' }] }),
      { status: 200 },
    ));
    await expect(bufferGraphQL('query { x }')).rejects.toMatchObject({
      name: 'BufferError',
      message: expect.stringContaining('OrganizationId!'),
    });
  });

  it('joins several GraphQL error messages', async () => {
    fetchMock.mockResolvedValue(new Response(
      JSON.stringify({ errors: [{ message: 'first' }, { message: 'second' }] }),
      { status: 200 },
    ));
    await expect(bufferGraphQL('query { x }')).rejects.toThrow('first; second');
  });

  it('throws on a non-2xx even when the body is not JSON', async () => {
    fetchMock.mockResolvedValue(new Response('<html>gateway</html>', { status: 502 }));
    await expect(bufferGraphQL('query { x }')).rejects.toMatchObject({ status: 502 });
  });

  it('treats a 200 with neither data nor errors as a failure', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
    await expect(bufferGraphQL('query { x }')).rejects.toBeInstanceOf(BufferError);
  });

  it('refuses to call Buffer with no token, without reaching the network', async () => {
    delete process.env.BUFFER_CURATOR_ACCESS_TOKEN;
    await expect(bufferGraphQL('query { x }')).rejects.toBeInstanceOf(BufferError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('listChannels', () => {
  it('asks for the organization as OrganizationId, not ID', async () => {
    fetchMock.mockResolvedValue(ok({ channels: [] }));
    await listChannels('org_1');

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    // Buffer refuses $orgId: ID! outright with a 400; the generator's older spelling is dead.
    expect(body.query).toContain('$orgId: OrganizationId!');
    expect(body.variables).toEqual({ orgId: 'org_1' });
  });

  it('returns an empty list rather than undefined when there are no channels', async () => {
    fetchMock.mockResolvedValue(ok({}));
    await expect(listChannels('org_1')).resolves.toEqual([]);
  });
});

describe('ensureTag', () => {
  const page = (edges: { id: string; name: string }[], hasNextPage = false, endCursor: string | null = null) =>
    ok({ tagsV2: { pageInfo: { hasNextPage, endCursor }, edges: edges.map(node => ({ node })) } });

  it('returns the id of an existing tag without creating one', async () => {
    fetchMock.mockResolvedValueOnce(page([{ id: 'tag_1', name: 'unstream: curator' }]));
    await expect(ensureTag('org_1', 'unstream: curator', '#FF702C')).resolves.toBe('tag_1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('pages through until it finds the tag', async () => {
    fetchMock
      .mockResolvedValueOnce(page([{ id: 'tag_a', name: 'something else' }], true, 'cursor_1'))
      .mockResolvedValueOnce(page([{ id: 'tag_b', name: 'unstream: curator' }]));

    await expect(ensureTag('org_1', 'unstream: curator', '#FF702C')).resolves.toBe('tag_b');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).variables.after).toBe('cursor_1');
  });

  // An exact match, so renaming the tag starts a new one rather than merging two populations
  // of analytics under one name.
  it('does not match a tag whose name merely contains the wanted one', async () => {
    fetchMock
      .mockResolvedValueOnce(page([{ id: 'tag_x', name: 'unstream: curator posts' }]))
      .mockResolvedValueOnce(ok({ createTag: { tag: { id: 'tag_new' } } }));

    await expect(ensureTag('org_1', 'unstream: curator', '#FF702C')).resolves.toBe('tag_new');
  });

  it('creates the tag when the organization has none by that name', async () => {
    fetchMock
      .mockResolvedValueOnce(page([]))
      .mockResolvedValueOnce(ok({ createTag: { tag: { id: 'tag_new' } } }));

    await expect(ensureTag('org_1', 'unstream: curator', '#FF702C')).resolves.toBe('tag_new');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).variables.input).toEqual({
      organizationId: 'org_1',
      tag: { name: 'unstream: curator', color: '#FF702C' },
    });
  });

  it('throws with Buffer’s reason when the tag cannot be created', async () => {
    fetchMock
      .mockResolvedValueOnce(page([]))
      .mockResolvedValueOnce(ok({ createTag: { message: 'Tag limit reached' } }));

    await expect(ensureTag('org_1', 'unstream: curator', '#FF702C')).rejects.toThrow('Tag limit reached');
  });
});

describe('createPost', () => {
  it('reports the created post against its channel', async () => {
    fetchMock.mockResolvedValue(ok({ createPost: { post: { id: 'post_1', status: 'draft' } } }));

    await expect(createPost({ channelId: 'chan_ig', text: 'hi' })).resolves.toEqual({
      created: [{ id: 'post_1', status: 'draft', channelId: 'chan_ig' }],
      errors: [],
    });
  });

  // createPost answers a rejected post with a MutationError inside a 200, not an HTTP error.
  it('turns a MutationError into an error against that channel, not a throw', async () => {
    fetchMock.mockResolvedValue(ok({ createPost: { message: 'Invalid user tag' } }));

    await expect(createPost({ channelId: 'chan_ig' })).resolves.toEqual({
      created: [],
      errors: [{ channelId: 'chan_ig', message: 'Invalid user tag' }],
    });
  });
});

describe('createContentItem', () => {
  it('returns the item id alongside the posts it created', async () => {
    fetchMock.mockResolvedValue(ok({
      createContentItem: {
        content: { id: 'item_1', body: { posts: [{ id: 'post_fb', status: 'draft', channelId: 'chan_fb' }] } },
      },
    }));

    await expect(createContentItem('org_1', 'Tonight', ['tag_1'], [{ channelId: 'chan_fb' }])).resolves.toEqual({
      created: [{ id: 'post_fb', status: 'draft', channelId: 'chan_fb' }],
      errors: [],
      contentItemId: 'item_1',
    });
  });

  it('surfaces per-variant errors on failure', async () => {
    fetchMock.mockResolvedValue(ok({
      createContentItem: { message: 'Could not create', errors: [{ channelId: 'chan_ig', message: 'Caption too long' }] },
    }));

    const result = await createContentItem('org_1', 'Tonight', ['tag_1'], []);
    expect(result.contentItemId).toBeUndefined();
    expect(result.errors).toEqual([{ channelId: 'chan_ig', message: 'Caption too long' }]);
  });

  it('falls back to the top-level message when no per-variant error is given', async () => {
    fetchMock.mockResolvedValue(ok({ createContentItem: { message: 'Could not create', errors: [] } }));

    const result = await createContentItem('org_1', 'Tonight', ['tag_1'], []);
    expect(result.errors).toEqual([{ message: 'Could not create' }]);
  });
});

describe('addPostToContentItem', () => {
  it('returns null when the post joins the item', async () => {
    fetchMock.mockResolvedValue(ok({ addPostToContentItem: { post: { id: 'post_ig' } } }));
    await expect(addPostToContentItem('item_1', 'post_ig')).resolves.toBeNull();
  });

  it('returns the message when Buffer refuses', async () => {
    fetchMock.mockResolvedValue(ok({ addPostToContentItem: { message: 'Item is full' } }));
    await expect(addPostToContentItem('item_1', 'post_ig')).resolves.toBe('Item is full');
  });

  // Only the grouping is at stake, so a network failure here must not reject and take down a
  // send whose posts already exist.
  it('swallows a thrown error into a message', async () => {
    fetchMock.mockRejectedValue(new Error('socket hang up'));
    await expect(addPostToContentItem('item_1', 'post_ig')).resolves.toBe('socket hang up');
  });
});
