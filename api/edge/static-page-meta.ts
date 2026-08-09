import { Context } from "https://edge.netlify.com";
import { isSocialCrawler, isIndexingCrawler } from "../shared/crawler-detection.ts";

// Link-preview metadata for the hand-written static pages — currently /press and /contact.
//
// These pages set document.title and the description in a useEffect, which is invisible to anything
// that doesn't run JS. Without this, every unfurl of unstream.stream/press showed the homepage's
// title and description instead: "Unstream - Find the best places online to directly support the
// music artists you love." That is the wrong card for the one URL that goes in every press pitch,
// and the crawler list this shares with the other edge functions is exactly the set of places those
// links get pasted — Mastodon, Slack, Discord, Bluesky, iMessage.
//
// Same contract as og-metadata.ts: social crawlers get a small OG-only document, indexing crawlers
// and real browsers fall through to the SPA so the page they see is the page everyone else sees.

interface PageMeta {
  title: string;
  description: string;
}

const PAGES: Record<string, PageMeta> = {
  "/press": {
    title: "Press kit — Unstream",
    description:
      "Boilerplate, facts, screenshots, and logos for Unstream — a free, open-source tool that shows music fans where to buy directly from artists, and how much of their money reaches them.",
  },
  "/contact": {
    title: "Contact — Unstream",
    description:
      "Get in touch with Unstream. Ask a question, report a missing artist, suggest a feature, or subscribe to the newsletter.",
  },
};

const OG_IMAGE = "https://unstream.stream/og-image.png";

// The values are ours, not user input, but these strings land inside HTML attributes — escaping is
// the cheap way to keep that true if someone later adds a page title with an apostrophe in it.
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function generateOgHtml(canonicalPath: string, meta: PageMeta): string {
  const title = escapeHtml(meta.title);
  const description = escapeHtml(meta.description);
  const url = `https://unstream.stream${canonicalPath}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <meta name="description" content="${description}">
  <link rel="canonical" href="${url}">

  <!-- Open Graph / Facebook -->
  <meta property="og:type" content="website">
  <meta property="og:url" content="${url}">
  <meta property="og:title" content="${title}">
  <meta property="og:description" content="${description}">
  <meta property="og:image" content="${OG_IMAGE}">
  <meta property="og:site_name" content="Unstream">

  <!-- Twitter -->
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:url" content="${url}">
  <meta name="twitter:title" content="${title}">
  <meta name="twitter:description" content="${description}">
  <meta name="twitter:image" content="${OG_IMAGE}">
</head>
<body>
  <p>${description}</p>
  <p><a href="${url}">${title}</a></p>
</body>
</html>`;
}

export default async function handler(request: Request, context: Context) {
  const url = new URL(request.url);
  // Trailing slashes reach here as a distinct path; treat /press/ and /press as the same page.
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const meta = PAGES[path];

  if (!meta) return context.next();

  const userAgent = request.headers.get("user-agent");

  // Indexing crawlers need the real page, not a stub — same reasoning as og-metadata.ts, where
  // serving them a shell caused Google to report redirect errors.
  if (isIndexingCrawler(userAgent)) return context.next();

  if (isSocialCrawler(userAgent)) {
    return new Response(generateOgHtml(path, meta), {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "public, max-age=3600",
      },
    });
  }

  return context.next();
}

export const config = {
  path: ["/press", "/contact"],
};
