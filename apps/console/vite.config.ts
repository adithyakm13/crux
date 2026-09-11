import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Relative base so the built site works from a subpath — GitHub Pages, an
// artifact host, or a file:// open — without a rebuild.
export default defineConfig({
  base: './',
  plugins: [react()],
  build: { outDir: 'dist', sourcemap: true },
});
