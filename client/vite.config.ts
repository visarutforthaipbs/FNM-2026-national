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
        // Split vendor code out of the app bundle so a change to our own
        // source doesn't invalidate ~700 kB of dependencies in every cache.
        //
        // Deliberately only two buckets. An earlier version split this five
        // ways (react-vendor / chakra / leaflet / turf / vendor) and shipped a
        // white screen: chunks in a shared dependency graph ended up importing
        // each other in both directions —
        //
        //     react-vendor → vendor → chakra → react-vendor
        //
        // and because ES modules evaluate in order, Chakra ran before
        // react-vendor had finished exporting. React was still undefined when
        // Chakra read useLayoutEffect off it. Splitting by package name cannot
        // prevent this, because it says nothing about the import graph.
        //
        // These two buckets are cycle-free by construction, which is the whole
        // point: nothing in node_modules imports our app code, so `vendor` can
        // never point back at the entry chunk; and leaflet is a true leaf that
        // imports nothing at all, so it can only be imported from, never into.
        // Verified with `npm run check:chunks`.
        //
        // Before adding a third bucket, run that check — a split that looks
        // sensible by package name is exactly how the last one broke.
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return;
          if (id.includes('/leaflet/')) return 'leaflet';
          return 'vendor';
        },
      },
    },
  },
})
