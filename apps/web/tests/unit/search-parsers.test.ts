import { describe, it, expect } from 'vitest';
import {
  parseBandcampSearchResults,
  parseMirloArtistPage,
  parseQobuzSearchResults,
  parseBandcampReleaseTitles,
  parseBandwagonSearchResults,
  parseJamcoopDirectory,
  parseFaircampReleaseTitles,
  parsePatreonSearchResults,
} from '../../../../api/functions/search-parsers';

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
// parseQobuzSearchResults
// ---------------------------------------------------------------------------

describe('parseQobuzSearchResults', () => {
  it('extracts interpreter links from Qobuz HTML', () => {
    const html = `
      <a href="/us-en/interpreter/kid-lightbulbs/12345">Kid Lightbulbs</a>
      <a href="/us-en/interpreter/kid-lightbulbs-2/67890">Kid Lightbulbs 2</a>
    `;
    const results = parseQobuzSearchResults(html, 'Kid Lightbulbs');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0][1]).toBe('https://www.qobuz.com/us-en/interpreter/kid-lightbulbs/12345');
  });

  it('matches numeric suffix variations (morice, morice2)', () => {
    const html = `
      <a href="/us-en/interpreter/morice/111">Morice</a>
      <a href="/us-en/interpreter/morice-2/222">Morice 2</a>
    `;
    const results = parseQobuzSearchResults(html, 'Morice');
    // "morice" exact match
    expect(results.some(([, url]) => url.includes('/morice/111'))).toBe(true);
  });

  it('rejects non-matching artists', () => {
    const html = `
      <a href="/us-en/interpreter/totally-different/999">Totally Different</a>
    `;
    const results = parseQobuzSearchResults(html, 'Kid Lightbulbs');
    expect(results).toHaveLength(0);
  });

  it('rejects partial name matches that are not numeric suffixes', () => {
    const html = `
      <a href="/us-en/interpreter/morice-el-blanco/333">Morice El Blanco</a>
    `;
    const results = parseQobuzSearchResults(html, 'Morice');
    // "moriceelblanco" starts with "morice" but suffix is not purely numeric
    expect(results).toHaveLength(0);
  });

  it('deduplicates by normalized name', () => {
    const html = `
      <a href="/us-en/interpreter/matt-young/111">Matt Young</a>
      <a href="/us-en/interpreter/matt-young/111">Matt Young</a>
    `;
    const results = parseQobuzSearchResults(html, 'Matt Young');
    expect(results).toHaveLength(1);
  });

  it('limits to 10 results', () => {
    let html = '';
    for (let i = 0; i < 15; i++) {
      html += `<a href="/us-en/interpreter/test${i}/00${i}">Test${i}</a>\n`;
    }
    const results = parseQobuzSearchResults(html, 'test');
    expect(results.length).toBeLessThanOrEqual(10);
  });

  it('handles empty HTML', () => {
    const results = parseQobuzSearchResults('<html></html>', 'test');
    expect(results).toEqual([]);
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
