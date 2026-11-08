// @vitest-environment jsdom
// The top of each page an artist manages (Analytics, Edit, Releases, Tips, Promote).
//
// What's worth locking: one heading says which page and which artist, with the link to the live
// profile. There are no tabs (each page has had its own button since 2026-10-29), and no way back
// to My Artists: the header's artist menu reaches every page (2026-11-08).
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ArtistSettingsHeader } from 'src/components/ArtistSettingsHeader';

afterEach(cleanup);

describe('ArtistSettingsHeader', () => {
  it('names the page and the artist, with the live profile and no My Artists link', () => {
    render(
      <MemoryRouter>
        <ArtistSettingsHeader slug="kid-lightbulbs" artistName="Kid Lightbulbs" section="releases" />
      </MemoryRouter>
    );
    expect(screen.getByRole('heading', { name: 'Manage Releases: Kid Lightbulbs' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: /My Artists/ })).toBeNull();
    expect(screen.getByRole('link', { name: 'View live profile' }).getAttribute('href')).toBe('/a/kid-lightbulbs');
    expect(screen.queryByRole('navigation')).toBeNull();
  });

  it('holds the name’s place in the heading while it loads', () => {
    render(
      <MemoryRouter>
        <ArtistSettingsHeader slug="kid-lightbulbs" section="tips" />
      </MemoryRouter>
    );
    expect(screen.getByRole('heading').textContent?.trim()).toBe('Manage Tips:');
  });
});
