// Reading the artist's own bio out of a Bandcamp page the probe already fetched.

import { describe, it, expect } from 'vitest';
import { parseBandcampBio } from '../search-parsers';
import { makeBio } from '../../shared/artist-bio';

// The band sidebar as Bandcamp renders it: the first lines visible, the rest in a
// peekaboo span behind a "more" link.
const SIDEBAR = `
<div id="bio-container" class="bio-container">
  <p id="band-name-location">
    <span class="title">Kid Lightbulbs</span>
    <span class="location secondaryText">Brooklyn, New York</span>
  </p>
  <div class="signed-out-artists-bio-text">
    <p id="bio-text">
            Experimental &amp; alternative rock from Brooklyn.<br><br>Songs about
            <span class="peekaboo-text lightboxed">light, noise and the people who make it.</span><span class="peekaboo-ellipsis">...</span>
    </p>
    <a class="peekaboo-link"><span class="peekaboo-link-text">more</span></a>
  </div>
</div>`;

describe('parseBandcampBio', () => {
  it('reads the whole bio, hidden part included, without the ellipsis or "more" chrome', () => {
    const bio = makeBio('bandcamp', parseBandcampBio(SIDEBAR), 'https://kidlightbulbs.bandcamp.com');
    expect(bio?.text).toBe('Experimental & alternative rock from Brooklyn.\n\nSongs about light, noise and the people who make it.');
  });

  it("returns '' for a page with no bio — checked and empty, not unknown", () => {
    expect(parseBandcampBio('<div id="bio-container"><p id="band-name-location"></p></div>')).toBe('');
  });
});
