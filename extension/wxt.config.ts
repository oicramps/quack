import { defineConfig } from 'wxt';
import { EXTENSION_PUBLIC_KEY, QUACK_VERSION } from '@quack/shared';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Quack',
    description: "Ask Claude Code or Cursor about a pull request's code, right from GitHub.",
    version: QUACK_VERSION,
    key: EXTENSION_PUBLIC_KEY,
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
