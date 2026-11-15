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

export const DEFAULT_SCAN_ROOTS = [
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
];

const DEFAULTS: Config = {
  scanRoots: DEFAULT_SCAN_ROOTS,
  repoPaths: {},
  worktreeRoot: path.join(QUACK_DIR, 'worktrees').replace(HOME, '~'),
  retentionDays: 7,
  maxWorktrees: 20,
};

export function hasConfigFile(configFile = CONFIG_FILE): boolean {
  try {
    return fs.existsSync(configFile);
  } catch {
    return false;
  }
}

export function loadConfig(configFile = CONFIG_FILE): Config {
  let fromFile: Partial<Config> = {};
  try {
    fromFile = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log('config unreadable, using defaults:', String(err));
    }
  }
  const merged = {
    ...DEFAULTS,
    ...fromFile,
    scanRoots: Array.isArray(fromFile.scanRoots) ? fromFile.scanRoots.filter((s): s is string => typeof s === 'string') : DEFAULTS.scanRoots,
    repoPaths:
      fromFile.repoPaths && typeof fromFile.repoPaths === 'object' && !Array.isArray(fromFile.repoPaths)
        ? fromFile.repoPaths
        : DEFAULTS.repoPaths,
  };
  return {
    ...merged,
    scanRoots: merged.scanRoots.map(expandHome),
    repoPaths: Object.fromEntries(
      Object.entries(merged.repoPaths).map(([k, v]) => [k.toLowerCase(), expandHome(String(v))]),
    ),
    worktreeRoot: expandHome(merged.worktreeRoot),
  };
}

function readRawConfig(configFile = CONFIG_FILE): Record<string, unknown> {
  try {
    const parsed = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  return { ...DEFAULTS };
}

function writeRawConfig(raw: Record<string, unknown>, configFile = CONFIG_FILE): void {
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify(raw, null, 2) + '\n');
}

/** Saves an explicit `"owner/repo": "<path>"` mapping into config.json, preserving other settings. */
export function setRepoPath(ownerRepo: string, cloneDir: string, configFile = CONFIG_FILE): void {
  const raw = readRawConfig(configFile);
  const existing =
    raw.repoPaths && typeof raw.repoPaths === 'object' && !Array.isArray(raw.repoPaths)
      ? (raw.repoPaths as Record<string, string>)
      : {};
  raw.repoPaths = { ...existing, [ownerRepo.toLowerCase()]: contractHome(path.resolve(cloneDir)) };
  writeRawConfig(raw, configFile);
}

/** Saves `scanRoots` and/or `repoPaths` updates into config.json. */
export function saveWorkspaceConfig(
  patch: { scanRoots?: string[]; repoPaths?: Record<string, string | null> },
  configFile = CONFIG_FILE,
): void {
  const raw = readRawConfig(configFile);
  if (patch.scanRoots !== undefined) {
    const seen = new Set<string>();
    const roots: string[] = [];
    for (const r of patch.scanRoots) {
      const normalized = contractHome(path.resolve(expandHome(r)));
      if (!seen.has(normalized)) {
        seen.add(normalized);
        roots.push(normalized);
      }
    }
    raw.scanRoots = roots;
  }
  if (patch.repoPaths !== undefined) {
    const existing =
      raw.repoPaths && typeof raw.repoPaths === 'object' && !Array.isArray(raw.repoPaths)
        ? { ...(raw.repoPaths as Record<string, string>) }
        : {};
    for (const [k, v] of Object.entries(patch.repoPaths)) {
      const key = k.toLowerCase();
      if (v === null) delete existing[key];
      else existing[key] = contractHome(path.resolve(expandHome(v)));
    }
    raw.repoPaths = existing;
  }
  writeRawConfig(raw, configFile);
}
