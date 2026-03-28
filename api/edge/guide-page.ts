import { Context } from "https://edge.netlify.com";

interface GuideMeta {
  slug: string;
  title: string;
  description: string;
  pillar: string;
  published: string;
}

export default async function handler(request: Request, context: Context) {
  try {
    const url = new URL(request.url);
    const pathMatch = url.pathname.match(/^\/guides\/([^/]+)\/?$/);

    if (!pathMatch) return context.next();

    const slug = pathMatch[1];
    const origin = url.origin;

    // Fetch the guides manifest to get metadata
    const manifestUrl = `${origin}/data/guides/guides-manifest.json`;
    const manifestRes = await fetch(manifestUrl);
    if (!manifestRes.ok) return context.next();

    const manifest: GuideMeta[] = await manifestRes.json();
    const guide = manifest.find(g => g.slug === slug);
    if (!guide) return context.next();

    // Get the original page response
    const response = await context.next();
    const html = await response.text();

    const pageUrl = `${origin}/guides/${slug}`;
    const ogTitle = `${guide.title} - Unstream`;

    // Replace default meta tags with guide-specific ones
    const updatedHtml = html
      .replace(
        /<title>[^<]*<\/title>/,
        `<title>${escapeHtml(ogTitle)}</title>`
      )
      .replace(
        /<meta name="description" content="[^"]*"/,
        `<meta name="description" content="${escapeHtml(guide.description)}"`
      )
      .replace(
        /<meta property="og:title" content="[^"]*"/,
        `<meta property="og:title" content="${escapeHtml(ogTitle)}"`
      )
      .replace(
        /<meta property="og:description" content="[^"]*"/,
        `<meta property="og:description" content="${escapeHtml(guide.description)}"`
      )
      .replace(
        /<meta property="og:type" content="[^"]*"/,
        `<meta property="og:type" content="article"`
      )
      .replace(
        /<\/head>/,
        `<meta property="og:url" content="${pageUrl}" />\n` +
        `<meta property="article:published_time" content="${guide.published}" />\n` +
        `<meta property="article:author" content="Brandon Lucas Green" />\n` +
        `<link rel="canonical" href="${pageUrl}" />\n` +
        `</head>`
      );

    return new Response(updatedHtml, {
      headers: {
        ...Object.fromEntries(response.headers.entries()),
        'Content-Type': 'text/html; charset=utf-8',
      },
    });
  } catch {
    return context.next();
  }
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
