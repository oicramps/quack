import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// Renders the side panel outside Chrome with a scripted fake companion, to
// check it against the design files: `npm run preview -w extension`.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  resolve: {
    alias: { 'wxt/browser': fileURLToPath(new URL('./mockBrowser.ts', import.meta.url)) },
  },
  esbuild: { jsx: 'automatic' },
  server: { port: 5199 },
});
