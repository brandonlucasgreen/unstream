// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { SourceBadge } from 'src/components/SourceBadge';
import type { Source } from 'src/types';

vi.mock('src/services/analytics', () => ({
  analytics: { trackPlatformClick: vi.fn() },
}));

vi.mock('src/components/PlatformIcon', () => ({
  PlatformIcon: () => <span data-testid="platform-icon" />,
}));

import { analytics } from 'src/services/analytics';

const bandcampSource: Source = {
  id: 'bandcamp',
  name: 'Bandcamp',
  color: '#1da0c3',
  icon: '🎵',
  category: 'marketplace',
  artistPayoutPercent: '80-85%',
  aiPolicy: 'formal',
  aiPolicyUrl: 'https://blog.bandcamp.com/2026/01/13/keeping-bandcamp-human/',
} as Source;

describe('SourceBadge AI policy badge', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('shows the badge on a non-marketplace platform that has a policy', () => {
    const kofiSource = {
      id: 'kofi',
      name: 'Ko-fi',
      color: '#29abe0',
      icon: '🍵',
      category: 'patronage',
      aiPolicy: 'formal',
      aiPolicyUrl: 'https://help.ko-fi.com/hc/en-us/articles/19789627403293-Ko-fi-s-stance-on-AI',
    } as Source;
    render(<SourceBadge source={kofiSource} url="https://ko-fi.com/some-artist" />);
    expect(screen.getByText('AI policy')).toBeTruthy();
  });

  it('shows no badge on a platform without a policy', () => {
    const { aiPolicy: _aiPolicy, aiPolicyUrl: _aiPolicyUrl, ...rest } = bandcampSource;
    render(<SourceBadge source={rest as Source} url="https://bandcamp.com/some-artist" />);
    expect(screen.queryByText('AI policy')).toBeNull();
  });

  it('does not nest an <a> inside the platform link', () => {
    render(<SourceBadge source={bandcampSource} url="https://bandcamp.com/some-artist" />);
    const outerLink = screen.getByText('Bandcamp').closest('a');
    expect(outerLink?.querySelector('a')).toBeNull();
  });

  it('tracks analytics and opens the policy URL on click, without triggering the outer link', () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    render(<SourceBadge source={bandcampSource} url="https://bandcamp.com/some-artist" />);

    const badge = screen.getByText('AI policy');
    fireEvent.click(badge);

    expect(analytics.trackPlatformClick).toHaveBeenCalledWith('Bandcamp AI policy');
    expect(openSpy).toHaveBeenCalledWith(bandcampSource.aiPolicyUrl, '_blank', 'noopener,noreferrer');

    openSpy.mockRestore();
  });

  it('tracks analytics and opens the policy URL on keyboard activation (Enter)', () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    render(<SourceBadge source={bandcampSource} url="https://bandcamp.com/some-artist" />);

    const badge = screen.getByText('AI policy');
    fireEvent.keyDown(badge, { key: 'Enter' });

    expect(analytics.trackPlatformClick).toHaveBeenCalledWith('Bandcamp AI policy');
    expect(openSpy).toHaveBeenCalledWith(bandcampSource.aiPolicyUrl, '_blank', 'noopener,noreferrer');

    openSpy.mockRestore();
  });

  it('tracks analytics and opens the policy URL on keyboard activation (Space)', () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    render(<SourceBadge source={bandcampSource} url="https://bandcamp.com/some-artist" />);

    const badge = screen.getByText('AI policy');
    fireEvent.keyDown(badge, { key: ' ' });

    expect(analytics.trackPlatformClick).toHaveBeenCalledWith('Bandcamp AI policy');
    expect(openSpy).toHaveBeenCalledWith(bandcampSource.aiPolicyUrl, '_blank', 'noopener,noreferrer');

    openSpy.mockRestore();
  });
});
