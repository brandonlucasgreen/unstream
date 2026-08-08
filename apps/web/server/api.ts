import type { IncomingMessage, ServerResponse } from 'http';
import { resolveStreamingUrl } from './resolve-streaming-url';
import { getBandcampEmbed } from './search/bandcamp';
import { searchAllPlatforms } from './search';
import { searchMusicBrainzEnrichment } from './search/musicbrainz';

function sendJson(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}');
  } catch {
    return {};
  }
}

export async function handleApiRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url || '', `http://${req.headers.host}`);

  if (!url.pathname.startsWith('/api/')) {
    return false;
  }

  if (url.pathname === '/api/search/sources') {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return true;
    }

    const query = url.searchParams.get('query');

    if (!query) {
      sendJson(res, 400, { error: 'Query parameter is required' });
      return true;
    }

    try {
      const results = await searchAllPlatforms(query);
      // Always pending: the dev search never applies MB enrichment server-side,
      // and the client's Phase 2 (including its zero-result fallback card) should
      // behave in dev the way it does in production.
      sendJson(res, 200, { query, results, hasPendingEnrichment: true });
    } catch (error) {
      console.error('Search error:', error);
      sendJson(res, 500, { error: 'Failed to search', query, results: [] });
    }
    return true;
  }

  if (url.pathname === '/api/suggest') {
    // Dev-only stub. Production suggestions come from the Supabase artists
    // table (api/functions/search-suggest.ts), which the dev server doesn't
    // talk to — an empty list keeps the typeahead silently inert in dev.
    const query = url.searchParams.get('query') || '';
    sendJson(res, 200, { query, suggestions: [] });
    return true;
  }

  if (url.pathname === '/api/search/musicbrainz') {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return true;
    }

    const query = url.searchParams.get('query');

    if (!query) {
      sendJson(res, 400, { error: 'Query parameter is required' });
      return true;
    }

    try {
      const result = await searchMusicBrainzEnrichment(query);
      sendJson(res, 200, result);
    } catch (error) {
      console.error('MusicBrainz enrichment error:', error);
      sendJson(res, 500, {
        query,
        artistName: null,
        officialUrl: null,
        discogsUrl: null,
        hasPre2005Release: false,
        socialLinks: [],
      });
    }
    return true;
  }

  if (url.pathname === '/api/embed/bandcamp') {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return true;
    }

    const artistUrl = url.searchParams.get('url');

    if (!artistUrl) {
      sendJson(res, 400, { error: 'URL parameter is required' });
      return true;
    }

    try {
      const embedData = await getBandcampEmbed(artistUrl);
      if (embedData) {
        sendJson(res, 200, embedData);
      } else {
        sendJson(res, 404, { error: 'Could not find embeddable content' });
      }
    } catch (error) {
      console.error('Embed error:', error);
      sendJson(res, 500, { error: 'Failed to fetch embed data' });
    }
    return true;
  }

  if (url.pathname === '/api/newsletter/subscribe') {
    // Dev-only stub. Production runs api/functions/newsletter-subscribe.ts, which posts to
    // Buttondown. A dev server that really subscribed people would put test addresses on the
    // live list every time somebody clicked the button while styling the form — so this
    // mirrors the response shapes and writes to the console instead.
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return true;
    }

    const body = await readJsonBody(req);
    const email = typeof body.email === 'string' ? body.email.trim() : '';

    if (!email || !/^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(email)) {
      sendJson(res, 400, { error: "That doesn't look like an email address." });
      return true;
    }

    console.log(`[dev] newsletter signup (not sent to Buttondown): ${email} via ${body.source}`);
    sendJson(res, 200, { status: 'pending' });
    return true;
  }

  if (url.pathname === '/api/resolve/url') {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return true;
    }

    const streamingUrl = url.searchParams.get('url');

    if (!streamingUrl) {
      sendJson(res, 400, { error: 'URL parameter is required' });
      return true;
    }

    try {
      const result = await resolveStreamingUrl(streamingUrl);
      if (result) {
        sendJson(res, 200, result);
      } else {
        sendJson(res, 404, { error: 'Could not resolve artist from URL' });
      }
    } catch (error) {
      console.error('Resolve error:', error);
      sendJson(res, 500, { error: 'Failed to resolve URL' });
    }
    return true;
  }

  sendJson(res, 404, { error: 'Not found' });
  return true;
}
