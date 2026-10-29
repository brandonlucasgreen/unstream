// @vitest-environment jsdom
// The top of each page an artist manages from /my-artists (Edit, Releases, Tips, Promote).
//
// What's worth locking: it says which page this is above the artist's name, and has the way back to
// My Artists and the link to the live profile. There are no tabs any more: since 2026-10-29 each
// page has its own button on the My Artists card.
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ArtistSettingsHeader } from 'src/components/ArtistSettingsHeader';

afterEach(cleanup);

describe('ArtistSettingsHeader', () => {
  it('names the page and the artist, with the way back and the live profile', () => {
    render(
      <MemoryRouter>
        <ArtistSettingsHeader slug="kid-lightbulbs" artistName="Kid Lightbulbs" section="releases" />
      </MemoryRouter>
    );
    expect(screen.getByText('Manage releases')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Kid Lightbulbs' })).toBeTruthy();
    expect(screen.getByRole('link', { name: /My Artists/ }).getAttribute('href')).toBe('/my-artists');
    expect(screen.getByRole('link', { name: 'View live profile' }).getAttribute('href')).toBe('/a/kid-lightbulbs');
    expect(screen.queryByRole('navigation')).toBeNull();
  });

  it('holds the heading’s place while the name loads', () => {
    render(
      <MemoryRouter>
        <ArtistSettingsHeader slug="kid-lightbulbs" section="tips" />
      </MemoryRouter>
    );
    expect(screen.getByText('Manage tips')).toBeTruthy();
    expect(screen.queryByRole('heading')).toBeNull();
  });
});
