import type { Source, SourceId, SearchResponse } from '../types';

export const sources: Record<SourceId, Source> = {
  bandcamp: {
    id: 'bandcamp',
    name: 'Bandcamp',
    description: 'Artist-friendly music marketplace',
    color: '#1da0c3',
    icon: '🎵',
    category: 'marketplace',
    hasEmbed: true,
    searchUrlTemplate: 'https://bandcamp.com/search?q={query}',
  },
  mirlo: {
    id: 'mirlo',
    name: 'Mirlo',
    description: 'Open source patronage platform',
    color: '#6366f1',
    icon: '🪺',
    category: 'marketplace',
    hasEmbed: false,
    searchUrlTemplate: 'https://mirlo.space/search?query={query}',
  },
  ampwall: {
    id: 'ampwall',
    name: 'Ampwall',
    description: 'Modern independent music platform',
    color: '#ef4444',
    icon: '🔊',
    category: 'marketplace',
    hasEmbed: false,
    searchUrlTemplate: 'https://ampwall.com/explore?searchStyle=search&query={query}',
    searchOnly: true,
  },
  bandwagon: {
    id: 'bandwagon',
    name: 'Bandwagon',
    description: 'ActivityPub-based music community',
    color: '#8b5cf6',
    icon: '🚐',
    category: 'decentralized',
    hasEmbed: false,
    searchUrlTemplate: 'https://bandwagon.fm/artists?q={query}',
  },
  faircamp: {
    id: 'faircamp',
    name: 'Faircamp',
    description: 'Decentralized static music sites',
    color: '#22c55e',
    icon: '🏕️',
    category: 'decentralized',
    hasEmbed: false,
    searchUrlTemplate: 'https://duckduckgo.com/?q=site:*.faircamp+{query}',
  },
  patreon: {
    id: 'patreon',
    name: 'Patreon',
    description: 'Creator subscription platform',
    color: '#ff424d',
    icon: '🎨',
    category: 'patronage',
    hasEmbed: false,
    searchUrlTemplate: 'https://www.patreon.com/search?q={query}',
  },
  buymeacoffee: {
    id: 'buymeacoffee',
    name: 'Buy Me a Coffee',
    description: 'Creator support platform',
    color: '#ffdd00',
    icon: '☕',
    category: 'patronage',
    hasEmbed: false,
    searchUrlTemplate: 'https://www.buymeacoffee.com/search?query={query}',
  },
  kofi: {
    id: 'kofi',
    name: 'Ko-fi',
    description: 'Creator tip jar and shop',
    color: '#29abe0',
    icon: '🍵',
    category: 'patronage',
    hasEmbed: false,
    searchUrlTemplate: 'https://duckduckgo.com/?q=site:ko-fi.com+{query}',
    searchOnly: true,
  },
  hoopla: {
    id: 'hoopla',
    name: 'Hoopla',
    description: 'Library streaming service',
    color: '#9333ea',
    icon: '🎧',
    category: 'library',
    hasEmbed: false,
    searchUrlTemplate: 'https://www.hoopladigital.com/search?q={query}&type=music',
  },
  qobuz: {
    id: 'qobuz',
    name: 'Qobuz',
    description: 'Hi-res music downloads store',
    color: '#0070f3',
    icon: '💿',
    category: 'marketplace',
    hasEmbed: false,
    searchUrlTemplate: 'https://www.qobuz.com/us-en/search/artists/{query}',
  },
};

export const sourceCategories = {
  marketplace: {
    name: 'Music Marketplaces',
    description: 'Buy music directly from artists',
    sources: ['bandcamp', 'mirlo', 'ampwall', 'qobuz'] as SourceId[],
  },
  patronage: {
    name: 'Patronage Platforms',
    description: 'Support artists directly',
    sources: ['patreon', 'buymeacoffee', 'kofi'] as SourceId[],
  },
  library: {
    name: 'Library Services',
    description: 'Access through your local library',
    sources: ['hoopla'] as SourceId[],
  },
  decentralized: {
    name: 'Decentralized',
    description: 'ActivityPub and self-hosted platforms',
    sources: ['bandwagon', 'faircamp'] as SourceId[],
  },
};

// Search all platforms via the unified API
export async function searchPlatforms(query: string): Promise<SearchResponse> {
  const params = new URLSearchParams({ query });

  try {
    const response = await fetch(`/api/search/sources?${params.toString()}`);
    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }
    return await response.json();
  } catch (error) {
    console.error('Failed to search platforms:', error);
    return {
      query,
      results: [],
    };
  }
}
