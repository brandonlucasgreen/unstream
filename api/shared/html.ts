// The one HTML-escaping function for everything that builds markup on the server: the edge
// renderers (Deno), the functions' email bodies and the shared page fragments (Node). It lives in
// api/shared/ because that is the only directory both runtimes can import from.
//
// Each edge function used to carry its own copy, and the test checked a pasted one, so an edit to
// any of them could have changed what was escaped without a test noticing. Don't add another:
// import this, and `xss-defense.test.ts` covers it.

/** Escapes the five characters that can end a text node or an attribute value. */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
