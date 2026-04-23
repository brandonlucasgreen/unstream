import type { LatestRelease, SourceId } from '../types';

export interface EmbedData {
  embedUrl: string;
  title: string;
}

export interface CategorizedPlatforms {
  marketplace: PlatformItem[];
  patronage: PlatformItem[];
  library: PlatformItem[];
  decentralized: PlatformItem[];
  official: PlatformItem[];
  social: PlatformItem[];
  curated: PlatformItem[];
}

export interface PlatformItem {
  sourceId: SourceId;
  url: string;
  latestRelease?: LatestRelease;
  displayName?: string;
}
