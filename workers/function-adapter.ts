// Request <-> Lambda-event adapter.
//
// The 67 handlers in api/functions/ were written for Netlify Functions, which are AWS Lambdas:
// they take an `event` object and return `{ statusCode, headers, body }`. Workers speak
// `Request` and `Response`. This module is the only place that knows about both, so the handlers
// stay untouched through the move (see "Lift and shift first" in
// docs/specs/infrastructure-independence-plan.md).
//
// The rule throughout is **match Netlify exactly**, because any difference here is a behaviour
// change in 67 handlers at once with nothing to catch it:
//
// - `headers` keys are lowercased, as Lambda delivers them. Several handlers read both
//   `headers.Authorization` and `headers.authorization`; only the lowercase read has ever
//   fired in production, and that stays true here.
// - `queryStringParameters` is flat and last-value-wins for a repeated key, as Lambda is.
// - `path` and `rawUrl` carry the ORIGINAL request URL, not the rewritten function path.
//   collection-art, public-saved-artists, feed-releases and release-detail all read their
//   arguments back out of them.
// - `pathParameters` is left undefined. Netlify never populated it for these routes either
//   (netlify.toml's note on /api/release/:artist/:release records that the hard way), so the
//   handlers' `event.path` fallbacks are the live path and keep being the live path.

/** The subset of the Lambda event the handlers actually read. */
export interface FunctionEvent {
  httpMethod: string;
  headers: Record<string, string | undefined>;
  body: string | null;
  isBase64Encoded: boolean;
  queryStringParameters: Record<string, string | undefined>;
  path: string;
  rawUrl: string;
  pathParameters?: Record<string, string | undefined>;
}

/** What a handler returns. `headers` values are loose because Lambda allowed numbers and booleans. */
export interface FunctionResult {
  statusCode: number;
  headers?: Record<string, string | number | boolean | undefined>;
  body?: string | null;
  isBase64Encoded?: boolean;
}

/**
 * A few handlers have a path that falls off the end and resolves to `undefined` — a bug, but one
 * Netlify answered with a 500 rather than crashing. `toResponse` does the same, loudly.
 */
export type FunctionHandler = (event: FunctionEvent) => Promise<FunctionResult | undefined>;

/**
 * Content types whose bodies reach the handler as text rather than base64.
 *
 * Everything the site receives is textual — JSON bodies, Stripe's webhook payload, form posts —
 * so this is the common path. Anything else is base64-encoded with `isBase64Encoded: true`,
 * which is the shape tips-webhook.ts already handles when it reconstructs the bytes it has to
 * verify the signature over.
 */
function isTextualContentType(contentType: string | null): boolean {
  if (!contentType) return true;
  const type = contentType.split(';')[0].trim().toLowerCase();
  return (
    type.startsWith('text/') ||
    type === 'application/json' ||
    type === 'application/x-www-form-urlencoded' ||
    type === 'application/xml' ||
    type.endsWith('+json') ||
    type.endsWith('+xml')
  );
}

function base64FromBytes(bytes: Uint8Array): string {
  // btoa() takes a binary string. Chunked so a large body can't blow the argument limit.
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function bytesFromBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Build the Lambda-style event a handler expects from an incoming Worker request.
 *
 * `clientIp` is Cloudflare's `CF-Connecting-IP`, passed through under the header names
 * ratelimit.ts already knows. Losing it would collapse every visitor into one rate-limit
 * bucket, which is the kind of failure that looks like working software until the first
 * busy minute.
 */
export async function toFunctionEvent(request: Request): Promise<FunctionEvent> {
  const url = new URL(request.url);

  const headers: Record<string, string | undefined> = {};
  for (const [name, value] of request.headers) {
    headers[name.toLowerCase()] = value;
  }

  const clientIp = request.headers.get('cf-connecting-ip');
  if (clientIp) {
    // getClientIp() prefers these two; see the note there. Set so a handler reading them
    // behind Cloudflare gets the same answer it got behind Netlify.
    headers['x-nf-client-connection-ip'] = clientIp;
    headers['client-ip'] = clientIp;
  }

  const queryStringParameters: Record<string, string | undefined> = {};
  for (const [key, value] of url.searchParams) {
    queryStringParameters[key] = value;
  }

  let body: string | null = null;
  let isBase64Encoded = false;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    if (isTextualContentType(request.headers.get('content-type'))) {
      body = await request.text();
      // Lambda delivers no body as null, not ''. me-* handlers test `if (!event.body)`.
      if (body === '') body = null;
    } else {
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (bytes.length > 0) {
        body = base64FromBytes(bytes);
        isBase64Encoded = true;
      }
    }
  }

  return {
    httpMethod: request.method,
    headers,
    body,
    isBase64Encoded,
    queryStringParameters,
    path: url.pathname,
    rawUrl: request.url,
  };
}

/** Turn what a handler returned back into a Response. */
export function toResponse(result: FunctionResult | undefined): Response {
  if (!result) {
    // A handler that resolved to nothing returned down a path it shouldn't have. Netlify turned
    // that into a 500; so do we, with a line in the log, rather than throwing out of the Worker.
    console.error('[worker] handler resolved without a result');
    return new Response('Internal Server Error', { status: 500 });
  }

  const headers = new Headers();
  for (const [name, value] of Object.entries(result.headers ?? {})) {
    if (value === undefined) continue;
    headers.set(name, String(value));
  }

  // 204 and 304 must not carry a body; fetch() throws if one is attached.
  const statusCode = result.statusCode ?? 200;
  if (statusCode === 204 || statusCode === 304 || !result.body) {
    return new Response(null, { status: statusCode, headers });
  }

  const body = result.isBase64Encoded ? bytesFromBase64(result.body) : result.body;
  return new Response(body, { status: statusCode, headers });
}
