// The share card for /tip/{slug}: "Leave {artist} a tip on Unstream" (UNC ticket UNS-225) and the
// artist photo, served to social crawlers by api/edge/tip-page-meta.ts the same way static-page-meta
// serves /press. Nothing here is trusted input — the name, slug and image URL all come from the
// database — so the builder does its own escaping and every value that reaches an attribute goes
// through escapeHtml first.
//
// Kept as a pure module (no Deno globals, no remote imports) so the test in
// api/functions/__tests__/tip-page-meta.test.ts can import it directly under Vitest, which cannot
// load the edge handler itself while it imports https://edge.netlify.com.

/** The share text the ticket asks for: "Leave [artist name] a tip on Unstream". */
export function tipShareTitle(artistName: string): string {
  return `Leave ${artistName} a tip on Unstream`;
}

/** og:description — the same line the /tip/ page renders under its heading (tipPage.straightTo). */
export function tipShareDescription(artistName: string): string {
  return `Support for their music, paid straight to ${artistName}'s own Stripe account.`;
}

// Same set as the escaping in every other edge renderer (they cannot share one copy because the
// edge runs on Deno and the SPA build on Node — this lives in api/shared/, which both can import).
function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export interface TipPageMetaInput {
  /** The artist's URL slug, already validated by the caller. */
  slug: string;
  /** Raw artist name from the database (untrusted here — escaped before it reaches any attribute). */
  artistName: string;
  /** Raw photo URL, or '' / null when the artist has none (card renders without an image). */
  imageUrl: string | null;
}

/**
 * The whole OG-only document a social crawler gets for /tip/{slug}: the tip share text as title,
 * the page's own support line as description, and the artist photo when there is one — the same
 * card shape as static-page-meta.ts, plus the image tags artist-page-static.ts sets.
 */
export function buildTipPageMetaHtml({ slug, artistName, imageUrl }: TipPageMetaInput): string {
  const title = escapeHtml(tipShareTitle(artistName));
  const description = escapeHtml(tipShareDescription(artistName));
  const pageUrl = escapeHtml(`https://unstream.stream/tip/${encodeURIComponent(slug)}`);
  const image = imageUrl ? escapeHtml(imageUrl) : '';
  const alt = escapeHtml(`Photo of ${artistName}`);

  const imageMetaTags = image ? `
  <meta property="og:image" content="${image}">
  <meta property="og:image:alt" content="${alt}">
  <meta name="twitter:image" content="${image}">` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <meta name="description" content="${description}">
  <link rel="canonical" href="${pageUrl}">

  <!-- Open Graph / Facebook -->
  <meta property="og:type" content="website">
  <meta property="og:url" content="${pageUrl}">
  <meta property="og:title" content="${title}">
  <meta property="og:description" content="${description}">
  <meta property="og:site_name" content="Unstream">${imageMetaTags}

  <!-- Twitter -->
  <meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}">
  <meta name="twitter:url" content="${pageUrl}">
  <meta name="twitter:title" content="${title}">
  <meta name="twitter:description" content="${description}">
</head>
<body>
  <a href="${pageUrl}">${title}</a>
  <p>${description}</p>
</body>
</html>`;
}

/**
 * The slug shape checkout accepts (tips-checkout.ts SLUG_REGEX, without its case range because
 * this lookup lowercases first).
 */
export function isTipSlug(s: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/.test(s);
}

/**
 * /tip paths that are SPA routes, not artist slugs — /tip/thanks is where Stripe's cancel link
 * and the signed-out "save this tip" flow land. Its shape happens to look like a slug, but an
 * artist named "thanks" would render beside the payment-return page at a colliding address, so
 * it (and any future /tip/<route>) gets no card and no database read.
 */
export const TIP_RESERVED_SLUGS: ReadonlySet<string> = new Set(['thanks']);