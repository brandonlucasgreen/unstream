import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import { sentryVitePlugin } from '@sentry/vite-plugin'
import { handleApiRequest } from './server/api'
import { cpSync, existsSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Load env based on mode
const env = loadEnv(process.env.NODE_ENV || 'development', process.cwd(), '')

// Sentry DSN from environment (optional)
const sentryDsn = env.VITE_SENTRY_DSN || env.SENTRY_DSN
const sentryEnabled = !!sentryDsn

// Validate DSN format if provided
if (sentryEnabled && sentryDsn && !sentryDsn.startsWith('https://')) {
  console.warn('⚠️  Sentry DSN should start with https://')
}

// Warn if Sentry is enabled but auth token is missing
if (sentryEnabled && !env.SENTRY_AUTH_TOKEN) {
  console.warn('⚠️  SENTRY_AUTH_TOKEN is not set. Source map upload will fail.')
}

// The Sentry release, injected as VITE_APP_VERSION. Netlify exposes the deployed
// commit as COMMIT_REF at build time; without it every event reports release
// 'unknown', which makes the deploy-shaped errors unattributable — a tab running
// an old build asking for that build's chunks is only diagnosable if you can see
// *which* build it was running. Passed to sentryVitePlugin too so uploaded source
// maps land on the same release the client reports.
const release = env.VITE_APP_VERSION || env.COMMIT_REF || 'dev'

/**
 * Emit `/build-id.json` naming the build that produced this bundle.
 *
 * A tab left open across a deploy keeps running old JavaScript, and nothing tells it so — the
 * service worker is `autoUpdate`, which claims the live page without reloading it, so the page
 * is old while the precache is new. `buildFreshness.ts` polls this file and compares `id`
 * against the `VITE_APP_VERSION` baked into the bundle; a mismatch means this tab has been
 * superseded.
 *
 * It reuses the `release` constant above rather than reading COMMIT_REF again, so the id here
 * and the release the client reports to Sentry can never disagree about which build this is.
 *
 * `builtAt` is what makes "stale for more than 24 hours" answerable without a timer having run:
 * a suspended mobile tab can miss every interval it was scheduled for, so the client subtracts
 * this timestamp instead of measuring how long it has personally been watching.
 */
function emitBuildId(): Plugin {
  return {
    name: 'unstream-build-id',
    apply: 'build',
    generateBundle() {
      // Written through generateBundle so it lands in the bundle Vite is already emitting;
      // a file written to dist/ by hand would race the build's own output cleanup.
      this.emitFile({
        type: 'asset',
        fileName: 'build-id.json',
        source: JSON.stringify({ id: release, builtAt: new Date().toISOString() }),
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    emitBuildId(),
    VitePWA({
      registerType: 'autoUpdate',
      // The generated registerSW.js calls navigator.serviceWorker.register()
      // with no .catch(), so every browser and crawler that declines to
      // register one raised an unhandled `Error: Rejected` in Sentry. We
      // register from src/services/registerServiceWorker.ts instead.
      injectRegister: false,
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'Unstream',
        short_name: 'Unstream',
        description: 'See where your money actually goes. Find artists on platforms that pay them fairly.',
        theme_color: '#111827',
        background_color: '#1F2937',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        scope: '/',
        icons: [
          {
            src: '/icon-192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: '/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
          },
          {
            src: '/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        skipWaiting: true,
        clientsClaim: true,
        navigateFallbackDenylist: [
          // Edge function routes that serve static HTML — don't let SW intercept them.
          // Must stay in sync with the [[edge_functions]] list in netlify.toml: anything
          // missing here gets served the cached SPA shell for returning visitors, so the
          // edge function silently never runs and the SPA re-fetches the data client-side.
          // That is invisible to curl and to a fresh browser, which is what made it hard
          // to spot — /u/* was missing and cost the page ~5s for anyone with the SW installed.
          /^\/a\//,
          /^\/artist\//,
          /^\/u\//,
          /^\/guides\//,
          /^\/search/,
          // Release feeds (.ics/.xml) are served by a Netlify function, not the SPA. Calendar
          // clients never touch the SW, but a user clicking their own feed link in the browser
          // is a navigation, and the cached shell would hand them an HTML page instead of the
          // calendar. /a/ and /u/ above already cover the two public feed shapes.
          /^\/feed\//,
          // Static RSS feeds copied straight from apps/web/public/ (scripts/generate-guides-feed.ts,
          // generate-changelog-feed.ts) — not edge functions, but the same navigateFallback trap:
          // NavigationRoute's default allowlist (`[/./]`) matches every browser navigation
          // regardless of file extension, so a returning visitor clicking these RSS links from
          // /guides or /changelog got the cached SPA shell instead of the feed — a blank page,
          // since no route renders for /guides.xml. /^\/guides\// above only covers /guides/*
          // pages, not this sibling file.
          /^\/guides\.xml$/,
          /^\/changelog\.xml$/,
        ],
        // No runtimeCaching, deliberately. A NetworkFirst rule used to match every
        // /api/ GET with a 5-minute `api-cache` bucket. It earned nothing, and it
        // stored other people's account data on disk to do it:
        //
        // - It bought no speed. NetworkFirst with no `networkTimeoutSeconds` always
        //   goes to the network and reads the cache only when that fetch throws, so
        //   a repeat search cost exactly what the first one did.
        // - It bought no offline mode either. Nothing in the app reads Cache Storage,
        //   checks navigator.onLine, or renders an offline state, so the fallback was
        //   never surfaced as one — a stale body just rendered as if it were fresh.
        // - It cached what it had no business keeping. Cache Storage is not the HTTP
        //   cache, so the `Cache-Control: no-cache` these endpoints send was silently
        //   overridden, and /api/admin/verify (claimant emails and their free-text
        //   messages), /api/me/settings, /api/me/collection and
        //   /api/analytics/dashboard all landed in a bucket keyed on URL alone. None
        //   of them send `Vary: Authorization`, so on a shared browser one person
        //   losing their connection could be handed the previous person's response —
        //   and signing out cleared none of it.
        //
        // If an API cache comes back, it needs an explicit allowlist of genuinely
        // public endpoints and a strategy that actually reads the cache, not a prefix
        // match over everything — and note that the most tempting candidate, the
        // platform list, carries the payout percentages, which are the last thing on
        // this site worth serving stale. `clearApiResponseCache` deletes the bucket
        // this rule left behind on installs that already have one.
      },
    }),
    // Sentry plugin for source map upload (only if DSN is configured and in production)
    ...(sentryEnabled && process.env.NODE_ENV === 'production' ? [sentryVitePlugin({
      org: env.SENTRY_ORG,
      project: env.SENTRY_PROJECT || 'unstream-web',
      authToken: env.SENTRY_AUTH_TOKEN,
      release: { name: release },
    })] : []),
    {
      name: 'api-server',
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          const handled = await handleApiRequest(req, res);
          if (!handled) {
            next();
          }
        });
      },
    },
    {
      name: 'copy-data-to-dist',
      closeBundle() {
        const src = resolve(__dirname, '..', '..', 'data');
        const dest = resolve(__dirname, 'dist', 'data');
        if (existsSync(src)) {
          cpSync(src, dest, { recursive: true });
          console.log('Copied /data to dist/data');
        }
      },
    },
  ],
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(release),
  },
})
