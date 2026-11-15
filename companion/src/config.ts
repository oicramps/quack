import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_FILE, HOME, QUACK_DIR, contractHome, expandHome } from './paths.ts';
import { log } from './log.ts';

export interface Config {
  /** Folders searched (two levels deep) for clones whose origin matches the PR's repo. */
  scanRoots: string[];
  /** Manual overrides: "owner/repo" -> local clone path. */
  repoPaths: Record<string, string>;
  worktreeRoot: string;
  retentionDays: number;
  maxWorktrees: number;
}

const DEFAULTS: Config = {
  scanRoots: [
    '~/Documents/Dev/Projects',
    '~/Projects',
    '~/Developer',
    '~/Development',
    '~/Dev',
    '~/repos',
    '~/src',
    '~/code',
    '~/workspace',
    '~/work',
    '~/GitHub',
    '~/git',
  ],
  repoPaths: {},
  worktreeRoot: path.join(QUACK_DIR, 'worktrees').replace(HOME, '~'),
  retentionDays: 7,
  maxWorktrees: 20,
};

export function loadConfig(): Config {
  let fromFile: Partial<Config> = {};
  try {
    fromFile = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      writeDefaultConfig();
    } else {
      log('config unreadable, using defaults:', String(err));
    }
  }
  const merged = { ...DEFAULTS, ...fromFile };
  return {
    ...merged,
    scanRoots: merged.scanRoots.map(expandHome),
    repoPaths: Object.fromEntries(
      Object.entries(merged.repoPaths).map(([k, v]) => [k.toLowerCase(), expandHome(v)]),
    ),
    worktreeRoot: expandHome(merged.worktreeRoot),
  };
}

function writeDefaultConfig(): void {
  try {
    fs.mkdirSync(QUACK_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULTS, null, 2) + '\n', { flag: 'wx' });
  } catch {
    // Another process created it first, or the home dir is read-only; defaults still apply.
  }
}

/** Saves an explicit `"owner/repo": "<path>"` mapping into config.json, preserving other settings. */
export function setRepoPath(ownerRepo: string, cloneDir: string, configFile = CONFIG_FILE): void {
  let raw: Record<string, unknown> = { ...DEFAULTS };
  try {
    const parsed = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) raw = parsed as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const existing =
    raw.repoPaths && typeof raw.repoPaths === 'object' && !Array.isArray(raw.repoPaths)
      ? (raw.repoPaths as Record<string, string>)
      : {};
  raw.repoPaths = { ...existing, [ownerRepo.toLowerCase()]: contractHome(path.resolve(cloneDir)) };
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify(raw, null, 2) + '\n');
}
