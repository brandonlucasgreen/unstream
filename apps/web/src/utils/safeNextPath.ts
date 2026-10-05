/**
 * Where /login sends someone after they sign in, from its `?next=` parameter: a path on this site,
 * or null. Anything that resolves to another origin is refused — `//evil.example`, `/\evil.example`
 * and `https://evil.example` all parse as other hosts — so the parameter can't be used to bounce a
 * freshly signed-in person somewhere else.
 */
export function safeNextPath(raw: string | null, origin: string): string | null {
  if (!raw || !raw.startsWith('/') || raw.length > 2000) return null;
  try {
    const url = new URL(raw, origin);
    if (url.origin !== origin) return null;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}
