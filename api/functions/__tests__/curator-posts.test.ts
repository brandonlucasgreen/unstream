// Caption rendering for curator posts: every missing-value case, both networks, and the
// hashtag block. See docs/specs/curator-posts-spec.md, "Templates".

import { describe, it, expect } from 'vitest';
import {
  CAPTION_LIMITS,
  DEFAULT_TEMPLATE,
  captionProblem,
  cleanHashtags,
  handleFor,
  isValidHandle,
  parseFacebookHandle,
  parseInstagramHandle,
  payoutPhrase,
  renderCaption,
  type AddressBook,
  type CuratorArtist,
  type CuratorProfile,
  type CuratorTemplate,
} from '../curator-posts';

const artist = (over: Partial<CuratorArtist> = {}): CuratorArtist => ({
  id: 'a1',
  name: 'Honeycrush',
  slug: 'honeycrush',
  location: 'Brooklyn',
  links: { instagram: 'https://instagram.com/honeycrush', facebook: 'https://facebook.com/honeycrush' },
  release: { title: 'Luminaires' },
  platform: { id: 'bandcamp', name: 'Bandcamp' },
  ...over,
});

const curator: CuratorProfile = {
  showName: 'Night Shift',
  labelName: null,
  handles: { instagram: 'nightshift', facebook: 'nightshift' },
};

const template: CuratorTemplate = {
  postText: 'Tonight on {show}:\n\n{artists}\n\nBuy direct: {link}',
  lineText: '{artist} – {release}',
  hashtags: [],
};

describe('parseInstagramHandle', () => {
  it('reads the handle, with or without @ and trailing slash', () => {
    expect(parseInstagramHandle('https://instagram.com/kidlightbulbs')).toBe('kidlightbulbs');
    expect(parseInstagramHandle('https://www.instagram.com/@kidlightbulbs/')).toBe('kidlightbulbs');
    expect(parseInstagramHandle('https://instagram.com/kid.light_bulbs/?igsh=abc')).toBe('kid.light_bulbs');
  });

  it('refuses links that name no account', () => {
    expect(parseInstagramHandle('https://instagram.com/p/Cxyz123/')).toBeNull();
    expect(parseInstagramHandle('https://instagram.com/reel/Cxyz123/')).toBeNull();
    expect(parseInstagramHandle('https://instagram.com/stories/someone/1/')).toBeNull();
  });

  it('refuses another host, a bad shape, and nothing at all', () => {
    expect(parseInstagramHandle('https://instagram.com.evil.test/someone')).toBeNull();
    expect(parseInstagramHandle('https://facebook.com/someone')).toBeNull();
    expect(parseInstagramHandle(`https://instagram.com/${'a'.repeat(31)}`)).toBeNull();
    expect(parseInstagramHandle('not a url')).toBeNull();
    expect(parseInstagramHandle(null)).toBeNull();
  });
});

describe('parseFacebookHandle', () => {
  it('reads a page handle', () => {
    expect(parseFacebookHandle('https://facebook.com/kidlightbulbs')).toBe('kidlightbulbs');
    expect(parseFacebookHandle('https://www.facebook.com/@kidlightbulbs/')).toBe('kidlightbulbs');
  });

  it('refuses the numeric profile form and non-account paths', () => {
    expect(parseFacebookHandle('https://facebook.com/profile.php?id=123813724362975')).toBeNull();
    expect(parseFacebookHandle('https://facebook.com/groups/somegroup')).toBeNull();
    expect(parseFacebookHandle('https://instagram.com/kidlightbulbs')).toBeNull();
  });
});

describe('handleFor', () => {
  it('prefers the artist’s own link for that network', () => {
    expect(handleFor(artist(), 'instagram')).toBe('honeycrush');
    expect(handleFor(artist(), 'facebook')).toBe('honeycrush');
  });

  // The bug behind the generator's existing Threads rule: a handle good on one network is not
  // a handle on another.
  it('never borrows one network’s handle for another', () => {
    const onlyInstagram = artist({ links: { instagram: 'https://instagram.com/honeycrush', facebook: null } });
    expect(handleFor(onlyInstagram, 'facebook')).toBeNull();
  });

  it('falls back to the curator’s address book', () => {
    const unlinked = artist({ links: {} });
    const book: AddressBook = { a1: { instagram: 'honeycrush.band' } };
    expect(handleFor(unlinked, 'instagram', book)).toBe('honeycrush.band');
  });

  it('rejects a typed handle that isn’t shaped like one', () => {
    const unlinked = artist({ links: {} });
    expect(handleFor(unlinked, 'instagram', { a1: { instagram: 'https://instagram.com/honeycrush' } })).toBeNull();
    expect(handleFor(unlinked, 'instagram', { a1: { instagram: '@honeycrush' } })).toBeNull();
    expect(handleFor(unlinked, 'instagram', { a1: { instagram: '' } })).toBeNull();
  });

  it('is null when nothing knows a handle', () => {
    expect(handleFor(artist({ links: {} }), 'instagram')).toBeNull();
  });
});

describe('isValidHandle', () => {
  it('accepts what each network issues and rejects what it does not', () => {
    expect(isValidHandle('instagram', 'kid.light_bulbs')).toBe(true);
    expect(isValidHandle('instagram', 'has-a-hyphen')).toBe(false);
    expect(isValidHandle('instagram', 'a'.repeat(31))).toBe(false);
    expect(isValidHandle('facebook', 'kidlightbulbs')).toBe(true);
    expect(isValidHandle('facebook', 'tiny')).toBe(false);
  });
});

describe('payoutPhrase', () => {
  it('reads the figure from the registry', () => {
    expect(payoutPhrase({ id: 'bandcamp', name: 'Bandcamp' })).toBe('keeps 80-85% on Bandcamp');
  });

  it('is null without a platform the registry knows', () => {
    expect(payoutPhrase(null)).toBeNull();
    expect(payoutPhrase({ id: 'not-a-platform', name: 'Nope' })).toBeNull();
  });
});

describe('renderCaption — missing values', () => {
  it('tags the artist when a handle is known and names them when it is not', () => {
    expect(renderCaption({ template, artists: [artist()], network: 'instagram', curator }))
      .toContain('@honeycrush – Luminaires');

    expect(renderCaption({ template, artists: [artist({ links: {} })], network: 'instagram', curator }))
      .toContain('Honeycrush – Luminaires');
  });

  // The rule that makes the line readable: the separator goes with the value.
  it('drops {release} together with the dash in front of it', () => {
    const caption = renderCaption({
      template, artists: [artist({ release: null })], network: 'instagram', curator,
    });
    expect(caption).toContain('@honeycrush');
    expect(caption).not.toContain('–');
  });

  it('drops {payout} and {location} when they are not known', () => {
    const line: CuratorTemplate = { ...template, lineText: '{artist} — {location} — {payout}' };
    const caption = renderCaption({
      template: line,
      artists: [artist({ location: null, platform: null })],
      network: 'instagram',
      curator,
    });
    expect(caption).toContain('@honeycrush');
    expect(caption).not.toContain('—');
  });

  it('drops {show} when the curator has not set one', () => {
    const caption = renderCaption({
      template, artists: [artist()], network: 'instagram', curator: { ...curator, showName: null },
    });
    expect(caption).not.toContain('{show}');
    expect(caption.startsWith('Tonight on:')).toBe(true);
  });

  it('leaves no unresolved placeholder behind', () => {
    const everything: CuratorTemplate = {
      postText: '{show} {label}\n\n{artists}\n\n{link}',
      lineText: '{artist} – {release} – {location} – {payout}',
      hashtags: [],
    };
    const caption = renderCaption({
      template: everything,
      artists: [artist({ release: null, location: null, platform: null, links: {} })],
      network: 'instagram',
      curator: { showName: null, labelName: null, handles: {} },
    });
    expect(caption).not.toMatch(/\{[a-z]+\}/);
  });
});

describe('renderCaption — {link} per network', () => {
  it('sends one artist to their Unstream page, clickable only on Facebook', () => {
    expect(renderCaption({ template, artists: [artist()], network: 'facebook', curator }))
      .toContain('https://unstream.stream/a/honeycrush');
    expect(renderCaption({ template, artists: [artist()], network: 'instagram', curator }))
      .toContain('unstream.stream/a/honeycrush');
  });

  it('gives Facebook a link per artist when there are several', () => {
    const two = [artist(), artist({ id: 'a2', name: 'Adventsong', slug: 'adventsong' })];
    const caption = renderCaption({ template, artists: two, network: 'facebook', curator });
    expect(caption).toContain('Honeycrush: https://unstream.stream/a/honeycrush');
    expect(caption).toContain('Adventsong: https://unstream.stream/a/adventsong');
  });

  it('points Instagram at the curator’s page, or the bio when they have no handle', () => {
    const two = [artist(), artist({ id: 'a2', name: 'Adventsong', slug: 'adventsong' })];
    expect(renderCaption({ template, artists: two, network: 'instagram', curator }))
      .toContain('unstream.stream/u/nightshift');
    expect(renderCaption({ template, artists: two, network: 'instagram', curator: { ...curator, handles: {} } }))
      .toContain('link in bio');
  });

  // Unstream writes no copy: the wording around a link is the curator's, so the variable is
  // bare. Only "link in bio" is ours, because there is no address to put there instead.
  it('puts no label of its own in front of the curator’s page', () => {
    const two = [artist(), artist({ id: 'a2', name: 'Adventsong', slug: 'adventsong' })];
    const caption = renderCaption({ template, artists: two, network: 'instagram', curator });
    expect(caption).toContain('Buy direct: unstream.stream/u/nightshift');
  });
});

describe('renderCaption — Facebook never uses an @handle', () => {
  // An @handle in a Facebook caption tags nobody; a Page mention needs the Page's numeric id,
  // which we don't hold for an artist. Naming them is the honest output, and is the text an
  // annotation would have to point at if we ever get those ids.
  it('names the artist even when their Facebook handle is known', () => {
    const caption = renderCaption({ template, artists: [artist()], network: 'facebook', curator });
    expect(caption).toContain('Honeycrush – Luminaires');
    expect(caption).not.toContain('@honeycrush');
  });

  it('still tags them on Instagram from the same artist', () => {
    const caption = renderCaption({ template, artists: [artist()], network: 'instagram', curator });
    expect(caption).toContain('@honeycrush');
  });
});

describe('cleanHashtags', () => {
  it('blocks the two that drew the bot comments, whatever their case or #', () => {
    expect(cleanHashtags(['#newmusic', 'NewRelease', '#bandcamp'])).toEqual(['#bandcamp']);
  });

  it('keeps at most three, de-duplicated, with one leading #', () => {
    expect(cleanHashtags(['##dreampop', 'dreampop', '#shoegaze', 'noise', '#ambient']))
      .toEqual(['#dreampop', '#shoegaze', '#noise']);
  });

  it('ignores empty entries', () => {
    expect(cleanHashtags(['', '  ', '#'])).toEqual([]);
  });

  it('appends them to the caption once', () => {
    const caption = renderCaption({
      template: { ...template, hashtags: ['#shoegaze', '#newmusic'] },
      artists: [artist()], network: 'instagram', curator,
    });
    expect(caption.endsWith('#shoegaze')).toBe(true);
    expect(caption).not.toContain('#newmusic');
  });
});

describe('captionProblem', () => {
  it('passes a normal caption', () => {
    expect(captionProblem('instagram', 'Tonight on Night Shift')).toBeNull();
  });

  it('refuses an empty one', () => {
    expect(captionProblem('instagram', '   ')).toContain('empty');
  });

  // Neither network threads, so this is the curator's to fix — and catching it here keeps an
  // all-or-nothing content item from rejecting both posts.
  it('refuses one over the network’s limit, and reports the right limit', () => {
    const long = 'x'.repeat(CAPTION_LIMITS.instagram + 1);
    expect(captionProblem('instagram', long)).toContain('2200');
    expect(captionProblem('facebook', long)).toBeNull();
  });
});

describe('DEFAULT_TEMPLATE', () => {
  it('renders the demo post: five artists, one of them untagged', () => {
    const artists = [
      artist(),
      artist({ id: 'a2', name: 'Adventsong', slug: 'adventsong', links: { instagram: 'https://instagram.com/adventsong' }, release: { title: 'Vesper' } }),
      artist({ id: 'a3', name: 'AxWax', slug: 'axwax', links: {}, release: null }),
    ];
    const caption = renderCaption({ template: DEFAULT_TEMPLATE, artists, network: 'instagram', curator });

    expect(caption).toContain('Tonight on Night Shift:');
    expect(caption).toContain('@honeycrush – Luminaires');
    expect(caption).toContain('@adventsong – Vesper');
    expect(caption).toContain('AxWax');          // no handle, so their name
    expect(caption).not.toContain('AxWax –');    // and no release, so no dangling dash
    expect(captionProblem('instagram', caption)).toBeNull();
  });
});
