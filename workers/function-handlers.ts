// Every function handler the Worker can run, by the name netlify.toml used.
//
// Static imports on purpose. Workers can only resolve an `import()` whose specifier is a literal,
// so a name-to-module lookup has to be spelled out somewhere; spelled out here, `workers/
// __tests__/routes.test.ts` can check the table against the routes and against the files on disk,
// and a handler that loses its route (or a route that loses its handler) fails the build rather
// than 404ing in production.
//
// The whole map is in one bundle, so every request parses all of it. That is the normal Workers
// shape — isolates are reused and compiled code is cached — and it is what makes the routing
// decision a plain object lookup instead of a deploy-time fan-out of 66 Workers.

import { handler as adminArtistDuplicates } from '../api/functions/admin-artist-duplicates.ts';
import { handler as adminCatalogArtist } from '../api/functions/admin-catalog-artist.ts';
import { handler as adminFlags } from '../api/functions/admin-flags.ts';
import { handler as adminLinkSuppression } from '../api/functions/admin-link-suppression.ts';
import { handler as adminMergeOverride } from '../api/functions/admin-merge-override.ts';
import { handler as adminReleaseReview } from '../api/functions/admin-release-review.ts';
import { handler as adminTips } from '../api/functions/admin-tips.ts';
import { handler as adminVerify } from '../api/functions/admin-verify.ts';
import { handler as analyticsAppEvent } from '../api/functions/analytics-app-event.ts';
import { handler as analyticsDashboard } from '../api/functions/analytics-dashboard.ts';
import { handler as analyticsEvent } from '../api/functions/analytics-event.ts';
import { handler as analyticsStats } from '../api/functions/analytics-stats.ts';
import { handler as apiKeyGenerate } from '../api/functions/api-key-generate.ts';
import { handler as apiStatus } from '../api/functions/api-status.ts';
import { handler as artistAuth } from '../api/functions/artist-auth.ts';
import { handler as artistDirectory } from '../api/functions/artist-directory.ts';
import { handler as artistLookup } from '../api/functions/artist-lookup.ts';
import { handler as artistLookupV1 } from '../api/functions/artist-lookup-v1.ts';
import { handler as artistPage } from '../api/functions/artist-page.ts';
import { handler as artistProfile } from '../api/functions/artist-profile.ts';
import { handler as artistReleases } from '../api/functions/artist-releases.ts';
import { handler as bandcampSyncBackground } from '../api/functions/bandcamp-sync-background.ts';
import { handler as catalogArtistBackground } from '../api/functions/catalog-artist-background.ts';
import { handler as checkReleases } from '../api/functions/check-releases.ts';
import { handler as claimArtist } from '../api/functions/claim-artist.ts';
import { handler as collectionArt } from '../api/functions/collection-art.ts';
import { handler as desktopAppcast } from '../api/functions/desktop-appcast.ts';
import { handler as desktopVersion } from '../api/functions/desktop-version.ts';
import { handler as digestFeed } from '../api/functions/digest-feed.ts';
import { handler as embedBandcamp } from '../api/functions/embed-bandcamp.ts';
import { handler as feedReleases } from '../api/functions/feed-releases.ts';
import { handler as meBandcamp } from '../api/functions/me-bandcamp.ts';
import { handler as meCollection } from '../api/functions/me-collection.ts';
import { handler as meEmail } from '../api/functions/me-email.ts';
import { handler as meEmailConfirm } from '../api/functions/me-email-confirm.ts';
import { handler as meFeedToken } from '../api/functions/me-feed-token.ts';
import { handler as meListening } from '../api/functions/me-listening.ts';
import { handler as meLocation } from '../api/functions/me-location.ts';
import { handler as meNotifications } from '../api/functions/me-notifications.ts';
import { handler as mePassword } from '../api/functions/me-password.ts';
import { handler as meRecentReleases } from '../api/functions/me-recent-releases.ts';
import { handler as meSettings } from '../api/functions/me-settings.ts';
import { handler as meTips } from '../api/functions/me-tips.ts';
import { handler as meUsername } from '../api/functions/me-username.ts';
import { handler as newsletterSubscribe } from '../api/functions/newsletter-subscribe.ts';
import { handler as persistSearchResultsBackground } from '../api/functions/persist-search-results-background.ts';
import { handler as platformsList } from '../api/functions/platforms-list.ts';
import { handler as publicSavedArtists } from '../api/functions/public-saved-artists.ts';
import { handler as recatalogSweep } from '../api/functions/recatalog-sweep.ts';
import { handler as releaseDetail } from '../api/functions/release-detail.ts';
import { handler as resolveUrl } from '../api/functions/resolve-url.ts';
import { handler as resolveUrlV1 } from '../api/functions/resolve-url-v1.ts';
import { handler as savedArtists } from '../api/functions/saved-artists.ts';
import { handler as savedArtistsSync } from '../api/functions/saved-artists-sync.ts';
import { handler as searchMusicbrainz } from '../api/functions/search-musicbrainz.ts';
import { handler as searchSources } from '../api/functions/search-sources.ts';
import { handler as searchSourcesV1 } from '../api/functions/search-sources-v1.ts';
import { handler as searchStored } from '../api/functions/search-stored.ts';
import { handler as searchSuggest } from '../api/functions/search-suggest.ts';
import { handler as tipsCheckout } from '../api/functions/tips-checkout.ts';
import { handler as tipsConnect } from '../api/functions/tips-connect.ts';
import { handler as tipsReviewNotify } from '../api/functions/tips-review-notify.ts';
import { handler as tipsSettings } from '../api/functions/tips-settings.ts';
import { handler as tipsWebhook } from '../api/functions/tips-webhook.ts';
import { handler as userSharing } from '../api/functions/user-sharing.ts';
import { handler as weeklyAnalyticsRecap } from '../api/functions/weekly-analytics-recap.ts';
import type { FunctionHandler, FunctionResult } from './function-adapter.ts';

/**
 * `social-card` is deliberately absent.
 *
 * It reads its fonts off disk with `readFileSync` and loads resvg's WebAssembly binary, neither
 * of which a Worker has. It is also already on its way out: #649 moved card drawing into the
 * weekly generator, and the endpoint is kept only until the last Buffer post scheduled against
 * it has published (see the header of api/functions/social-card.ts). Until then `/api/social-card/*`
 * is proxied to the Netlify site, which stays up through the cutover window anyway for rollback —
 * see PROXIED_TO_NETLIFY in workers/index.ts. When the function goes, so do both.
 */
/**
 * Each handler declares its own narrow view of the event — some say `body?: string`, some say
 * `queryStringParameters?: Record<string, string>` — because each was written against the fields
 * it happened to need. `FunctionEvent` is the full shape, and the truthful one: Lambda really did
 * deliver `body` as `null` when there wasn't one, and really did allow a missing query parameter.
 * Passing the wider, more honest event to a narrower declaration is safe, but it is parameter
 * contravariance, which `strictFunctionTypes` rejects.
 *
 * So the table is declared with the parameter waived once, here, and nowhere else. Return types
 * are still checked — a handler that stopped returning a `{ statusCode, ... }` would still fail
 * the build — and the cast below only restores the callable signature the Worker uses.
 */
type HandlerWithAnyEventShape = (event: never) => Promise<FunctionResult | undefined>;

const HANDLERS = {
  'admin-artist-duplicates': adminArtistDuplicates,
  'admin-catalog-artist': adminCatalogArtist,
  'admin-flags': adminFlags,
  'admin-link-suppression': adminLinkSuppression,
  'admin-merge-override': adminMergeOverride,
  'admin-release-review': adminReleaseReview,
  'admin-tips': adminTips,
  'admin-verify': adminVerify,
  'analytics-app-event': analyticsAppEvent,
  'analytics-dashboard': analyticsDashboard,
  'analytics-event': analyticsEvent,
  'analytics-stats': analyticsStats,
  'api-key-generate': apiKeyGenerate,
  'api-status': apiStatus,
  'artist-auth': artistAuth,
  'artist-directory': artistDirectory,
  'artist-lookup': artistLookup,
  'artist-lookup-v1': artistLookupV1,
  'artist-page': artistPage,
  'artist-profile': artistProfile,
  'artist-releases': artistReleases,
  'bandcamp-sync-background': bandcampSyncBackground,
  'catalog-artist-background': catalogArtistBackground,
  'check-releases': checkReleases,
  'claim-artist': claimArtist,
  'collection-art': collectionArt,
  'desktop-appcast': desktopAppcast,
  'desktop-version': desktopVersion,
  'digest-feed': digestFeed,
  'embed-bandcamp': embedBandcamp,
  'feed-releases': feedReleases,
  'me-bandcamp': meBandcamp,
  'me-collection': meCollection,
  'me-email': meEmail,
  'me-email-confirm': meEmailConfirm,
  'me-feed-token': meFeedToken,
  'me-listening': meListening,
  'me-location': meLocation,
  'me-notifications': meNotifications,
  'me-password': mePassword,
  'me-recent-releases': meRecentReleases,
  'me-settings': meSettings,
  'me-tips': meTips,
  'me-username': meUsername,
  'newsletter-subscribe': newsletterSubscribe,
  'persist-search-results-background': persistSearchResultsBackground,
  'platforms-list': platformsList,
  'public-saved-artists': publicSavedArtists,
  'recatalog-sweep': recatalogSweep,
  'release-detail': releaseDetail,
  'resolve-url': resolveUrl,
  'resolve-url-v1': resolveUrlV1,
  'saved-artists': savedArtists,
  'saved-artists-sync': savedArtistsSync,
  'search-musicbrainz': searchMusicbrainz,
  'search-sources': searchSources,
  'search-sources-v1': searchSourcesV1,
  'search-stored': searchStored,
  'search-suggest': searchSuggest,
  'tips-checkout': tipsCheckout,
  'tips-connect': tipsConnect,
  'tips-review-notify': tipsReviewNotify,
  'tips-settings': tipsSettings,
  'tips-webhook': tipsWebhook,
  'user-sharing': userSharing,
  'weekly-analytics-recap': weeklyAnalyticsRecap,
} satisfies Record<string, HandlerWithAnyEventShape>;

export const FUNCTION_HANDLERS = HANDLERS as unknown as Record<string, FunctionHandler>;
