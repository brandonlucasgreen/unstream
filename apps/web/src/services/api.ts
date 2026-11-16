// The one way the web app calls its own API as the signed-in user.
//
// It adds the bearer token, sends a body as JSON, reads the reply as JSON without throwing on an
// empty or non-JSON one, and turns any non-2xx answer into an ApiError that carries the status and
// the parsed body. What the person sees is still each call site's decision: the error's message is
// the server's own `error` when it sent one, else the `failureMessage` the caller passed.
//
// Deliberately not here: caching, retries, de-duplication. Callers that avoid a request on mount
// (YourTips, the artist menu) do that themselves.

export class ApiError extends Error {
  readonly status: number;
  /** The reply's parsed JSON, `{}` when it had none: for call sites that branch on one of its fields. */
  readonly body: Record<string, unknown>;
  constructor(message: string, status: number, body: Record<string, unknown>) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

export interface ApiRequestOptions {
  /** Defaults to GET. */
  method?: string;
  /** Sent as JSON. */
  body?: unknown;
  /**
   * What the thrown error says when the server's reply has no `error` of its own. A function gets
   * the status, for wording like `Failed to save (500)`. Defaults to `HTTP <status>`.
   */
  failureMessage?: string | ((status: number) => string);
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

export async function apiRequest<T>(
  token: string | null | undefined,
  path: string,
  options: ApiRequestOptions = {},
): Promise<T> {
  // The token only ever goes to this site.
  if (!path.startsWith('/') || path.startsWith('//')) {
    throw new Error(`apiRequest takes a path on this site, not "${path}"`);
  }
  // Without a token the request would go out as the literal "Bearer undefined". Don't send it:
  // answer as the server would have.
  if (!token) {
    throw new ApiError('Unauthorized', 401, { error: 'Unauthorized' });
  }

  const init: RequestInit = { headers: { Authorization: `Bearer ${token}` } };
  if (options.method) init.method = options.method;
  if (options.body !== undefined) {
    init.headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
    init.body = JSON.stringify(options.body);
  }

  const response = await fetch(path, init);
  const parsed = await readJson(response);

  if (!response.ok) {
    const body = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
    const { failureMessage } = options;
    const fallback = typeof failureMessage === 'function'
      ? failureMessage(response.status)
      : failureMessage ?? `HTTP ${response.status}`;
    const message = typeof body.error === 'string' && body.error ? body.error : fallback;
    throw new ApiError(message, response.status, body);
  }

  return parsed as T;
}
