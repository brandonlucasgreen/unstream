import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { handleApiRequest } from './server/api'

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
  ],
})
