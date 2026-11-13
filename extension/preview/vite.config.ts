import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// Standalone Vite server that renders the side panel with a scripted fake companion:
// `yarn workspace @quack/extension preview`
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  resolve: {
    alias: { 'wxt/browser': fileURLToPath(new URL('./mockBrowser.ts', import.meta.url)) },
  },
  esbuild: { jsx: 'automatic' },
  server: { port: 5199 },
});
