import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev: `npm run dev` proxied API-Aufrufe zum Backend auf :3000.
// WebSockets (3333/3334) werden direkt angesprochen.
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', sourcemap: false },
  server: {
    port: 5173,
    proxy: {
      '/upload': 'http://localhost:3000',
      '/api': 'http://localhost:3000',
    },
  },
});
