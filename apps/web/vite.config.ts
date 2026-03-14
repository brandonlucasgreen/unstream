import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { handleApiRequest } from './server/api'
import { cpSync, existsSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
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
      name: 'copy-artist-data',
      closeBundle() {
        const src = resolve(__dirname, '..', '..', 'data');
        const dest = resolve(__dirname, 'dist', 'data');
        if (existsSync(src)) {
          cpSync(src, dest, { recursive: true });
          console.log('Copied data/ to dist/data/');
        }
      },
    },
  ],
})
