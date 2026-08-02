import { defineConfig, loadEnv } from 'vite'
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

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
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
        ],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/unstream\.stream\/api\//,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'api-cache',
              expiration: {
                maxEntries: 50,
                maxAgeSeconds: 60 * 5, // 5 minutes
              },
            },
          },
        ],
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
