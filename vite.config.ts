import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    target: 'es2022',
    sourcemap: false,
    rollupOptions: {
      output: {
        // Split the two large, rarely-changing dependencies out of the app chunk
        // so a code change does not invalidate the whole download.
        manualChunks(id: string) {
          if (id.includes('lightweight-charts')) return 'charts';
          if (id.includes('node_modules')) return 'vendor';
          return undefined;
        },
      },
    },
  },
  server: {
    port: 5173,
    // The market-data service allows only these exact origins. Failing instead of
    // moving to the next free port keeps the browser origin and the CORS
    // allow-list in step; a shifted port would surface as an unexplained
    // "service not reachable" error.
    strictPort: true,
  },
  preview: {
    port: 4173,
    strictPort: true,
  },
});
