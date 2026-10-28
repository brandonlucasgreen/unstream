// Buffer's GraphQL API, for curator posts (docs/specs/curator-posts-spec.md).
//
// Plain fetch rather than a package, like api/functions/stripe.ts: every call is one POST to one
// fixed host, and going through fetch keeps it behind the SSRF allowlist (api.buffer.com is in
// ALLOWED_OUTBOUND_HOSTNAMES). Because the host is fixed and never comes from a request, a
// database row or scraped markup, safeFetch isn't needed.
//
// This is transport only. Captions, handles, tags and length rules belong to curator-posts.ts,
// so this file never has an opinion about what a post says.
//
// **Every call takes the access token explicitly.** Each curator posts from their own Buffer
// account, so there is no ambient "the" token to read from the environment — and a Lambda serves
// concurrent requests from one process, where anything ambient would leak between curators.
//
// Modelled on bufferGraphQL in scripts/generate-social-posts.ts, which talks to the same API for
// the weekly schedule. The two deliberately stay separate: the generator runs in GitHub Actions
// with its own BUFFER_ACCESS_TOKEN and the whole week in hand, while this runs in a Lambda, per
// request, under the curator feature's admin gate and its own token.

import { isUrlHostnameAllowed } from './middleware';

const BUFFER_API = 'https://api.buffer.com';

/** Buffer rejects a request that takes longer than this far more gracefully than Lambda does. */
const BUFFER_TIMEOUT_MS = 15_000;

export class BufferError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'BufferError';
    this.status = status;
  }
}

/**
 * One GraphQL round trip.
 *
 * Buffer answers 200 with an `errors` array as readily as it answers a 4xx, so both are raised
 * the same way — a caller that only checked res.ok would read a failed mutation as a success.
 */
export async function bufferGraphQL<T>(token: string, query: string, variables?: Record<string, unknown>): Promise<T> {
  if (!token) throw new BufferError(401, 'No Buffer access token');
  if (!isUrlHostnameAllowed(BUFFER_API)) throw new BufferError(500, 'Buffer host not allowed');

  const res = await fetch(BUFFER_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(BUFFER_TIMEOUT_MS),
  });

  const json = await res.json().catch(() => ({})) as {
    data?: T;
    errors?: { message: string }[];
  };

  if (!res.ok || json.errors?.length) {
    const detail = json.errors?.map(e => e.message).join('; ') || `Buffer ${res.status}`;
    throw new BufferError(res.status, detail);
  }
  if (!json.data) throw new BufferError(res.status, 'Buffer returned no data');
  return json.data;
}

// ---------------------------------------------------------------------------------------------
// Organizations
// ---------------------------------------------------------------------------------------------

export interface BufferOrganization {
  id: string;
  name: string;
}

/**
 * Every organization the account belongs to. One person can belong to several — their own, and
 * any they were invited to — and the first is not reliably theirs, so a curator with more than
 * one has to choose.
 */
export async function listOrganizations(token: string): Promise<BufferOrganization[]> {
  const data = await bufferGraphQL<{ account?: { organizations?: BufferOrganization[] } }>(
    token,
    'query { account { organizations { id name } } }',
  );
  return data.account?.organizations ?? [];
}

// ---------------------------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------------------------

export interface BufferChannel {
  id: string;
  name: string;
  service: string;
  /** "business", "page", "profile", … — an Instagram profile can't be posted to automatically. */
  type: string;
  /** The network's own id. Facebook Page mentions need this, not the Buffer id. */
  serviceId: string;
  isDisconnected: boolean;
}

/**
 * Every channel on the organization.
 *
 * The variable is `OrganizationId!`, not `ID!`. Buffer tightened this: the generator's older
 * `ID!` spelling is now refused outright with a 400, so don't "simplify" it back.
 */
export async function listChannels(token: string, orgId: string): Promise<BufferChannel[]> {
  const data = await bufferGraphQL<{ channels: BufferChannel[] }>(token, `
    query GetChannels($orgId: OrganizationId!) {
      channels(input: { organizationId: $orgId }) {
        id
        name
        service
        type
        serviceId
        isDisconnected
      }
    }
  `, { orgId });
  return data.channels ?? [];
}

// ---------------------------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------------------------

/**
 * The id of the organization's tag with this name, creating it if it doesn't exist.
 *
 * One tag, not the generator's whole set: curator posts have a single kind. The name is matched
 * exactly, so renaming it here starts a new tag rather than renaming the old one — which is what
 * we want, since Buffer's analytics are grouped by tag and a rename would merge two populations.
 */
export async function ensureTag(token: string, orgId: string, name: string, color: string): Promise<string> {
  let after: string | null = null;
  do {
    const data: { tagsV2: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      edges: { node: { id: string; name: string } }[];
    } } = await bufferGraphQL(token, `
      query Tags($organizationId: OrganizationId!, $after: String) {
        tagsV2(input: { organizationId: $organizationId }, first: 100, after: $after) {
          pageInfo { hasNextPage endCursor }
          edges { node { id name } }
        }
      }
    `, { organizationId: orgId, after });

    const page = data.tagsV2;
    for (const edge of page.edges) {
      if (edge.node.name === name) return edge.node.id;
    }
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);

  const created = await bufferGraphQL<{ createTag: { tag?: { id: string }; message?: string } }>(token, `
    mutation CreateTag($input: CreateTagInput!) {
      createTag(input: $input) {
        ... on TagActionSuccess { tag { id } }
        ... on MutationError { message }
      }
    }
  `, { input: { organizationId: orgId, tag: { name, color } } });

  const tag = created.createTag?.tag;
  if (!tag) throw new BufferError(502, `Couldn't create the Buffer tag "${name}": ${created.createTag?.message ?? 'unknown error'}`);
  return tag.id;
}

// ---------------------------------------------------------------------------------------------
// Posts
// ---------------------------------------------------------------------------------------------

export interface BufferCreatedPost {
  id: string;
  status: string;
  channelId: string;
}

export interface BufferWriteResult {
  created: BufferCreatedPost[];
  /** channelId is set when the failure belongs to one channel's variant. */
  errors: { channelId?: string; message: string }[];
  /** Set only when a content item was created. */
  contentItemId?: string;
}

/** One post on one channel. */
export async function createPost(token: string, input: Record<string, unknown>): Promise<BufferWriteResult> {
  const data = await bufferGraphQL<{ createPost: { post?: BufferCreatedPost; message?: string } }>(token, `
    mutation CreatePost($input: CreatePostInput!) {
      createPost(input: $input) {
        ... on PostActionSuccess { post { id status } }
        ... on MutationError { message }
      }
    }
  `, { input });

  const post = data.createPost?.post;
  const channelId = String(input.channelId);
  if (post) return { created: [{ ...post, channelId }], errors: [] };
  return { created: [], errors: [{ channelId, message: data.createPost?.message || 'Unknown error' }] };
}

/**
 * One subject across several channels, as a Buffer content item holding a post per channel.
 *
 * **Validation is all-or-nothing, and the failure payload can't tell you which side it failed
 * on**: the same shape comes back whether nothing was created or the variants failed after
 * creation. So never retry this blindly, and check anything that could be rejected — a handle,
 * a caption length — before calling it.
 */
export async function createContentItem(
  token: string,
  orgId: string,
  title: string,
  tagIds: string[],
  posts: Record<string, unknown>[],
): Promise<BufferWriteResult> {
  const data = await bufferGraphQL<{ createContentItem: {
    content?: { id: string; body?: { posts?: BufferCreatedPost[] } };
    message?: string;
    errors?: { channelId?: string; message: string }[];
  } }>(token, `
    mutation CreateContentItem($input: CreateContentItemInput!) {
      createContentItem(input: $input) {
        ... on CreateContentItemSuccess {
          content {
            id
            body { ... on PostContent { posts { id status channelId } } }
          }
        }
        ... on CreateContentItemFailure {
          message
          errors {
            ... on CreateContentItemVariantInvalidInputError { channelId message }
            ... on CreateContentItemVariantLimitReachedError { channelId message }
            ... on CreateContentItemVariantNotFoundError { channelId message }
            ... on InvalidInputError { message }
            ... on LimitReachedError { message }
            ... on NotFoundError { message }
          }
        }
      }
    }
  `, { input: { organizationId: orgId, title, tagIds, posts } });

  const result = data.createContentItem;
  const created = result?.content?.body?.posts ?? [];
  if (result?.content) return { created, errors: [], contentItemId: result.content.id };

  const errors = result?.errors ?? [];
  return { created, errors: errors.length ? errors : [{ message: result?.message || 'Unknown error' }] };
}

/**
 * Put an existing post into a content item, so Buffer shows the two networks together.
 *
 * Returns the error message, or null. Grouping is all that's at stake here — the post is already
 * created and tagged either way — so a caller should report this and carry on rather than treat
 * it as a failed send.
 */
export async function addPostToContentItem(token: string, contentItemId: string, postId: string): Promise<string | null> {
  try {
    const data = await bufferGraphQL<{ addPostToContentItem: { post?: { id: string }; message?: string } }>(token, `
      mutation AddPostToContentItem($input: AddPostToContentItemInput!) {
        addPostToContentItem(input: $input) {
          ... on AddPostToContentItemSuccess { post { id } }
          ... on VoidMutationError { message }
        }
      }
    `, { input: { id: contentItemId, postId } });
    return data.addPostToContentItem?.post ? null : (data.addPostToContentItem?.message || 'Unknown error');
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
