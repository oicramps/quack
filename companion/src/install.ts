import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ALLOWED_EXTENSION_IDS, DEV_EXTENSION_ID, HOST_NAME } from '@quack/shared';
import { BIN_DIR, HOME } from './paths.ts';

interface HostTarget {
  segments: string[];
  /** Primary stable channel, registered as fallback if no browser profile exists yet. */
  primary?: boolean;
}

/** Chromium user-data dirs that read `NativeMessagingHosts/<host>.json`. */
const HOST_DIRS: Record<'darwin' | 'linux', HostTarget[]> = {
  darwin: [
    { segments: ['Google', 'Chrome'], primary: true },
    { segments: ['Microsoft Edge'], primary: true },
    { segments: ['Chromium'], primary: true },
    { segments: ['BraveSoftware', 'Brave-Browser'], primary: true },
    { segments: ['BraveSoftware', 'Brave-Browser-Beta'] },
    { segments: ['BraveSoftware', 'Brave-Browser-Dev'] },
    { segments: ['BraveSoftware', 'Brave-Browser-Nightly'] },
  ],
  linux: [
    { segments: ['google-chrome'], primary: true },
    { segments: ['microsoft-edge'], primary: true },
    { segments: ['chromium'], primary: true },
    { segments: ['BraveSoftware', 'Brave-Browser'], primary: true },
    { segments: ['BraveSoftware', 'Brave-Browser-Beta'] },
    { segments: ['BraveSoftware', 'Brave-Browser-Dev'] },
    { segments: ['BraveSoftware', 'Brave-Browser-Nightly'] },
  ],
};

function configBaseDir(platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv): string {
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support');
  if (platform === 'linux') {
    const xdg = env.XDG_CONFIG_HOME?.trim();
    return xdg && path.isAbsolute(xdg) ? xdg : path.join(home, '.config');
  }
  throw new Error(`Unsupported platform: ${platform}. Quack supports macOS and Linux.`);
}

function resolveTargets(platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv): { dir: string; primary: boolean }[] {
  const targets = HOST_DIRS[platform as 'darwin' | 'linux'];
  if (!targets) throw new Error(`Unsupported platform: ${platform}. Quack supports macOS and Linux.`);
  const base = configBaseDir(platform, home, env);
  return targets.map(({ segments, primary }) => ({
    dir: path.join(base, ...segments, 'NativeMessagingHosts'),
    primary: primary === true,
  }));
}

/** All native-messaging manifest directories for Chrome, Edge, Brave, and Chromium. */
export function nativeMessagingHostDirs(
  platform: NodeJS.Platform = process.platform,
  home = HOME,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return resolveTargets(platform, home, env).map((t) => t.dir);
}

/**
 * Picks native-messaging directories to register on install: browsers whose
 * user-data directory already exists, or the primary stable channels if none do.
 */
export function selectInstallHostDirs(
  platform: NodeJS.Platform = process.platform,
  home = HOME,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const targets = resolveTargets(platform, home, env);
  const existing = targets.filter((t) => fs.existsSync(path.dirname(t.dir))).map((t) => t.dir);
  return existing.length > 0 ? existing : targets.filter((t) => t.primary).map((t) => t.dir);
}

function allowedIds(dev: boolean): string[] {
  return dev ? ALLOWED_EXTENSION_IDS : ALLOWED_EXTENSION_IDS.filter((id) => id !== DEV_EXTENSION_ID);
}

export interface InstallOptions {
  dev?: boolean;
  binDir?: string;
  platform?: NodeJS.Platform;
  home?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Copies the bundled companion to ~/.quack/bin, writes a launcher that runs it
 * with this exact node binary (Chrome's PATH may not include it), and registers
 * the native messaging host for installed Chrome, Edge, Brave, and Chromium browsers.
 * Pass `{ dev: true }` to also allow the unpacked extension id.
 */
export function install(bundlePath: string, opts: InstallOptions = {}): void {
  const dev = opts.dev === true;
  const binDir = opts.binDir ?? BIN_DIR;
  fs.mkdirSync(binDir, { recursive: true });
  const script = path.join(binDir, 'quack-companion.cjs');
  fs.copyFileSync(bundlePath, script);

  const launcher = path.join(binDir, 'quack-companion');
  // The dev id is opt-in. Chrome starts this script, so the flag has to live here,
  // not in an environment the extension can set.
  const devFlag = dev ? 'QUACK_ALLOW_DEV=1 ' : '';
  fs.writeFileSync(launcher, `#!/bin/sh\n${devFlag}exec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
  fs.chmodSync(launcher, 0o755);

  const ids = allowedIds(dev);
  const manifest = {
    name: HOST_NAME,
    description: 'Quack companion: runs AI agents against PR worktrees',
    path: launcher,
    type: 'stdio',
    allowed_origins: ids.map((id) => `chrome-extension://${id}/`),
  };
  for (const dir of selectInstallHostDirs(opts.platform, opts.home, opts.env)) {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${HOST_NAME}.json`);
    fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
    console.log(`Registered ${file}`);
  }
  console.log(`\nCompanion installed at ${launcher}`);
  console.log(`Node: ${process.execPath} (${process.version})`);
  console.log(`Extension IDs allowed: ${ids.join(', ')}`);
  console.log('\nRestart the browser if the panel still says the companion is not connected.');
}

export function uninstall(opts: Pick<InstallOptions, 'binDir' | 'platform' | 'home' | 'env'> = {}): void {
  const binDir = opts.binDir ?? BIN_DIR;
  for (const dir of nativeMessagingHostDirs(opts.platform, opts.home, opts.env)) {
    const file = path.join(dir, `${HOST_NAME}.json`);
    if (fs.existsSync(file)) {
      fs.rmSync(file);
      console.log(`Removed ${file}`);
    }
  }
  fs.rmSync(binDir, { recursive: true, force: true });
  console.log(`Removed ${binDir}. Worktrees and config in ${path.dirname(binDir).replace(os.homedir(), '~')} were kept; run prune first to remove worktrees.`);
}
