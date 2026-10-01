// @vitest-environment jsdom
// The bio on a search-result card: plain text, a source link that says where it came from, and
// no link at all for a URL that isn't a web page.

import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { ResultCardBio } from 'src/components/ResultCardBio';
import type { ArtistBio } from 'src/types';

const bio: ArtistBio = { text: 'Experimental rock.\n\nFrom Brooklyn.', source: 'unstream', sourceUrl: 'https://unstream.stream/a/kid', truncated: false };

afterEach(cleanup);

describe('ResultCardBio', () => {
  it("gives a claimed artist's own bio no source line, since the card already links to their page", () => {
    const { container } = render(<ResultCardBio bio={bio} />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(container.textContent).not.toContain('From the artist');
    expect(screen.getByText('From Brooklyn.').tagName).toBe('P');
  });

  it('names the platform for a bio from elsewhere and links to it', () => {
    render(<ResultCardBio bio={{ ...bio, source: 'bandcamp', sourceUrl: 'https://kid.bandcamp.com' }} />);
    const link = screen.getByRole('link');
    expect(link.textContent).toBe('From Bandcamp ↗');
    expect(link.getAttribute('href')).toBe('https://kid.bandcamp.com');
  });

  it('names the platform and the licence for Wikipedia, and says when the text was cut', () => {
    render(<ResultCardBio bio={{ ...bio, source: 'wikipedia', sourceUrl: 'https://en.wikipedia.org/wiki/X', truncated: true }} />);
    expect(screen.getByRole('link').textContent).toBe('From Wikipedia · CC BY-SA · Read more ↗');
  });

  it('renders markup-looking text as text', () => {
    const { container } = render(<ResultCardBio bio={{ ...bio, text: '<img src=x onerror=alert(1)>' }} />);
    expect(container.querySelector('img')).toBeNull();
  });

  it('drops a non-web source URL', () => {
    render(<ResultCardBio bio={{ ...bio, source: 'bandcamp', sourceUrl: 'javascript:alert(1)' }} />);
    expect(screen.queryByRole('link')).toBeNull();
  });
});
