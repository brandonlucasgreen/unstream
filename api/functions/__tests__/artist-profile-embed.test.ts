import { describe, it, expect } from 'vitest';
import { sanitizeEmbed } from '../artist-profile';

// A rejected embed used to be saved as null and reported as a success, so a
// pasted Faircamp/unsupported embed silently vanished on reload. These pin
// down: trusted platforms still pass, an artist's own linked domain (e.g. a
// self-hosted Faircamp site) is now accepted, and everything else is still
// rejected rather than silently accepted.

describe('sanitizeEmbed', () => {
  it('accepts a Bandcamp embed', () => {
    const html = '<iframe style="border: 0; width: 350px; height: 470px;" src="https://bandcamp.com/EmbeddedPlayer/album=123/size=large/" seamless></iframe>';
    expect(sanitizeEmbed(html)).toContain('src="https://bandcamp.com/EmbeddedPlayer/album=123/size=large/"');
  });

  it('accepts a Spotify embed', () => {
    const html = '<iframe src="https://open.spotify.com/embed/track/abc123" width="100%" height="152"></iframe>';
    expect(sanitizeEmbed(html)).toContain('open.spotify.com');
  });

  it('rejects a self-hosted domain with no owned-link match', () => {
    const html = '<iframe src="https://cult.example-artist.com/embed/release/"></iframe>';
    expect(sanitizeEmbed(html)).toBeNull();
  });

  it('accepts a self-hosted domain that matches one of the artist\'s own links', () => {
    const html = '<iframe src="https://cult.example-artist.com/embed/release/"></iframe>';
    expect(sanitizeEmbed(html, ['cult.example-artist.com'])).toContain('cult.example-artist.com');
  });

  it('does not let an owned hostname bypass the https requirement', () => {
    const html = '<iframe src="http://cult.example-artist.com/embed/release/"></iframe>';
    expect(sanitizeEmbed(html, ['cult.example-artist.com'])).toBeNull();
  });

  it('rejects an unrelated domain even when the artist owns other links', () => {
    const html = '<iframe src="https://evil.example.com/x"></iframe>';
    expect(sanitizeEmbed(html, ['cult.example-artist.com'])).toBeNull();
  });

  it('returns null for empty input without throwing', () => {
    expect(sanitizeEmbed(null)).toBeNull();
    expect(sanitizeEmbed('')).toBeNull();
    expect(sanitizeEmbed('   ')).toBeNull();
  });

  it('returns null when there is no iframe tag at all', () => {
    expect(sanitizeEmbed('https://bandcamp.com/EmbeddedPlayer/album=123/')).toBeNull();
  });
});
