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
  },
  preview: {
    port: 4173,
  },
});
