// Release autopost: one planned slot as a Buffer post for one channel
// (docs/specs/release-autopost-spec.md, "Networks", "Links" and "Pictures").
//
// Pure, like the planner: the sweep fetches everything and this decides what each channel gets,
// or why it gets nothing. Kept apart from the sweep so every rule a post has to pass is tested
// without Buffer or a database.

import {
  DEFAULT_TEMPLATES,
  releaseTemplateVars,
  renderTemplate,
  renderVariant,
  supportTemplateVars,
  type AutopostKind,
  type TemplateArtist,
  type TemplateRelease,
} from '../shared/autopost-templates';
import { AUTOPOST_NETWORK_LIMITS, isAutopostNetwork, isImageFirstNetwork, networkName } from '../shared/autopost-networks';

export { isAutopostNetwork };

export interface ChannelPostInput {
  /**
   * `at` is when this channel posts it: the slot's set time, or with "Pick days & times for me",
   * the time the sweep read from this channel's Buffer posting schedule (`queueTimeOn`).
   */
  slot: { at: string; date: string; kind: AutopostKind; templateIndex: number; imageOnInstagram: boolean };
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
  if (!isAutopostNetwork(service)) return { ok: false, reason: `${networkName(service)} isn’t a network autopost writes for` };
  if (slot.kind !== 'support' && !release) return { ok: false, reason: 'The release no longer qualifies' };
  const imageCheck = imageProblem(service, slot.imageOnInstagram, input.image, input.imageFitsInstagram);
  if (imageCheck) return { ok: false, reason: imageCheck };

  // The template functions' `instagram` option means "no clickable links": "link in bio".
  const imageFirst = isImageFirstNetwork(service);
  const vars = release
    ? releaseTemplateVars(release, artist, { postDate: slot.date, instagram: imageFirst })
    : supportTemplateVars(artist, { takesTips: input.takesTips, instagram: imageFirst });
  const rendered = renderVariant(variantsFor(slot.kind, input.templates), slot.templateIndex, vars);
  if (!rendered) return { ok: false, reason: 'No template could be filled for this release' };
  return bufferPost(channel, rendered.text, slot.at, input.image, input.tagId);
}

/**
 * What one channel gets for a campaign post, or why it gets nothing. The same rules as an
 * autopost: an image on Instagram and TikTok, "link in bio" there, and each network's length.
 * The artist's text is a template, filled now, so {link} and {where} are right on the day.
 */
export function buildCampaignChannelPost(input: {
  at: string;
  date: string;
  /** The artist's words, in the template language. */
  text: string;
  channel: { id: string; service: string };
  artist: TemplateArtist;
  release: TemplateRelease;
  image: ChannelPostInput['image'];
  imageFitsInstagram: boolean;
  tagId: string;
}): ChannelPost {
  const service = input.channel.service;
  if (!isAutopostNetwork(service)) return { ok: false, reason: `${networkName(service)} isn’t a network autopost writes for` };
  const imageCheck = imageProblem(service, input.image !== null, input.image, input.imageFitsInstagram);
  if (imageCheck) return { ok: false, reason: imageCheck };
  const vars = releaseTemplateVars(input.release, input.artist, { postDate: input.date, instagram: isImageFirstNetwork(service) });
  const text = renderTemplate(input.text, vars);
  if (!text) return { ok: false, reason: 'The post uses a fact Unstream doesn’t have for this release' };
  return bufferPost(input.channel, text, input.at, input.image, input.tagId);
}

/** Why a network can't take this image (or its absence), or null when it can. */
function imageProblem(service: string, fresh: boolean, image: ChannelPostInput['image'], fitsInstagram: boolean): string | null {
  const name = networkName(service);
  if (isImageFirstNetwork(service)) {
    // `fresh` is the planner's "fresh image" flag, which covers TikTok the same way.
    if (!fresh) return `No fresh image for ${name}`;
    if (!image) return `The image couldn’t be copied, and ${name} needs one`;
  }
  // Only Instagram refuses images outside its shape range; TikTok takes them as they are.
  if (service === 'instagram' && image && !fitsInstagram) return 'The image is outside Instagram’s shape range';
  return null;
}

/** The Buffer post itself, once the text is final: checked against the network's length. */
function bufferPost(channel: { id: string; service: string }, text: string, at: string, image: ChannelPostInput['image'], tagId: string): ChannelPost {
  const service = channel.service;
  const limit = AUTOPOST_NETWORK_LIMITS[service];
  if (text.length > limit) {
    return { ok: false, reason: `${text.length} characters is over ${networkName(service)}’s ${limit}` };
  }

  const post: Record<string, unknown> = {
    channelId: channel.id,
    text,
    dueAt: at,
    mode: 'customScheduled',
    schedulingType: 'automatic',
    // On the post itself: Buffer's analytics filter on a post's own tags.
    tagIds: [tagId],
  };
  if (image) post.assets = [{ image: { url: image.url, metadata: { altText: image.altText } } }];
  if (service === 'instagram') post.metadata = { instagram: { type: 'post', shouldShareToFeed: true } };
  if (service === 'facebook') post.metadata = { facebook: { type: 'post' } };

  return { ok: true, text, imageUrl: image?.url ?? null, input: post };
}

/** Alt text for an autopost image, from what it is. */
export function imageAltText(imageKey: string, artistName: string, releaseTitle: string | null): string {
  if (imageKey.startsWith('cover:') && releaseTitle) return `Cover art for ${releaseTitle} by ${artistName}`;
  if (imageKey === 'photo') return `Photo of ${artistName}`;
  if (imageKey === 'cover' && releaseTitle) return `Cover art for ${releaseTitle} by ${artistName}`;
  return `Image from ${artistName}`;
}
