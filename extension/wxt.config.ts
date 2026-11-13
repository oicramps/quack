import { defineConfig } from 'wxt';
import { EXTENSION_PUBLIC_KEY, QUACK_VERSION } from '@quack/shared';

// The store rejects a manifest key and assigns its own id, so store builds
// (QUACK_STORE=1) leave it out and go to their own folder. Every other build
// keeps the key, so the unpacked id matches the companion's allow list.
const store = process.env.QUACK_STORE === '1';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  outDir: store ? '.output/store' : '.output',
  manifest: {
    name: 'Quack',
    description:
      'Ask your local Claude Code or Cursor about any GitHub PR with full repo context—no stashing or branch switching required.',
    version: QUACK_VERSION,
    ...(!store && { key: EXTENSION_PUBLIC_KEY }),
    permissions: ['nativeMessaging', 'storage', 'sidePanel'],
    host_permissions: ['https://github.com/*'],
    action: { default_title: 'Open Quack' },
    commands: {
      'ask-about-selection': {
        suggested_key: { default: 'Ctrl+Shift+K', mac: 'Command+Shift+K' },
        description: 'Ask Quack about the selected code',
      },
    },
  },
  webExt: {
    startUrls: ['https://github.com/ProjetoParcas/mynah/pull/14/files'],
  },
});
