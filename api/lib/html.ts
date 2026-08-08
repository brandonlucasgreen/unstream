// Shared HTML-escaping helper for Netlify functions that build HTML server-side (currently
// transactional email bodies). Edge functions (api/edge/) run on Deno and can't import this —
// they keep their own copy in sync instead. See CLAUDE.md's XSS defense note.

export function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
