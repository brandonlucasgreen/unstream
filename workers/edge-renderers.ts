// The server-rendered pages, by the name netlify.toml's `[[edge_functions]]` used.
//
// Static imports for the same reason as workers/function-handlers.ts: a literal specifier is the
// only kind a Worker can resolve, and spelling the table out lets the route test check it.

import artistPageStatic from '../api/edge/artist-page-static.ts';
import noscriptSearch from '../api/edge/noscript-search.ts';
import ogMetadata from '../api/edge/og-metadata.ts';
import releasePage from '../api/edge/release-page.ts';
import staticPageMeta from '../api/edge/static-page-meta.ts';
import tipPageMeta from '../api/edge/tip-page-meta.ts';
import uHandle from '../api/edge/u-handle.ts';

import type { EdgeRenderer } from '../api/shared/edge-context.ts';

export const EDGE_RENDERERS: Record<string, EdgeRenderer> = {
  'artist-page-static': artistPageStatic,
  'noscript-search': noscriptSearch,
  'og-metadata': ogMetadata,
  'release-page': releasePage,
  'static-page-meta': staticPageMeta,
  'tip-page-meta': tipPageMeta,
  'u-handle': uHandle,
};
