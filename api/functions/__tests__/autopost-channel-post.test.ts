// What each channel gets for an autopost slot, or why it gets nothing
// (docs/specs/release-autopost-spec.md, "Networks", "Links" and "Pictures").

import { describe, it, expect } from 'vitest';
import { buildChannelPost, imageAltText, variantsFor, type ChannelPostInput } from '../autopost-channel-post';
import { DEFAULT_TEMPLATES } from '../../shared/autopost-templates';

const input = (over: Partial<ChannelPostInput> = {}): ChannelPostInput => ({
  slot: { at: '2026-11-13T15:00:00.000Z', date: '2026-11-13', kind: 'catalogue', templateIndex: 2, imageOnInstagram: true },
  channel: { id: 'ch1', service: 'bluesky' },
  artist: { name: 'Kid Lightbulbs', slug: 'kid-lightbulbs' },
  release: {
    title: 'Ruined Castle',
    slug: 'ruined-castle',
    releaseType: 'ep',
    releaseDate: '2024-12-06',
    datePrecision: 'day',
    sources: [{ platform: 'bandcamp', offers: [] }],
  },
  templates: null,
  takesTips: false,
  image: { url: 'https://cards.unstream.stream/autopost/abc.jpg', width: 1200, height: 1200, altText: 'Cover art for Ruined Castle by Kid Lightbulbs' },
  imageFitsInstagram: true,
  tagId: 'tag1',
  ...over,
});

describe('buildChannelPost', () => {
  it('schedules the post at the slot, tagged, with the image and the release page link', () => {
    const post = buildChannelPost(input());
    expect(post.ok).toBe(true);
    if (!post.ok) return;
    expect(post.text).toBe('From the archives: Ruined Castle, on Bandcamp. https://unstream.stream/a/kid-lightbulbs/ruined-castle');
    expect(post.input).toMatchObject({
      channelId: 'ch1',
      dueAt: '2026-11-13T15:00:00.000Z',
      mode: 'customScheduled',
      tagIds: ['tag1'],
      assets: [{ image: { url: 'https://cards.unstream.stream/autopost/abc.jpg', metadata: { altText: 'Cover art for Ruined Castle by Kid Lightbulbs' } } }],
    });
  });

  it('says "link in bio" on Instagram and marks it a feed post', () => {
    const post = buildChannelPost(input({ channel: { id: 'ig', service: 'instagram' } }));
    expect(post.ok && post.text).toContain('link in bio');
    expect(post.ok && post.input.metadata).toEqual({ instagram: { type: 'post', shouldShareToFeed: true } });
  });

  it('skips Instagram without a fresh image, a copied image, or one in its shape range', () => {
    const ig = { channel: { id: 'ig', service: 'instagram' } };
    expect(buildChannelPost(input({ ...ig, slot: { ...input().slot, imageOnInstagram: false } })))
      .toEqual({ ok: false, reason: 'No fresh image for Instagram' });
    expect(buildChannelPost(input({ ...ig, image: null })).ok).toBe(false);
    expect(buildChannelPost(input({ ...ig, imageFitsInstagram: false })).ok).toBe(false);
  });

  it('treats TikTok like Instagram: an image on every post, and “link in bio”', () => {
    const tiktok = { channel: { id: 'tt', service: 'tiktok' } };
    const post = buildChannelPost(input(tiktok));
    expect(post.ok && post.text).toContain('link in bio');
    expect(post.ok && post.input.assets).toHaveLength(1);
    expect(buildChannelPost(input({ ...tiktok, image: null }))).toEqual({ ok: false, reason: 'The image couldn’t be copied, and TikTok needs one' });
    expect(buildChannelPost(input({ ...tiktok, slot: { ...input().slot, imageOnInstagram: false } })))
      .toEqual({ ok: false, reason: 'No fresh image for TikTok' });
    // Instagram's shape range is Instagram's alone.
    expect(buildChannelPost(input({ ...tiktok, imageFitsInstagram: false })).ok).toBe(true);
  });

  it('posts to the other networks without an image', () => {
    const post = buildChannelPost(input({ image: null }));
    expect(post.ok && post.input.assets).toBeUndefined();
  });

  it('refuses a post over the network’s length', () => {
    const long = input({ templates: { catalogue: [`{title} ${'x'.repeat(300)}`] } });
    expect(buildChannelPost(long)).toEqual({ ok: false, reason: expect.stringContaining('over Bluesky’s 300') });
    expect(buildChannelPost({ ...long, channel: { id: 't', service: 'threads' } }).ok).toBe(true);
  });

  it('refuses a network autopost doesn’t write for, by its proper name', () => {
    expect(buildChannelPost(input({ channel: { id: 'yt', service: 'youtube' } })))
      .toEqual({ ok: false, reason: 'YouTube isn’t a network autopost writes for' });
  });

  it('writes for LinkedIn and Substack with text and the image, and no extra settings', () => {
    for (const service of ['linkedin', 'substack']) {
      const post = buildChannelPost(input({ channel: { id: service, service } }));
      expect(post.ok, service).toBe(true);
      expect(post.ok && post.input.metadata, service).toBeUndefined();
      expect(post.ok && post.input.assets, service).toHaveLength(1);
      expect(post.ok && post.text, service).toContain('https://unstream.stream/a/kid-lightbulbs/ruined-castle');
    }
  });

  it('refuses a release post whose release no longer qualifies', () => {
    expect(buildChannelPost(input({ release: null }))).toEqual({ ok: false, reason: 'The release no longer qualifies' });
  });

  it('writes a call for support with the Tip page when they take tips', () => {
    const post = buildChannelPost(input({ slot: { ...input().slot, kind: 'support', templateIndex: 1 }, release: null, takesTips: true }));
    expect(post.ok && post.text).toBe('The best ways to support my music: https://unstream.stream/tip/kid-lightbulbs');
  });

  it('uses the artist’s own variants, falling back to the defaults for kinds they left empty', () => {
    expect(variantsFor('catalogue', { catalogue: ['{title}!'] })).toEqual(['{title}!']);
    expect(variantsFor('catalogue', { catalogue: ['  '] })).toEqual(DEFAULT_TEMPLATES.catalogue);
    expect(variantsFor('support', { catalogue: ['{title}!'] })).toEqual(DEFAULT_TEMPLATES.support);
  });
});

describe('imageAltText', () => {
  it('says what the image is', () => {
    expect(imageAltText('cover:r1', 'Kid Lightbulbs', 'Ruined Castle')).toBe('Cover art for Ruined Castle by Kid Lightbulbs');
    expect(imageAltText('photo', 'Kid Lightbulbs', null)).toBe('Photo of Kid Lightbulbs');
  });
});
