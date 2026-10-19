import { describe, it, expect } from 'vitest';

import { toFunctionEvent, toResponse } from '../function-adapter.ts';

/**
 * The adapter is the one place that knows about both a Worker's Request and the Lambda-style
 * event the 67 handlers take, so any difference here is a behaviour change in all of them at
 * once, with nothing downstream to catch it. These pin the shape Netlify delivered.
 */
describe('toFunctionEvent', () => {
  it('lowercases header names, as Lambda delivered them', async () => {
    const event = await toFunctionEvent(
      new Request('https://unstream.stream/api/me/tips', { headers: { Authorization: 'Bearer t', 'X-API-Key': 'k' } }),
    );

    expect(event.headers.authorization).toBe('Bearer t');
    expect(event.headers['x-api-key']).toBe('k');
  });

  it('passes Cloudflare’s client IP under the names getClientIp reads', async () => {
    const event = await toFunctionEvent(
      new Request('https://unstream.stream/api/search/sources', { headers: { 'CF-Connecting-IP': '203.0.113.7' } }),
    );

    expect(event.headers['cf-connecting-ip']).toBe('203.0.113.7');
    expect(event.headers['x-nf-client-connection-ip']).toBe('203.0.113.7');
    expect(event.headers['client-ip']).toBe('203.0.113.7');
  });

  it('flattens the query string, last value winning for a repeated key', async () => {
    const event = await toFunctionEvent(new Request('https://unstream.stream/api/search/sources?q=mono&q=boris&limit=5'));

    expect(event.queryStringParameters).toEqual({ q: 'boris', limit: '5' });
  });

  it('carries the original path and URL, not a rewritten function path', async () => {
    // collection-art, public-saved-artists, feed-releases and release-detail all read their
    // arguments back out of these.
    const event = await toFunctionEvent(new Request('https://unstream.stream/api/collection/art/abc123?size=300'));

    expect(event.path).toBe('/api/collection/art/abc123');
    expect(event.rawUrl).toBe('https://unstream.stream/api/collection/art/abc123?size=300');
  });

  it('leaves pathParameters undefined, as Netlify did', async () => {
    // netlify.toml records that Netlify never substituted :placeholders, so the handlers' own
    // event.path fallbacks are the live path and must stay the live path.
    const event = await toFunctionEvent(new Request('https://unstream.stream/api/release/mono/hymn'));

    expect(event.pathParameters).toBeUndefined();
  });

  it('reads a JSON body as text', async () => {
    const event = await toFunctionEvent(
      new Request('https://unstream.stream/api/me/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"locale":"en"}',
      }),
    );

    expect(event.body).toBe('{"locale":"en"}');
    expect(event.isBase64Encoded).toBe(false);
  });

  it('gives a GET no body at all', async () => {
    const event = await toFunctionEvent(new Request('https://unstream.stream/api/v1/status'));

    expect(event.body).toBeNull();
  });

  it('reports an empty body as null, not an empty string', async () => {
    // The me-* handlers test `if (!event.body)`; Lambda delivered no body as null.
    const event = await toFunctionEvent(
      new Request('https://unstream.stream/api/me/tips', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '',
      }),
    );

    expect(event.body).toBeNull();
  });

  it('base64-encodes a non-textual body, the shape tips-webhook already handles', async () => {
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
    const event = await toFunctionEvent(
      new Request('https://unstream.stream/api/tips/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: bytes,
      }),
    );

    expect(event.isBase64Encoded).toBe(true);
    expect(event.body).toBe(btoa(String.fromCharCode(...bytes)));
  });

  it('keeps a Stripe webhook’s payload byte-for-byte, so the signature still verifies', async () => {
    const payload = '{"id":"evt_1","type":"checkout.session.completed","data":{"ünïcode":"ok"}}';
    const event = await toFunctionEvent(
      new Request('https://unstream.stream/api/tips/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Stripe-Signature': 't=1,v1=abc' },
        body: payload,
      }),
    );

    expect(event.body).toBe(payload);
    expect(event.headers['stripe-signature']).toBe('t=1,v1=abc');
  });
});

describe('toResponse', () => {
  it('carries the status, headers and body back', async () => {
    const response = toResponse({
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'X-Request-Id': 'abc' },
      body: '{"ok":true}',
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.text()).toBe('{"ok":true}');
  });

  it('stringifies the numbers and booleans Lambda allowed in headers', () => {
    const response = toResponse({ statusCode: 200, headers: { 'Content-Length': 11, 'X-Flag': true } });

    expect(response.headers.get('content-length')).toBe('11');
    expect(response.headers.get('x-flag')).toBe('true');
  });

  it('sends no body with a 204, which Response would otherwise reject', async () => {
    const response = toResponse({ statusCode: 204, headers: { 'Access-Control-Allow-Origin': '*' }, body: '' });

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(await response.text()).toBe('');
  });

  it('decodes a base64 body back to its bytes', async () => {
    // collection-art returns cover art this way.
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const response = toResponse({
      statusCode: 200,
      headers: { 'Content-Type': 'image/png' },
      body: btoa(String.fromCharCode(...bytes)),
      isBase64Encoded: true,
    });

    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });

  it('round-trips a large binary body through both directions', async () => {
    // The chunked btoa() in the adapter exists so a big body can't blow the argument limit.
    const bytes = new Uint8Array(200_000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;

    const event = await toFunctionEvent(
      new Request('https://unstream.stream/api/collection/art/x', {
        method: 'POST',
        headers: { 'Content-Type': 'image/png' },
        body: bytes,
      }),
    );
    const response = toResponse({ statusCode: 200, body: event.body, isBase64Encoded: true });

    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });
});
