import { defineConfig } from 'wxt';
import { EXTENSION_PUBLIC_KEY, FIREFOX_EXTENSION_ID, QUACK_VERSION } from '@quacksteps/shared';

// The store rejects a manifest key and assigns its own id, so store builds
// (QUACK_STORE=1) leave it out and go to their own folder. Every other build
// keeps the key, so the unpacked id matches the companion's allow list.
const store = process.env.QUACK_STORE === '1';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  outDir: store ? 'dist/store' : 'dist',
  // WXT defaults Firefox to MV2; every browser gets MV3.
  manifestVersion: 3,
  manifest: ({ browser }) => {
    const firefox = browser === 'firefox';
    return {
      name: 'Quacksteps',
      description:
        'Ask your local Claude Code or Cursor about any GitHub PR with full repo context—no stashing or branch switching required.',
      version: QUACK_VERSION,
      // Chromium only: pins the unpacked id. Firefox uses the gecko id below.
      ...(!store && !firefox && { key: EXTENSION_PUBLIC_KEY }),
      // Firefox has no sidePanel API; WXT turns the side panel into a sidebar_action.
      permissions: firefox ? ['nativeMessaging', 'storage'] : ['nativeMessaging', 'storage', 'sidePanel'],
      host_permissions: ['https://github.com/*'],
      action: { default_title: 'Open Quacksteps' },
      commands: {
        'ask-about-selection': {
          suggested_key: { default: 'Ctrl+Shift+K', mac: 'Command+Shift+K' },
          description: 'Ask Quacksteps about the selected code',
        },
      },
      ...(firefox && {
        browser_specific_settings: {
          gecko: {
            id: FIREFOX_EXTENSION_ID,
            // 140 (ESR) declares data collection in the manifest, which AMO requires.
            strict_min_version: '140.0',
            data_collection_permissions: { required: ['none'] },
          },
        },
      }),
    };
  },
  zip: {
    // AMO reviewers rebuild the add-on from this zip, so it holds the whole
    // workspace the extension needs (shared/, lockfile), not just extension/.
    sourcesRoot: '..',
    excludeSources: ['companion/**', '.github/**', '.claude/**', 'store-assets/**', 'mac/**', '**/dist/**', '**/.wxt/**'],
  },
  webExt: {
    startUrls: ['https://github.com/ProjetoParcas/mynah/pull/14/files'],
  },
});
