// Release autopost templates (docs/specs/release-autopost-spec.md, "The words").
//
// A post goes out in an artist's own name, so what matters is the failures that look fine: a
// dangling ", from " for an undated release, "a EP", a secondhand marketplace named as a place to
// buy, a link that Instagram can't click.

import { describe, it, expect } from 'vitest';
import {
  AUTOPOST_KINDS,
  DEFAULT_TEMPLATES,
  ageInWords,
  releaseTemplateVars,
  renderTemplate,
  renderVariant,
  supportTemplateVars,
  templateProblems,
  whereToBuy,
  type TemplateRelease,
} from '../../shared/autopost-templates';

const artist = { name: 'Kid Lightbulbs', slug: 'kid-lightbulbs' };

const release = (over: Partial<TemplateRelease> = {}): TemplateRelease => ({
  title: 'Ruined Castle',
  slug: 'ruined-castle',
  releaseType: 'ep',
  releaseDate: '2024-12-06',
  datePrecision: 'day',
  sources: [{ platform: 'bandcamp', offers: [{ price: 5, currency: 'USD', availability: 'available' }] }],
  ...over,
});

describe('renderTemplate', () => {
  it('fills variables', () => {
    expect(renderTemplate('{title} on {where}', { title: 'Lantern', where: 'Bandcamp' })).toBe('Lantern on Bandcamp');
  });

  it('drops an optional segment whose variable has no value, and tidies the space it leaves', () => {
    const t = 'From the catalogue: {title}[ ({year})]. [{note} ]{link}';
    expect(renderTemplate(t, { title: 'Lantern', year: null, note: null, link: 'L' })).toBe('From the catalogue: Lantern. L');
    expect(renderTemplate(t, { title: 'Lantern', year: '2024', note: 'Recorded in a barn.', link: 'L' }))
      .toBe('From the catalogue: Lantern (2024). Recorded in a barn. L');
  });

  it('treats a blank value as missing', () => {
    expect(renderTemplate('{title}[, {note}]', { title: 'Lantern', note: '   ' })).toBe('Lantern');
  });

  it('refuses when a required variable has no value, so the caller can try another variant', () => {
    expect(renderTemplate('{title} came out {date}', { title: 'Lantern', date: null })).toBeNull();
  });

  it('keeps the artist’s line breaks', () => {
    expect(renderTemplate('{title}\n\n{link}', { title: 'Lantern', link: 'L' })).toBe('Lantern\n\nL');
  });

  it('refuses a broken template rather than posting part of it', () => {
    expect(renderTemplate('{title} [unclosed', { title: 'Lantern' })).toBeNull();
    expect(renderTemplate('{titel}', { title: 'Lantern' })).toBeNull();
  });
});

describe('renderVariant', () => {
  const variants = ['{title} came out {date}.', '{title}[ ({year})].', '{title}!'];

  it('uses the planned variant when it can be filled', () => {
    expect(renderVariant(variants, 1, { title: 'Lantern', year: '2024' })).toEqual({ text: 'Lantern (2024).', index: 1 });
  });

  it('moves on in turn when it can’t, wrapping round', () => {
    expect(renderVariant(variants, 0, { title: 'Lantern' })).toEqual({ text: 'Lantern.', index: 1 });
    expect(renderVariant(['{date}', '{title}!'], 1, { title: 'Lantern' })).toEqual({ text: 'Lantern!', index: 1 });
  });

  it('gives up when none can be filled', () => {
    expect(renderVariant(['{date}', '{year}'], 0, { title: 'Lantern' })).toBeNull();
  });
});

describe('templateProblems', () => {
  it('passes a good template', () => {
    expect(templateProblems('{title}[, from {year}]: {link}')).toEqual([]);
  });

  it('names unknown variables and unbalanced brackets', () => {
    expect(templateProblems('{titel}')).toEqual(['Unknown variable {titel}']);
    expect(templateProblems('{title')).toContain('A "{" is never closed');
    expect(templateProblems('a ] b')).toContain('A "]" has no matching "["');
    expect(templateProblems('[a [b] c]')).toContain('Optional segments can’t be nested');
    expect(templateProblems('[{title}')).toContain('A "[" is never closed');
    expect(templateProblems('  ')).toContain('The template is empty');
  });
});

describe('the facts', () => {
  it('links to the release page, and says "link in bio" on Instagram', () => {
    expect(releaseTemplateVars(release(), artist, { postDate: '2026-11-01', instagram: false }).link)
      .toBe('https://unstream.stream/a/kid-lightbulbs/ruined-castle');
    expect(releaseTemplateVars(release(), artist, { postDate: '2026-11-01', instagram: true }).link)
      .toBe('link in bio');
  });

  it('words the type as it reads mid-sentence, and has no word for "other"', () => {
    const vars = (releaseType: string) => releaseTemplateVars(release({ releaseType }), artist, { postDate: '2026-11-01', instagram: false });
    expect(vars('ep').type).toBe('EP');
    expect(vars('album').type).toBe('album');
    expect(vars('other').type).toBeNull();
  });

  it('never invents a day or a year the source didn’t give', () => {
    const yearOnly = releaseTemplateVars(release({ releaseDate: '2020-01-01', datePrecision: 'year' }), artist, { postDate: '2026-11-01', instagram: false });
    expect(yearOnly.date).toBe('2020');
    expect(yearOnly.year).toBe('2020');
    const unknown = releaseTemplateVars(release({ releaseDate: '2020-01-01', datePrecision: 'unknown' }), artist, { postDate: '2026-11-01', instagram: false });
    expect(unknown.date).toBeNull();
    expect(unknown.year).toBeNull();
    expect(unknown.age).toBeNull();
  });

  it('carries the artist’s note, trimmed', () => {
    expect(releaseTemplateVars(release({ note: ' Recorded in a barn. ' }), artist, { postDate: '2026-11-01', instagram: false }).note)
      .toBe('Recorded in a barn.');
  });

  it('points a call for support at the Tip page only when they take tips', () => {
    expect(supportTemplateVars(artist, { takesTips: true, instagram: false }).link).toBe('https://unstream.stream/tip/kid-lightbulbs');
    expect(supportTemplateVars(artist, { takesTips: false, instagram: false }).link).toBe('https://unstream.stream/a/kid-lightbulbs');
  });
});

describe('ageInWords', () => {
  it('counts whole years up to the post date', () => {
    expect(ageInWords('2021-11-01', 'day', '2026-11-01')).toBe('five years ago');
    expect(ageInWords('2021-11-02', 'day', '2026-11-01')).toBe('four years ago');
    expect(ageInWords('2025-10-01', 'day', '2026-11-01')).toBe('a year ago');
    expect(ageInWords('2010-06-01', 'day', '2026-11-01')).toBe('16 years ago');
  });

  it('says nothing under a year', () => {
    expect(ageInWords('2026-01-01', 'day', '2026-11-01')).toBeNull();
  });
});

describe('whereToBuy', () => {
  const s = (platform: string) => ({ platform, offers: [] });

  it('puts the artist-paying platforms first and joins them as a sentence', () => {
    expect(whereToBuy([s('bandcamp')])).toBe('Bandcamp');
    expect(whereToBuy([s('bandcamp'), s('mirlo')])).toMatch(/^(Mirlo and Bandcamp|Bandcamp and Mirlo)$/);
    expect(whereToBuy([s('bandcamp'), s('mirlo'), s('faircamp'), s('jamcoop')])!.split(/, | and /)).toHaveLength(3);
  });

  it('never names Discogs, whose copies are mostly secondhand', () => {
    expect(whereToBuy([s('discogs'), s('bandcamp')])).toBe('Bandcamp');
    expect(whereToBuy([s('discogs')])).toBeNull();
  });
});

describe('DEFAULT_TEMPLATES', () => {
  it('has variants for every kind, all valid', () => {
    for (const kind of AUTOPOST_KINDS) {
      expect(DEFAULT_TEMPLATES[kind].length).toBeGreaterThan(0);
      for (const t of DEFAULT_TEMPLATES[kind]) expect(templateProblems(t), `${kind}: ${t}`).toEqual([]);
    }
  });

  it('can always post with the bare minimum: every kind’s last variant needs only name, title, where and link', () => {
    const bare = { name: 'Kid Lightbulbs', title: 'Lantern', where: 'Bandcamp', link: 'L' };
    for (const kind of AUTOPOST_KINDS) {
      const last = DEFAULT_TEMPLATES[kind][DEFAULT_TEMPLATES[kind].length - 1];
      expect(renderTemplate(last, bare), `${kind}: ${last}`).not.toBeNull();
    }
  });

  it('never puts an article before {type}', () => {
    for (const t of Object.values(DEFAULT_TEMPLATES).flat()) expect(t).not.toMatch(/\ban? \[?\{type\}/);
  });

  it('fits Bluesky’s 300 characters for a long title', () => {
    const long = release({ title: 'please please please listen to me i’m begging', note: 'Recorded over one winter in a small apartment.' });
    for (const kind of AUTOPOST_KINDS) {
      for (const t of DEFAULT_TEMPLATES[kind]) {
        const vars = kind === 'support'
          ? supportTemplateVars(artist, { takesTips: true, instagram: false })
          : releaseTemplateVars(long, artist, { postDate: '2026-11-06', instagram: false });
        const text = renderTemplate(t, vars);
        if (text) expect(text.length, text).toBeLessThanOrEqual(300);
      }
    }
  });
});
