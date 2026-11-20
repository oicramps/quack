import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ALLOWED_EXTENSION_IDS, DEV_EXTENSION_ID, FIREFOX_EXTENSION_ID, HOST_NAME } from '@quacksteps/shared';
import menuBarSwift from './menubar.swift';
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
  throw new Error(`Unsupported platform: ${platform}. Quacksteps supports macOS and Linux.`);
}

function resolveTargets(platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv): { dir: string; primary: boolean }[] {
  const targets = HOST_DIRS[platform as 'darwin' | 'linux'];
  if (!targets) throw new Error(`Unsupported platform: ${platform}. Quacksteps supports macOS and Linux.`);
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

/**
 * Firefox reads native-messaging manifests from one folder per OS (not per
 * profile), and `profileDir` exists once Firefox has run. Linux ignores XDG here.
 */
export function firefoxHostDir(platform: NodeJS.Platform = process.platform, home = HOME): { dir: string; profileDir: string } {
  if (platform === 'darwin') {
    const support = path.join(home, 'Library', 'Application Support');
    return { dir: path.join(support, 'Mozilla', 'NativeMessagingHosts'), profileDir: path.join(support, 'Firefox') };
  }
  if (platform === 'linux') {
    return { dir: path.join(home, '.mozilla', 'native-messaging-hosts'), profileDir: path.join(home, '.mozilla', 'firefox') };
  }
  throw new Error(`Unsupported platform: ${platform}. Quacksteps supports macOS and Linux.`);
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
  /** Test seam. Production install compiles with `swiftc` on macOS. */
  compileMenuBar?: (source: string, outFile: string) => void;
}

/** `swiftc` is not installed. The companion still installs; the menu bar icon is skipped. */
export class SwiftcMissingError extends Error {
  constructor() {
    super('swiftc not found');
    this.name = 'SwiftcMissingError';
  }
}

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function developerDir(env: NodeJS.ProcessEnv): string | null {
  try {
    const dir = execFileSync('xcode-select', ['-p'], {
      encoding: 'utf8',
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    return dir || null;
  } catch {
    return null;
  }
}

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: unknown }).code === 'ENOENT';
}

function compilerMessage(err: unknown): string {
  const stderr = err && typeof err === 'object' && 'stderr' in err ? String((err as { stderr?: unknown }).stderr ?? '') : '';
  return stderr.trim() || (err instanceof Error ? err.message : String(err));
}

/**
 * Locates `swiftc` via `xcrun -f swiftc`, then `/usr/bin/swiftc`.
 * Returns null without invoking `xcrun` when no developer directory is selected,
 * because that invocation opens the Command Line Tools install dialog.
 * The returned path is the `/usr/bin/swiftc` trampoline when it exists: running the
 * toolchain binary from `xcrun -f` skips SDK setup and cannot load the Swift stdlib.
 */
export function findSwiftc(env: NodeJS.ProcessEnv = process.env): string | null {
  const selected = developerDir(env);
  if (!selected) return null;
  const swiftEnv = { ...env, DEVELOPER_DIR: selected };
  let toolchain = '';
  try {
    toolchain = execFileSync('xcrun', ['-f', 'swiftc'], {
      encoding: 'utf8',
      env: swiftEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    toolchain = '';
  }
  // `/usr/bin/swiftc` is the xcrun trampoline. The toolchain path from `xcrun -f`
  // compiles without the selected SDK and cannot load the Swift standard library.
  if (isExecutable('/usr/bin/swiftc')) return '/usr/bin/swiftc';
  return toolchain && isExecutable(toolchain) ? toolchain : null;
}

/** Compiles the menu bar helper. Throws `SwiftcMissingError` when the compiler is absent. */
export function compileMenuBar(source: string, outFile: string, env: NodeJS.ProcessEnv = process.env): void {
  const selected = developerDir(env);
  if (!selected) throw new SwiftcMissingError();
  const swiftEnv = { ...env, DEVELOPER_DIR: selected };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quack-menubar-'));
  try {
    const srcFile = path.join(dir, 'menubar.swift');
    fs.writeFileSync(srcFile, source);
    const flags = ['-O', '-framework', 'Cocoa', '-o', outFile, srcFile];
    try {
      try {
        // xcrun selects the macOS SDK. The toolchain path from `xcrun -f swiftc` does not.
        execFileSync('xcrun', ['swiftc', ...flags], {
          encoding: 'utf8',
          env: swiftEnv,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err) {
        if (!isEnoent(err)) throw err;
        execFileSync('/usr/bin/swiftc', flags, {
          encoding: 'utf8',
          env: swiftEnv,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      }
    } catch (err) {
      if (isEnoent(err)) throw new SwiftcMissingError();
      throw new Error(compilerMessage(err));
    }
    fs.chmodSync(outFile, 0o755);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Copies the bundled companion to ~/.quack/bin, writes a launcher that runs it
 * with this exact node binary (Chrome's PATH may not include it), and registers
 * the native messaging host for installed Chrome, Edge, Brave, Chromium, and Firefox browsers.
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

  const menuBarNote = installMenuBar(binDir, opts);

  const ids = allowedIds(dev);
  const manifest = {
    name: HOST_NAME,
    description: 'Quacksteps companion: runs AI agents against PR worktrees',
    path: launcher,
    type: 'stdio',
    allowed_origins: ids.map((id) => `chrome-extension://${id}/`),
  };
  const write = (dir: string, content: object) => {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${HOST_NAME}.json`);
    fs.writeFileSync(file, JSON.stringify(content, null, 2) + '\n');
    console.log(`Registered ${file}`);
  };
  for (const dir of selectInstallHostDirs(opts.platform, opts.home, opts.env)) write(dir, manifest);
  // Firefox names the add-on by its gecko id rather than an origin.
  const firefox = firefoxHostDir(opts.platform, opts.home);
  if (fs.existsSync(firefox.profileDir)) {
    const { allowed_origins: _origins, ...shared } = manifest;
    write(firefox.dir, { ...shared, allowed_extensions: [FIREFOX_EXTENSION_ID] });
  }
  console.log(`\nCompanion installed at ${launcher}`);
  console.log(`Node: ${process.execPath} (${process.version})`);
  console.log(`Extension IDs allowed: ${[...ids, FIREFOX_EXTENSION_ID].join(', ')}`);
  if (menuBarNote) console.log(menuBarNote);
  console.log('\nRestart the browser if the panel still says the companion is not connected.');
}

/** Compiles `quack-menubar` on macOS. A missing compiler does not fail install. */
function installMenuBar(binDir: string, opts: InstallOptions): string {
  if ((opts.platform ?? process.platform) !== 'darwin') return '';
  const outFile = path.join(binDir, 'quack-menubar');
  const compile = opts.compileMenuBar ?? ((source: string, out: string) => compileMenuBar(source, out, opts.env ?? process.env));
  try {
    compile(menuBarSwift, outFile);
    return `Menu bar helper: ${outFile}`;
  } catch (err) {
    if (err instanceof SwiftcMissingError) {
      return 'Menu bar helper skipped (swiftc not found). Install the Xcode Command Line Tools and run install again.';
    }
    return `Menu bar helper skipped: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export function uninstall(opts: Pick<InstallOptions, 'binDir' | 'platform' | 'home' | 'env'> = {}): void {
  const binDir = opts.binDir ?? BIN_DIR;
  const dirs = [...nativeMessagingHostDirs(opts.platform, opts.home, opts.env), firefoxHostDir(opts.platform, opts.home).dir];
  for (const dir of dirs) {
    const file = path.join(dir, `${HOST_NAME}.json`);
    if (fs.existsSync(file)) {
      fs.rmSync(file);
      console.log(`Removed ${file}`);
    }
  }
  fs.rmSync(binDir, { recursive: true, force: true });
  console.log(`Removed ${binDir}. Worktrees and config in ${path.dirname(binDir).replace(os.homedir(), '~')} were kept; run prune to apply retentionDays and maxWorktrees.`);
}
