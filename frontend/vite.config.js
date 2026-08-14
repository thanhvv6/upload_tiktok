import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3009,
    // Without this, a leftover process on 3009 makes vite silently fall back to
    // 3010 -- the backend's port -- which then dies with EADDRINUSE.
    strictPort: true,
    proxy: {
      '/api': 'http://localhost:3010'
    }
  }
});
