// Wikimedia Commons photos stand in for artists whose Bandcamp page can't be read (Zoë Keating
// is on a custom domain). The licence is the point: a CC BY / BY-SA photo shown without its
// author and licence is an infringement, so the failures worth locking out are a photo with no
// credit, a photo under a licence a credit doesn't satisfy, and a photo on the wrong card.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchCommonsPhoto, parseCommonsImageInfo, pickImageFilename } from '../../search/commons-photo';
import { attachCommonsPhoto, isCacheableMbResult, type AggregatedResult, type MbBioInput } from '../search-utils';

// GET commons.wikimedia.org/w/api.php?action=query&titles=File:Zoe Keating - Pop!Tech 2009 - Camden, ME.jpg
//   &prop=imageinfo&iiprop=url|extmetadata&iiurlwidth=330&iiextmetadatafilter=LicenseShortName|Artist
// on 2026-10-26, trimmed to the fields read.
function zoeKeatingImageInfo(extmetadata?: Record<string, { value: string }>, overrides: Record<string, string> = {}) {
  return {
    query: {
      pages: {
        '21167890': {
          imageinfo: [{
            thumburl: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/b/ba/Zoe_Keating_-_Pop%21Tech_2009_-_Camden%2C_ME.jpg/330px-Zoe_Keating_-_Pop%21Tech_2009_-_Camden%2C_ME.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail',
            descriptionurl: 'https://commons.wikimedia.org/wiki/File:Zoe_Keating_-_Pop!Tech_2009_-_Camden,_ME.jpg',
            extmetadata: extmetadata ?? {
              Artist: { value: '<a rel="nofollow" class="external text" href="https://www.flickr.com/people/40287103@N07">PopTech</a> from Camden, Maine and Brooklyn, NY, USA' },
              LicenseShortName: { value: 'CC BY-SA 2.0' },
            },
            ...overrides,
          }],
        },
      },
    },
  };
}

const ZOE_KEATING_PHOTO = {
  url: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/b/ba/Zoe_Keating_-_Pop%21Tech_2009_-_Camden%2C_ME.jpg/330px-Zoe_Keating_-_Pop%21Tech_2009_-_Camden%2C_ME.jpg',
  author: 'PopTech from Camden, Maine and Brooklyn, NY, USA',
  license: 'CC BY-SA 2.0',
  sourceUrl: 'https://commons.wikimedia.org/wiki/File:Zoe_Keating_-_Pop!Tech_2009_-_Camden,_ME.jpg',
};

describe('parseCommonsImageInfo', () => {
  it('reads the thumbnail, a plain-text author and the licence', () => {
    expect(parseCommonsImageInfo(zoeKeatingImageInfo())).toEqual(ZOE_KEATING_PHOTO);
  });

  it('skips a licence a credit line does not satisfy', () => {
    const gfdl = zoeKeatingImageInfo({ Artist: { value: 'PopTech' }, LicenseShortName: { value: 'GFDL' } });
    expect(parseCommonsImageInfo(gfdl)).toBeNull();
  });

  it('skips an attribution licence with no author to attribute', () => {
    const anonymous = zoeKeatingImageInfo({ LicenseShortName: { value: 'CC BY 4.0' } });
    expect(parseCommonsImageInfo(anonymous)).toBeNull();
  });

  it('accepts a public-domain photo with no author', () => {
    const publicDomain = zoeKeatingImageInfo({ LicenseShortName: { value: 'Public domain' } });
    expect(parseCommonsImageInfo(publicDomain)).toMatchObject({ author: '', license: 'Public domain' });
  });

  it('refuses image and source URLs off Wikimedia', () => {
    expect(parseCommonsImageInfo(zoeKeatingImageInfo(undefined, { thumburl: 'https://evil.example/x.jpg' }))).toBeNull();
    expect(parseCommonsImageInfo(zoeKeatingImageInfo(undefined, { descriptionurl: 'javascript:alert(1)' }))).toBeNull();
  });
});

describe('pickImageFilename', () => {
  it('takes the preferred image and never a deprecated one', () => {
    const claim = (value: string, rank: string) => ({ rank, mainsnak: { datavalue: { value } } });
    expect(pickImageFilename({ claims: { P18: [claim('old.jpg', 'normal'), claim('new.jpg', 'preferred')] } })).toBe('new.jpg');
    expect(pickImageFilename({ claims: { P18: [claim('wrong.jpg', 'deprecated')] } })).toBeNull();
    expect(pickImageFilename({ claims: {} })).toBeNull();
  });
});

describe('fetchCommonsPhoto', () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubFetch(...responses: Response[]) {
    const fetchMock = vi.fn();
    for (const response of responses) fetchMock.mockResolvedValueOnce(response);
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('follows Wikidata P18 to the Commons file', async () => {
    const fetchMock = stubFetch(
      Response.json({ claims: { P18: [{ rank: 'normal', mainsnak: { datavalue: { value: 'Zoe Keating - Pop!Tech 2009 - Camden, ME.jpg' } } }] } }),
      Response.json(zoeKeatingImageInfo()),
    );
    expect(await fetchCommonsPhoto('https://www.wikidata.org/wiki/Q227121')).toEqual({ status: 'found', photo: ZOE_KEATING_PHOTO });
    expect(String(fetchMock.mock.calls[0][0])).toContain('entity=Q227121&property=P18');
  });

  it('answers none, without a second request, for an item with no image', async () => {
    const fetchMock = stubFetch(Response.json({ claims: {} }));
    expect(await fetchCommonsPhoto('https://www.wikidata.org/wiki/Q227121')).toEqual({ status: 'none' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('answers failed, not none, when Wikimedia does not answer', async () => {
    stubFetch(new Response('', { status: 503 }));
    expect(await fetchCommonsPhoto('https://www.wikidata.org/wiki/Q227121')).toEqual({ status: 'failed' });
  });
});

describe('attachCommonsPhoto', () => {
  const mb: MbBioInput = {
    resultId: 'mb-zoekeating',
    discogsUrl: 'https://www.discogs.com/artist/209051',
    officialUrl: null,
    discogsProfile: null,
    wikipediaSummary: null,
    wikipediaUrl: null,
  };
  const card = (overrides: Partial<AggregatedResult> = {}): AggregatedResult =>
    ({ id: 'mb-zoekeating', name: 'Zoë Keating', type: 'artist', platforms: [], matchConfidence: 'verified', ...overrides });

  it('puts the photo only on the card MusicBrainz enriched', () => {
    const enriched = card();
    const homonym = card({ id: 'other' });
    attachCommonsPhoto([enriched, homonym], mb, ZOE_KEATING_PHOTO);
    expect(enriched.commonsPhoto).toEqual(ZOE_KEATING_PHOTO);
    expect(homonym.commonsPhoto).toBeUndefined();
  });

  it('never displaces a photo the card has, nor fills a claimed card', () => {
    const withPhoto = card({ imageUrl: 'https://f4.bcbits.com/img/1.jpg' });
    const claimed = card({ matchConfidence: 'claimed' });
    attachCommonsPhoto([withPhoto, claimed], mb, ZOE_KEATING_PHOTO);
    expect(withPhoto.commonsPhoto).toBeUndefined();
    expect(claimed.commonsPhoto).toBeUndefined();
  });
});

describe('isCacheableMbResult', () => {
  it('keeps an enrichment whose photo lookup failed out of the day-long cache', () => {
    const answered = { searchFailed: false, artistName: 'Zoë Keating', enrichmentComplete: true };
    expect(isCacheableMbResult(answered)).toBe(true);
    expect(isCacheableMbResult({ ...answered, photoFetchFailed: true })).toBe(false);
  });
});
