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

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
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
          // Edge function routes that serve static HTML — don't let SW intercept them
          /^\/a\//,
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
})
