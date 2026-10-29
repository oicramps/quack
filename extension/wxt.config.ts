import { defineConfig } from 'wxt';
import { EXTENSION_PUBLIC_KEY, QUACK_VERSION } from '@quack/shared';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Quack',
    description: "Ask Claude Code or Cursor about a pull request's code, right from GitHub.",
    version: QUACK_VERSION,
    key: EXTENSION_PUBLIC_KEY,
    permissions: ['nativeMessaging', 'storage'],
    host_permissions: ['https://github.com/*'],
  },
  webExt: {
    startUrls: ['https://github.com/ProjetoParcas/mynah/pull/14/files'],
  },
});
