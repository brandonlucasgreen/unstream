import { describe, it, expect } from 'vitest';
import {
  isBandcampChallenge,
  parseBandcampBandIdentity,
  parseBandcampImage,
  parseBandcampPageLocation,
  parseBandcampReleaseCounts,
  parseBandcampSearchResults,
  parseMirloArtistPage,
  parseBandcampReleaseTitles,
  parseBandwagonSearchResults,
  parseJamcoopDirectory,
  parseFaircampReleaseTitles,
  parsePatreonSearchResults,
} from '../../../../api/functions/search-parsers';

// ---------------------------------------------------------------------------
// isBandcampChallenge
// ---------------------------------------------------------------------------

describe('isBandcampChallenge', () => {
  // Trimmed from a real blocked response: HTTP 200, ~3KB, Fastly challenge assets.
  const challengeHTML = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta http-equiv="Content-Security-Policy"
      content="default-src 'self'; img-src 'self' data:; object-src 'none';" />
    <link href="/_fs-ch-1T1wmsGaOgGaSxcX/assets/inter-var.woff2" rel="preload" as="font" crossorigin />
    <link href="/_fs-ch-1T1wmsGaOgGaSxcX/assets/styles.css" rel="stylesheet" />
  </head>
  <body><div id="challenge"></div></body>
</html>`;

  it('detects a Fastly challenge interstitial', () => {
    expect(isBandcampChallenge(challengeHTML)).toBe(true);
  });

  it('does not flag real search-results HTML', () => {
    const real = `
      <div class="searchresult">
        <div class="result-info">
          <div class="itemtype">ARTIST</div>
          <div class="heading"><a href="https://kidlightbulbs.bandcamp.com">Kid Lightbulbs</a></div>
        </div>
      </div>`;
    expect(isBandcampChallenge(real)).toBe(false);
  });

  it('handles empty and whitespace input without throwing', () => {
    expect(isBandcampChallenge('')).toBe(false);
    expect(isBandcampChallenge('   ')).toBe(false);
  });

  it('does not flag a large real page that happens to contain the marker text', () => {
    // Real Bandcamp pages are 100KB+. The size pre-filter keeps a stray mention
    // (e.g. inside user-supplied bio text) from disabling a working scrape.
    const big = `<html><body>${'x'.repeat(30_000)}/_fs-ch-nope</body></html>`;
    expect(isBandcampChallenge(big)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseBandcampBandIdentity
// ---------------------------------------------------------------------------

describe('parseBandcampBandIdentity', () => {
  it('reads id and name from the HTML-escaped data-band attribute', () => {
    const html = `<div data-band="{&quot;id&quot;:2295933907,&quot;name&quot;:&quot;Boy Harsher&quot;}"></div>`;
    expect(parseBandcampBandIdentity(html)).toEqual({ id: 2295933907, name: 'Boy Harsher' });
  });

  it('surfaces a squatted account under its real name', () => {
    // thebeths.bandcamp.com resolves, but belongs to an account called "no content".
    // Returning the true name is what lets the caller reject it.
    const html = `<div data-band="{&quot;id&quot;:3801769277,&quot;name&quot;:&quot;no content&quot;}"></div>`;
    expect(parseBandcampBandIdentity(html)?.name).toBe('no content');
  });

  it('decodes escaped apostrophes and ampersands in names', () => {
    const html = `<div data-band="{&quot;id&quot;:1,&quot;name&quot;:&quot;Sam &amp; Dave&#39;s Band&quot;}"></div>`;
    expect(parseBandcampBandIdentity(html)?.name).toBe("Sam & Dave's Band");
  });

  it('returns null when the attribute is absent', () => {
    expect(parseBandcampBandIdentity('<html><body>nothing here</body></html>')).toBeNull();
  });

  it('returns null on malformed JSON rather than throwing', () => {
    expect(parseBandcampBandIdentity('<div data-band="{not json}"></div>')).toBeNull();
  });

  it('returns null when id or name has the wrong type', () => {
    const badId = `<div data-band="{&quot;id&quot;:&quot;123&quot;,&quot;name&quot;:&quot;X&quot;}"></div>`;
    const noName = `<div data-band="{&quot;id&quot;:123}"></div>`;
    expect(parseBandcampBandIdentity(badId)).toBeNull();
    expect(parseBandcampBandIdentity(noName)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseBandcampReleaseCounts
// ---------------------------------------------------------------------------

describe('parseBandcampReleaseCounts', () => {
  const musicPage = `
    <ol class="music-grid">
      <li class="music-grid-item" data-item-id="album-1507079760"><p class="title">GET MEAN</p></li>
      <li class="music-grid-item" data-item-id="album-181024544"><p class="title">Careful</p></li>
      <li class="music-grid-item" data-item-id="track-748933878"><p class="title">Jeans</p></li>
    </ol>`;

  it('counts albums and tracks separately', () => {
    expect(parseBandcampReleaseCounts(musicPage)).toEqual({ albums: 2, tracks: 1 });
  });

  it('reports zero for a parked account with no releases', () => {
    // The squatter signature: beyonce / sufjan / jackwhite all look like this.
    expect(parseBandcampReleaseCounts('<ol class="music-grid"></ol>')).toEqual({ albums: 0, tracks: 0 });
  });

  it('deduplicates repeated item ids', () => {
    const dupes = `
      <li class="music-grid-item" data-item-id="album-1"></li>
      <li class="music-grid-item" data-item-id="album-1"></li>`;
    expect(parseBandcampReleaseCounts(dupes)).toEqual({ albums: 1, tracks: 0 });
  });

  it('ignores grid items with no data-item-id and unknown prefixes', () => {
    const odd = `
      <li class="music-grid-item"></li>
      <li class="music-grid-item" data-item-id="merch-99"></li>
      <li class="music-grid-item" data-item-id="album-7"></li>`;
    expect(parseBandcampReleaseCounts(odd)).toEqual({ albums: 1, tracks: 0 });
  });

  it('ignores album links outside the music grid', () => {
    // Artist pages link to albums in navigation and footers; only grid items count.
    const withNav = `
      <a href="/album/somewhere-else">nav link</a>
      <li class="music-grid-item" data-item-id="album-7"></li>`;
    expect(parseBandcampReleaseCounts(withNav)).toEqual({ albums: 1, tracks: 0 });
  });
});

// ---------------------------------------------------------------------------
// parseBandcampPageLocation
// ---------------------------------------------------------------------------

describe('parseBandcampPageLocation', () => {
  it('reads the location element from a band page', () => {
    const html = `<div id="band-name-location">
      <span class="title">Boy Harsher</span>
      <span class="location secondaryText">Northampton, Massachusetts</span>
    </div>`;
    expect(parseBandcampPageLocation(html)).toBe('Northampton, Massachusetts');
  });

  it('collapses surrounding whitespace and newlines', () => {
    const html = `<p class="location">\n   Oxford,    UK  \n</p>`;
    expect(parseBandcampPageLocation(html)).toBe('Oxford, UK');
  });

  it('returns null when no location element is present', () => {
    // Legitimate: some artists set no location, and Bandcamp's own discover API
    // reports none for them either.
    expect(parseBandcampPageLocation('<div class="title">Some Band</div>')).toBeNull();
  });

  it('ignores a class that merely contains "location" as a substring', () => {
    expect(parseBandcampPageLocation('<p class="relocation-notice">moved</p>')).toBeNull();
  });

  it('rejects absurdly long matches rather than returning page junk', () => {
    const html = `<p class="location">${'x'.repeat(200)}</p>`;
    expect(parseBandcampPageLocation(html)).toBeNull();
  });

  it('returns null for an empty element', () => {
    expect(parseBandcampPageLocation('<p class="location">   </p>')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseBandcampImage
// ---------------------------------------------------------------------------

describe('parseBandcampImage', () => {
  it('reads the artist photo from og:image', () => {
    const html = `<meta property="og:image" content="https://f4.bcbits.com/img/0040867508_23.jpg">`;
    expect(parseBandcampImage(html)).toBe('https://f4.bcbits.com/img/0040867508_23.jpg');
  });

  it('returns null when there is no og:image', () => {
    expect(parseBandcampImage('<html><body>no meta here</body></html>')).toBeNull();
  });

  it("treats Bandcamp's blank.gif placeholder as no image", () => {
    // Otherwise every artist without a photo gets a 1x1 transparent gif as their avatar.
    const html = `<meta property="og:image" content="https://f4.bcbits.com/img/blank.gif">`;
    expect(parseBandcampImage(html)).toBeNull();
  });

  it('rejects a non-https value rather than emitting a mixed-content URL', () => {
    const html = `<meta property="og:image" content="http://f4.bcbits.com/img/1.jpg">`;
    expect(parseBandcampImage(html)).toBeNull();
  });

  it('trims surrounding whitespace', () => {
    const html = `<meta property="og:image" content="  https://f4.bcbits.com/img/2.jpg  ">`;
    expect(parseBandcampImage(html)).toBe('https://f4.bcbits.com/img/2.jpg');
  });
});

// ---------------------------------------------------------------------------
// parseBandcampSearchResults
// ---------------------------------------------------------------------------

describe('parseBandcampSearchResults', () => {
  const bandcampHTML = `
    <div class="searchresult">
      <div class="art"><img src="https://img.bandcamp.com/artist1.jpg"></div>
      <div class="result-info">
        <div class="itemtype">ARTIST</div>
        <div class="heading"><a href="https://kidlightbulbs.bandcamp.com">Kid Lightbulbs</a></div>
        <div class="subhead"></div>
      </div>
    </div>
    <div class="searchresult">
      <div class="art"><img src="https://img.bandcamp.com/album1.jpg"></div>
      <div class="result-info">
        <div class="itemtype">ALBUM</div>
        <div class="heading"><a href="https://kidlightbulbs.bandcamp.com/album/ruined-castle">Ruined Castle</a></div>
        <div class="subhead">by Kid Lightbulbs</div>
      </div>
    </div>
    <div class="searchresult">
      <div class="result-info">
        <div class="itemtype">TRACK</div>
        <div class="heading"><a href="https://kidlightbulbs.bandcamp.com/track/some-track">Some Track</a></div>
        <div class="subhead">by Kid Lightbulbs</div>
      </div>
    </div>
  `;

  it('parses artist results', () => {
    const results = parseBandcampSearchResults(bandcampHTML, 'Kid Lightbulbs');
    const artists = results.filter(r => r.type === 'artist');
    expect(artists).toHaveLength(1);
    expect(artists[0].name).toBe('Kid Lightbulbs');
    expect(artists[0].url).toBe('https://kidlightbulbs.bandcamp.com');
    expect(artists[0].imageUrl).toBe('https://img.bandcamp.com/artist1.jpg');
    expect(artists[0].sourceId).toBe('bandcamp');
  });

  it('parses album results with artist name', () => {
    const results = parseBandcampSearchResults(bandcampHTML, 'Kid Lightbulbs');
    const albums = results.filter(r => r.type === 'album');
    expect(albums).toHaveLength(1);
    expect(albums[0].name).toBe('Ruined Castle');
    expect(albums[0].artist).toBe('Kid Lightbulbs');
  });

  it('parses track results', () => {
    const results = parseBandcampSearchResults(bandcampHTML, 'Kid Lightbulbs');
    const tracks = results.filter(r => r.type === 'track');
    expect(tracks).toHaveLength(1);
    expect(tracks[0].type).toBe('track');
  });

  it('strips query string from URLs', () => {
    const html = `
      <div class="searchresult">
        <div class="result-info">
          <div class="itemtype">ARTIST</div>
          <div class="heading"><a href="https://test.bandcamp.com?from=search">Test</a></div>
        </div>
      </div>
    `;
    const results = parseBandcampSearchResults(html, 'Test');
    expect(results[0].url).toBe('https://test.bandcamp.com');
  });

  it('extracts artist from "by " prefix in subhead', () => {
    const html = `
      <div class="searchresult">
        <div class="result-info">
          <div class="itemtype">ALBUM</div>
          <div class="heading"><a href="https://a.bandcamp.com/album/x">My Album</a></div>
          <div class="subhead">by Some Artist</div>
        </div>
      </div>
    `;
    const results = parseBandcampSearchResults(html, 'Some Artist');
    expect(results[0].artist).toBe('Some Artist');
  });

  it('filters out fan profiles (bandcamp.com/username)', () => {
    const html = `
      <div class="searchresult">
        <div class="result-info">
          <div class="itemtype">ARTIST</div>
          <div class="heading"><a href="https://bandcamp.com/fanuser">Fan User</a></div>
        </div>
      </div>
      <div class="searchresult">
        <div class="result-info">
          <div class="itemtype">ARTIST</div>
          <div class="heading"><a href="https://realartist.bandcamp.com">Real Artist</a></div>
        </div>
      </div>
    `;
    const results = parseBandcampSearchResults(html, 'artist');
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('Real Artist');
  });

  it('filters out fuzzy matches that do not match the query', () => {
    const html = `
      <div class="searchresult">
        <div class="result-info">
          <div class="itemtype">ARTIST</div>
          <div class="heading"><a href="https://totallyunrelated.bandcamp.com">Totally Unrelated</a></div>
        </div>
      </div>
    `;
    const results = parseBandcampSearchResults(html, 'Kid Lightbulbs');
    expect(results).toHaveLength(0);
  });

  it('handles empty HTML', () => {
    const results = parseBandcampSearchResults('<html></html>', 'test');
    expect(results).toEqual([]);
  });

  it('limits results to 10', () => {
    let html = '';
    for (let i = 0; i < 15; i++) {
      html += `
        <div class="searchresult">
          <div class="result-info">
            <div class="itemtype">ARTIST</div>
            <div class="heading"><a href="https://testartist.bandcamp.com">Test Artist</a></div>
          </div>
        </div>
      `;
    }
    const results = parseBandcampSearchResults(html, 'Test Artist');
    expect(results.length).toBeLessThanOrEqual(10);
  });
});

// ---------------------------------------------------------------------------
// parseMirloArtistPage
// ---------------------------------------------------------------------------

describe('parseMirloArtistPage', () => {
  it('returns result when og:title matches query', () => {
    // Note: parseMirloArtistPage checks ogTitle.includes(normalizedQuery.substring(0, 4))
    // For "kidlightbulbs", substring(0,4) is "kidl"
    // og:title lowercased must contain "kidl" — "kidlightbulbs" does (no space)
    const html = `
      <html><head>
        <meta property="og:title" content="KidLightbulbs">
        <meta property="og:image" content="https://img.mirlo.space/artist.jpg">
      </head></html>
    `;
    const result = parseMirloArtistPage(html, 'kidlightbulbs', 'https://mirlo.space/kidlightbulbs');
    expect(result).not.toBeNull();
    expect(result!.name).toBe('KidLightbulbs');
    expect(result!.sourceId).toBe('mirlo');
    expect(result!.imageUrl).toBe('https://img.mirlo.space/artist.jpg');
    expect(result!.url).toBe('https://mirlo.space/kidlightbulbs');
  });

  it('returns null when og:title has spaces that break prefix check', () => {
    // "kid lightbulbs" lowercased does NOT include "kidl" (space breaks it)
    const html = `
      <html><head>
        <meta property="og:title" content="Kid Lightbulbs">
      </head></html>
    `;
    const result = parseMirloArtistPage(html, 'kidlightbulbs', 'https://mirlo.space/kidlightbulbs');
    expect(result).toBeNull();
  });

  it('returns null when og:title is "Mirlo" (artist does not exist)', () => {
    const html = `<html><head><meta property="og:title" content="Mirlo"></head></html>`;
    const result = parseMirloArtistPage(html, 'nonexistent', 'https://mirlo.space/nonexistent');
    expect(result).toBeNull();
  });

  it('returns null when og:title does not contain query prefix', () => {
    const html = `<html><head><meta property="og:title" content="Totally Different"></head></html>`;
    const result = parseMirloArtistPage(html, 'kidlightbulbs', 'https://mirlo.space/kidlightbulbs');
    expect(result).toBeNull();
  });

  it('returns null when no og:title is present', () => {
    const html = `<html><head></head></html>`;
    const result = parseMirloArtistPage(html, 'test', 'https://mirlo.space/test');
    expect(result).toBeNull();
  });

  it('handles missing og:image gracefully', () => {
    const html = `<html><head><meta property="og:title" content="Test Artist"></head></html>`;
    const result = parseMirloArtistPage(html, 'test', 'https://mirlo.space/test');
    expect(result).not.toBeNull();
    expect(result!.imageUrl).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// parseBandcampReleaseTitles
// ---------------------------------------------------------------------------

describe('parseBandcampReleaseTitles', () => {
  it('extracts release titles from music grid', () => {
    const html = `
      <div class="music-grid-item"><p class="title">Ruined Castle</p></div>
      <div class="music-grid-item"><p class="title">Some EP</p></div>
    `;
    const titles = parseBandcampReleaseTitles(html);
    expect(titles).toHaveLength(2);
    expect(titles[0]).toBe('ruinedcastle');
    expect(titles[1]).toBe('someep');
  });

  it('normalizes titles for comparison', () => {
    const html = `<div class="music-grid-item"><p class="title">My Album (Deluxe)</p></div>`;
    const titles = parseBandcampReleaseTitles(html);
    expect(titles[0]).toBe('myalbumdeluxe');
  });

  it('limits to 20 releases', () => {
    let html = '';
    for (let i = 0; i < 25; i++) {
      html += `<div class="music-grid-item"><p class="title">Release ${i}</p></div>\n`;
    }
    const titles = parseBandcampReleaseTitles(html);
    expect(titles).toHaveLength(20);
  });

  it('handles empty page', () => {
    const titles = parseBandcampReleaseTitles('<html></html>');
    expect(titles).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// parseBandwagonSearchResults
// ---------------------------------------------------------------------------

describe('parseBandwagonSearchResults', () => {
  it('extracts matching artist links', () => {
    const html = `
      <a href="https://bandwagon.fm/@kidlightbulbs">
        <div class="bold">Kid Lightbulbs</div>
      </a>
    `;
    const results = parseBandwagonSearchResults(html, 'Kid Lightbulbs');
    expect(results.size).toBe(1);
    expect(results.get('kidlightbulbs')).toBe('https://bandwagon.fm/@kidlightbulbs');
  });

  it('rejects non-matching artists', () => {
    const html = `
      <a href="https://bandwagon.fm/@unrelated">
        <div class="bold">Completely Different</div>
      </a>
    `;
    const results = parseBandwagonSearchResults(html, 'Kid Lightbulbs');
    expect(results.size).toBe(0);
  });

  it('deduplicates by href', () => {
    const html = `
      <a href="https://bandwagon.fm/@artist1">
        <div class="bold">Artist One</div>
      </a>
      <a href="https://bandwagon.fm/@artist1">
        <div class="bold">Artist One</div>
      </a>
    `;
    const results = parseBandwagonSearchResults(html, 'Artist One');
    expect(results.size).toBe(1);
  });

  it('filters out names longer than 100 characters', () => {
    const longName = 'A'.repeat(101);
    const html = `
      <a href="https://bandwagon.fm/@long">
        <div class="bold">${longName}</div>
      </a>
    `;
    const results = parseBandwagonSearchResults(html, longName);
    expect(results.size).toBe(0);
  });

  it('handles empty HTML', () => {
    const results = parseBandwagonSearchResults('<html></html>', 'test');
    expect(results.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// parseJamcoopDirectory
// ---------------------------------------------------------------------------

describe('parseJamcoopDirectory', () => {
  it('extracts artist links from directory HTML', () => {
    const html = `
      <a href="/artists/kid-lightbulbs">Kid Lightbulbs</a>
      <a href="/artists/some-band">Some Band</a>
    `;
    const directory = parseJamcoopDirectory(html);
    expect(directory.size).toBe(2);
    expect(directory.get('kidlightbulbs')?.url).toBe('https://jam.coop/artists/kid-lightbulbs');
    expect(directory.get('kidlightbulbs')?.name).toBe('Kid Lightbulbs');
  });

  it('skips the /artists root link', () => {
    const html = `
      <a href="/artists">All Artists</a>
      <a href="/artists/real-artist">Real Artist</a>
    `;
    const directory = parseJamcoopDirectory(html);
    expect(directory.size).toBe(1);
    expect(directory.has('allartists')).toBe(false);
  });

  it('deduplicates by normalized name', () => {
    const html = `
      <a href="/artists/test1">Test Artist</a>
      <a href="/artists/test2">Test Artist</a>
    `;
    const directory = parseJamcoopDirectory(html);
    expect(directory.size).toBe(1);
  });

  it('handles empty HTML', () => {
    const directory = parseJamcoopDirectory('<html></html>');
    expect(directory.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// parseFaircampReleaseTitles
// ---------------------------------------------------------------------------

describe('parseFaircampReleaseTitles', () => {
  it('extracts titles from release divs (second <a> is the title)', () => {
    const html = `
      <div class="release">
        <a href="/cover"><img src="cover.jpg"></a>
        <a href="/release/1">My Album</a>
      </div>
      <div class="release">
        <a href="/cover"><img src="cover2.jpg"></a>
        <a href="/release/2">Another EP</a>
      </div>
    `;
    const titles = parseFaircampReleaseTitles(html);
    expect(titles).toHaveLength(2);
    expect(titles[0]).toBe('myalbum');
    expect(titles[1]).toBe('anotherep');
  });

  it('skips releases with fewer than 2 links', () => {
    const html = `
      <div class="release">
        <a href="/only-one-link">Only One</a>
      </div>
    `;
    const titles = parseFaircampReleaseTitles(html);
    expect(titles).toHaveLength(0);
  });

  it('handles empty HTML', () => {
    const titles = parseFaircampReleaseTitles('<html></html>');
    expect(titles).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// parsePatreonSearchResults
// ---------------------------------------------------------------------------

describe('parsePatreonSearchResults', () => {
  it('extracts creator name and URL from campaign documents', () => {
    const data = {
      data: [
        {
          type: 'campaign-document',
          attributes: {
            creator_name: 'Kid Lightbulbs',
            url: 'https://www.patreon.com/KidLightbulbs',
          },
        },
      ],
    };
    const results = parsePatreonSearchResults(data);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]).toEqual(['kidlightbulbs', 'https://www.patreon.com/KidLightbulbs']);
  });

  it('indexes by both creator name and URL slug when they differ', () => {
    const data = {
      data: [
        {
          type: 'campaign-document',
          attributes: {
            creator_name: 'Mo-Rice',
            // URL slug "MoRiceMusic" normalizes to "moricemusic" which differs from "morice"
            url: 'https://www.patreon.com/MoRiceMusic',
          },
        },
      ],
    };
    const results = parsePatreonSearchResults(data);
    const names = results.map(([name]) => name);
    expect(names).toContain('morice');
    expect(names).toContain('moricemusic');
  });

  it('deduplicates when name and slug normalize the same', () => {
    const data = {
      data: [
        {
          type: 'campaign-document',
          attributes: {
            // "Mo-Rice" normalizes to "morice", slug "Mo_Rice" also normalizes to "morice"
            creator_name: 'Mo-Rice',
            url: 'https://www.patreon.com/Mo_Rice',
          },
        },
      ],
    };
    const results = parsePatreonSearchResults(data);
    // Both normalize to "morice" so only one entry
    expect(results).toHaveLength(1);
    expect(results[0][0]).toBe('morice');
  });

  it('skips non-campaign-document entries', () => {
    const data = {
      data: [
        {
          type: 'other-type',
          attributes: {
            creator_name: 'Should Skip',
            url: 'https://www.patreon.com/skip',
          },
        },
      ],
    };
    const results = parsePatreonSearchResults(data);
    expect(results).toHaveLength(0);
  });

  it('deduplicates by normalized name', () => {
    const data = {
      data: [
        {
          type: 'campaign-document',
          attributes: { creator_name: 'Test', url: 'https://www.patreon.com/test' },
        },
        {
          type: 'campaign-document',
          attributes: { creator_name: 'Test', url: 'https://www.patreon.com/test2' },
        },
      ],
    };
    const results = parsePatreonSearchResults(data);
    // First "test" name is used, second is deduplicated
    const nameEntries = results.filter(([name]) => name === 'test');
    expect(nameEntries).toHaveLength(1);
  });

  it('handles empty data', () => {
    const results = parsePatreonSearchResults({ data: [] });
    expect(results).toEqual([]);
  });

  it('handles missing data field', () => {
    const results = parsePatreonSearchResults({});
    expect(results).toEqual([]);
  });

  it('limits to 20 results', () => {
    const campaigns = [];
    for (let i = 0; i < 25; i++) {
      campaigns.push({
        type: 'campaign-document',
        attributes: {
          creator_name: `Artist ${i}`,
          url: `https://www.patreon.com/artist${i}`,
        },
      });
    }
    const results = parsePatreonSearchResults({ data: campaigns });
    expect(results.length).toBeLessThanOrEqual(20);
  });
});
