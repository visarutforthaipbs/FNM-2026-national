import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  build: {
    rollupOptions: {
      output: {
        // Split vendor libraries into stable, independently-cached chunks.
        // A single 790+ kB main chunk hurt cold loads and forced full cache
        // invalidation whenever one dependency bumped. Order matters: check
        // more specific paths (leaflet, chakra) before the generic react rules.
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return;
          if (
            id.includes('/leaflet')
          ) {
            return 'leaflet';
          }
          if (
            id.includes('/@chakra-ui/') ||
            id.includes('/@emotion/') ||
            id.includes('/framer-motion/') ||
            id.includes('/@popperjs/') ||
            id.includes('/focus-lock/') ||
            id.includes('/react-clientside-effect/') ||
            id.includes('/aria-hidden/') ||
            id.includes('/react-remove-scroll/') ||
            id.includes('/use-sidecar/')
          ) {
            return 'chakra';
          }
          if (
            id.includes('/react/') ||
            id.includes('/react-dom/') ||
            id.includes('/react-router') ||
            id.includes('/scheduler/')
          ) {
            return 'react-vendor';
          }
          if (id.includes('/@turf/')) {
            return 'turf';
          }
          return 'vendor';
        },
      },
    },
  },
})
