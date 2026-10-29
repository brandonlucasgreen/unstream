// Release autopost: one planned slot as a Buffer post for one channel
// (docs/specs/release-autopost-spec.md, "Networks", "Links" and "Pictures").
//
// Pure, like the planner: the sweep fetches everything and this decides what each channel gets,
// or why it gets nothing. Kept apart from the sweep so every rule a post has to pass is tested
// without Buffer or a database.

import {
  DEFAULT_TEMPLATES,
  releaseTemplateVars,
  renderVariant,
  supportTemplateVars,
  type AutopostKind,
  type TemplateArtist,
  type TemplateRelease,
} from '../shared/autopost-templates';

/** The networks autopost writes for, and the longest post each takes. */
export const AUTOPOST_NETWORK_LIMITS: Record<string, number> = {
  instagram: 2200,
  facebook: 63206,
  threads: 500,
  bluesky: 300,
  mastodon: 500,
};

export function isAutopostNetwork(service: string): boolean {
  return Object.prototype.hasOwnProperty.call(AUTOPOST_NETWORK_LIMITS, service);
}

export interface ChannelPostInput {
  /** queued: add to the channel's Buffer queue rather than scheduling for `at` ("Recommended" time). */
  slot: { at: string; date: string; kind: AutopostKind; templateIndex: number; imageOnInstagram: boolean; queued?: boolean };
  channel: { id: string; service: string };
  artist: TemplateArtist;
  /** null for a call for support. */
  release: TemplateRelease | null;
  /** The artist's own variants per kind; a kind missing here uses Unstream's defaults. */
  templates: Partial<Record<AutopostKind, string[]>> | null;
  takesTips: boolean;
  /** The image copied for this slot, or null when there's none (or it couldn't be copied). */
  image: { url: string; width: number; height: number; altText: string } | null;
  /** Whether the image is inside Instagram's shape range. */
  imageFitsInstagram: boolean;
  tagId: string;
}

export type ChannelPost =
  | { ok: true; text: string; imageUrl: string | null; input: Record<string, unknown> }
  | { ok: false; reason: string };

export function variantsFor(kind: AutopostKind, templates: ChannelPostInput['templates']): string[] {
  const own = templates?.[kind]?.filter(t => t.trim());
  return own && own.length > 0 ? own : DEFAULT_TEMPLATES[kind];
}

/** What one channel gets for a slot, or why it gets nothing. */
export function buildChannelPost(input: ChannelPostInput): ChannelPost {
  const { slot, channel, artist, release } = input;
  const service = channel.service;
  if (!isAutopostNetwork(service)) return { ok: false, reason: `${service} isn't a network autopost writes for` };
  const instagram = service === 'instagram';

  if (slot.kind !== 'support' && !release) return { ok: false, reason: 'The release no longer qualifies' };

  // Instagram needs an image on every post, and one it accepts the shape of.
  const image = input.image;
  if (instagram) {
    if (!slot.imageOnInstagram) return { ok: false, reason: 'No fresh image for Instagram' };
    if (!image) return { ok: false, reason: 'The image couldn’t be copied, and Instagram needs one' };
    if (!input.imageFitsInstagram) return { ok: false, reason: 'The image is outside Instagram’s shape range' };
  }

  const vars = release
    ? releaseTemplateVars(release, artist, { postDate: slot.date, instagram })
    : supportTemplateVars(artist, { takesTips: input.takesTips, instagram });
  const rendered = renderVariant(variantsFor(slot.kind, input.templates), slot.templateIndex, vars);
  if (!rendered) return { ok: false, reason: 'No template could be filled for this release' };

  const limit = AUTOPOST_NETWORK_LIMITS[service];
  if (rendered.text.length > limit) {
    return { ok: false, reason: `${rendered.text.length} characters is over ${service}’s ${limit}` };
  }

  const post: Record<string, unknown> = {
    channelId: channel.id,
    text: rendered.text,
    // Queued: Buffer's posting schedule for the channel picks the time. Otherwise, exactly then.
    ...(slot.queued ? { mode: 'addToQueue' } : { dueAt: slot.at, mode: 'customScheduled' }),
    schedulingType: 'automatic',
    // On the post itself: Buffer's analytics filter on a post's own tags.
    tagIds: [input.tagId],
  };
  if (image) post.assets = [{ image: { url: image.url, metadata: { altText: image.altText } } }];
  if (instagram) post.metadata = { instagram: { type: 'post', shouldShareToFeed: true } };
  if (service === 'facebook') post.metadata = { facebook: { type: 'post' } };

  return { ok: true, text: rendered.text, imageUrl: image?.url ?? null, input: post };
}

/** Alt text for an autopost image, from what it is. */
export function imageAltText(imageKey: string, artistName: string, releaseTitle: string | null): string {
  if (imageKey.startsWith('cover:') && releaseTitle) return `Cover art for ${releaseTitle} by ${artistName}`;
  if (imageKey === 'photo') return `Photo of ${artistName}`;
  return `Image from ${artistName}`;
}
