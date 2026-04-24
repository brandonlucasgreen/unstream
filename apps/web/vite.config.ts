import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { sentryVitePlugin } from '@sentry/vite-plugin'
import { handleApiRequest } from './server/api'
import { cpSync, existsSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Sentry DSN from environment (optional)
const sentryDsn = process.env.VITE_SENTRY_DSN || process.env.SENTRY_DSN
const sentryEnabled = !!sentryDsn

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    // Sentry plugin for source map upload (only if DSN is configured)
    ...(sentryEnabled ? [sentryVitePlugin({
      org: process.env.SENTRY_ORG,
      project: process.env.SENTRY_PROJECT || 'unstream-web',
      authToken: process.env.SENTRY_AUTH_TOKEN,
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
