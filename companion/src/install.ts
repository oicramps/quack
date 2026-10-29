import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EXTENSION_ID, HOST_NAME } from '@quack/shared';
import { BIN_DIR, HOME } from './paths.ts';

function manifestDirs(): string[] {
  if (process.platform === 'darwin') {
    const base = path.join(HOME, 'Library', 'Application Support');
    return [
      path.join(base, 'Google', 'Chrome', 'NativeMessagingHosts'),
      path.join(base, 'Microsoft Edge', 'NativeMessagingHosts'),
      path.join(base, 'Chromium', 'NativeMessagingHosts'),
    ];
  }
  if (process.platform === 'linux') {
    const base = path.join(HOME, '.config');
    return [
      path.join(base, 'google-chrome', 'NativeMessagingHosts'),
      path.join(base, 'microsoft-edge', 'NativeMessagingHosts'),
      path.join(base, 'chromium', 'NativeMessagingHosts'),
    ];
  }
  throw new Error(`Unsupported platform: ${process.platform}. Quack supports macOS and Linux.`);
}

/**
 * Copies the bundled companion to ~/.quack/bin, writes a launcher that runs it
 * with this exact node binary (Chrome's PATH may not include it), and registers
 * the native messaging host for Chrome, Edge and Chromium.
 */
export function install(bundlePath: string): void {
  fs.mkdirSync(BIN_DIR, { recursive: true });
  const script = path.join(BIN_DIR, 'quack-companion.cjs');
  fs.copyFileSync(bundlePath, script);

  const launcher = path.join(BIN_DIR, 'quack-companion');
  fs.writeFileSync(launcher, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
  fs.chmodSync(launcher, 0o755);

  const manifest = {
    name: HOST_NAME,
    description: 'Quack companion: runs AI agents against PR worktrees',
    path: launcher,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
  };
  for (const dir of manifestDirs()) {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${HOST_NAME}.json`);
    fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
    console.log(`Registered ${file}`);
  }
  console.log(`\nCompanion installed at ${launcher}`);
  console.log(`Node: ${process.execPath} (${process.version})`);
  console.log(`Extension ID allowed: ${EXTENSION_ID}`);
  console.log('\nRestart the browser if the panel still says the companion is not connected.');
}

export function uninstall(): void {
  for (const dir of manifestDirs()) {
    const file = path.join(dir, `${HOST_NAME}.json`);
    if (fs.existsSync(file)) {
      fs.rmSync(file);
      console.log(`Removed ${file}`);
    }
  }
  fs.rmSync(BIN_DIR, { recursive: true, force: true });
  console.log(`Removed ${BIN_DIR}. Worktrees and config in ${path.dirname(BIN_DIR).replace(os.homedir(), '~')} were kept; run prune first to remove worktrees.`);
}
