// The /tip/{slug} share card (UNS-225): title is the ticket's exact share text, the image is the
// artist's photo with the /a/ page's precedence, and every database-sourced value that reaches an
// HTML attribute must come out escaped — a hostile artist name or image URL is the attack this
// builder exists to survive.

import { describe, it, expect } from 'vitest';
import { buildTipPageMetaHtml, tipShareTitle, tipShareDescription, isTipSlug, TIP_RESERVED_SLUGS } from '../../shared/tip-page-meta';

const ATTACK = `"><script>alert(1)</script>`;

describe('tip share copy (UNS-225)', () => {
  it('title is the ticket share text: "Leave [artist name] a tip on Unstream"', () => {
    expect(tipShareTitle('Kid Lightbulbs')).toBe('Leave Kid Lightbulbs a tip on Unstream');
  });

  it('description matches the line the /tip/ page renders under its heading', () => {
    expect(tipShareDescription('Kid Lightbulbs')).toBe("Support for their music, paid straight to Kid Lightbulbs's own Stripe account.");
  });
});

describe('tip-page-meta: generateOgHtml escapes untrusted values', () => {
  it('escapes the artist name in the title and both meta tags', () => {
    const html = buildTipPageMetaHtml({ slug: 'kid-lightbulbs', artistName: `Tom's "Band" <b>`, imageUrl: null });
    expect(html).not.toContain('<b>');
    expect(html).toContain('<title>Leave Tom&#39;s &quot;Band&quot; &lt;b&gt; a tip on Unstream</title>');
    expect(html).toContain('<meta property="og:title" content="Leave Tom&#39;s &quot;Band&quot; &lt;b&gt; a tip on Unstream">');
    expect(html).toContain('<meta name="twitter:title" content="Leave Tom&#39;s &quot;Band&quot; &lt;b&gt; a tip on Unstream">');
  });

  it('escapes the image URL inside the og:image and twitter:image attributes', () => {
    const html = buildTipPageMetaHtml({ slug: 'kid-lightbulbs', artistName: 'Radiohead', imageUrl: `https://img.example/a.jpg${ATTACK}` });
    expect(html).not.toContain('<script>');
    expect(html).toContain('<meta property="og:image" content="https://img.example/a.jpg&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;">');
    expect(html).toContain('<meta name="twitter:image" content="https://img.example/a.jpg&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;">');
  });

  it('escapes the photo-of alt text too (it embeds the artist name)', () => {
    const html = buildTipPageMetaHtml({ slug: 'kid-lightbulbs', artistName: `<i>x</i>`, imageUrl: 'https://img.example/a.jpg' });
    expect(html).toContain('<meta property="og:image:alt" content="Photo of &lt;i&gt;x&lt;/i&gt;">');
    expect(html).not.toContain('<i>');
  });
});

describe('tip-page-meta: the card itself', () => {
  it('carries the artist photo and the large-image card when there is one', () => {
    const html = buildTipPageMetaHtml({ slug: 'kid-lightbulbs', artistName: 'Kid Lightbulbs', imageUrl: 'https://f4.bcbits.com/img/a1_10.jpg' });
    expect(html).toContain('<meta property="og:image" content="https://f4.bcbits.com/img/a1_10.jpg">');
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image">');
    expect(html).toContain('<meta property="og:url" content="https://unstream.stream/tip/kid-lightbulbs">');
    expect(html).toContain('<link rel="canonical" href="https://unstream.stream/tip/kid-lightbulbs">');
  });

  it('omits the image tags and uses the small card when the artist has no photo', () => {
    const html = buildTipPageMetaHtml({ slug: 'kid-lightbulbs', artistName: 'Kid Lightbulbs', imageUrl: null });
    expect(html).not.toContain('og:image');
    expect(html).not.toContain('twitter:image');
    expect(html).toContain('<meta name="twitter:card" content="summary">');
  });

  it('encodes the slug into og:url the way a slug with specials needs it', () => {
    const html = buildTipPageMetaHtml({ slug: 'it-is-a-test', artistName: 'Test', imageUrl: null });
    expect(html).toContain('https://unstream.stream/tip/it-is-a-test');
  });
});

describe('isTipSlug (the path gate before any database read)', () => {
  it('accepts the same shape tips-checkout validates', () => {
    expect(isTipSlug('kid-lightbulbs')).toBe(true);
    expect(isTipSlug('bjork')).toBe(true);
    expect(isTipSlug('a-'.repeat(49) + 'a')).toBe(true);
  });

  it('rejects hand-typed noise before a query runs', () => {
    expect(isTipSlug('')).toBe(false);
    expect(isTipSlug('-leading-dash')).toBe(false);
    expect(isTipSlug('trailing-')).toBe(false);
    expect(isTipSlug('has.dot')).toBe(false);
    expect(isTipSlug('a'.repeat(101))).toBe(false);
  });

  it('reserves the SPA route names a slug-shaped path collides with', () => {
    // /tip/thanks is the payment-return page; an artist named "thanks" gets no card and no read.
    expect(isTipSlug('thanks')).toBe(true);
    expect(TIP_RESERVED_SLUGS.has('thanks')).toBe(true);
  });
});