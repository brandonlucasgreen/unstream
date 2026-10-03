// The og-metadata edge function answers social crawlers for `/?q=…` with a page of Open Graph
// tags. The query comes straight from the URL, and the artist name and image come from a
// search result, so every one of them must be escaped before it lands in the HTML.

import { describe, it, expect } from 'vitest';
import { generateOgHtml } from '../../edge/og-metadata.ts';

const ATTACK = `"><script>alert(1)</script>`;

describe('og-metadata: generateOgHtml escapes untrusted values', () => {
  it('escapes the search query in the title and meta content', () => {
    const html = generateOgHtml(ATTACK);
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('"><');
    expect(html).toContain('<title>&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt; on Unstream');
    expect(html).toContain('content="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt; on Unstream');
  });

  it('escapes the artist name from the search result', () => {
    const html = generateOgHtml('radiohead', undefined, `Tom's "Band" <b>`);
    expect(html).toContain('<title>Tom&#39;s &quot;Band&quot; &lt;b&gt; on Unstream');
    expect(html).not.toContain('<b>');
  });

  it('escapes the image URL inside the og:image and twitter:image attributes', () => {
    const html = generateOgHtml('radiohead', `https://img.example/a.jpg"><script>alert(1)</script>`, 'Radiohead');
    expect(html).not.toContain('<script>');
    expect(html).toContain('<meta property="og:image" content="https://img.example/a.jpg&quot;&gt;&lt;script&gt;');
    expect(html).toContain('<meta name="twitter:image" content="https://img.example/a.jpg&quot;&gt;&lt;script&gt;');
  });

  it("keeps og:url encoded and attribute-safe, including the ' that encodeURIComponent leaves alone", () => {
    const html = generateOgHtml(`it's a "test"`);
    expect(html).toContain('<meta property="og:url" content="https://unstream.stream/?q=it&#39;s%20a%20%22test%22">');
    expect(html).toContain('<meta name="twitter:url" content="https://unstream.stream/?q=it&#39;s%20a%20%22test%22">');
  });

  it('leaves an ordinary artist name and image URL readable', () => {
    const html = generateOgHtml('radiohead', 'https://f4.bcbits.com/img/a1_10.jpg', 'Radiohead');
    expect(html).toContain('<title>Radiohead on Unstream - Find music on alternative platforms</title>');
    expect(html).toContain('<meta property="og:image" content="https://f4.bcbits.com/img/a1_10.jpg">');
    expect(html).toContain('<meta property="og:url" content="https://unstream.stream/?q=radiohead">');
  });
});
