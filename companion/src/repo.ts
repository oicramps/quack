import fs from 'node:fs';
import path from 'node:path';
import type { Config } from './config.ts';
import { run } from './exec.ts';
import { log } from './log.ts';

/** Turns any GitHub remote URL (SSH, HTTPS, ssh://) into "owner/repo", lowercased. */
export function parseGitHubRemote(url: string): string | null {
  const m = url
    .trim()
    .match(/^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https:\/\/(?:[^@/]+@)?github\.com\/|git:\/\/github\.com\/)([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}

async function originOf(dir: string): Promise<string | null> {
  const res = await run('git', ['-C', dir, 'remote', 'get-url', 'origin'], { timeoutMs: 5000 });
  return res.code === 0 ? parseGitHubRemote(res.stdout) : null;
}

function isGitDir(dir: string): boolean {
  try {
    return fs.existsSync(path.join(dir, '.git'));
  } catch {
    return false;
  }
}

/** Collects git repository directories up to two levels beneath `roots`. */
function candidateDirs(roots: string[]): string[] {
  const out: string[] = [];
  for (const root of roots) {
    let level1: fs.Dirent[];
    try {
      level1 = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e1 of level1) {
      if (!e1.isDirectory() || e1.name.startsWith('.') || e1.name === 'node_modules') continue;
      const d1 = path.join(root, e1.name);
      if (isGitDir(d1)) {
        out.push(d1);
        continue;
      }
      let level2: fs.Dirent[];
      try {
        level2 = fs.readdirSync(d1, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e2 of level2) {
        if (!e2.isDirectory() || e2.name.startsWith('.') || e2.name === 'node_modules') continue;
        const d2 = path.join(d1, e2.name);
        if (isGitDir(d2)) out.push(d2);
      }
    }
  }
  return out;
}

const cache = new Map<string, string>();

/** Finds the local clone for owner/repo: config override first, then a scan of scanRoots. */
export async function findClone(config: Config, owner: string, repo: string): Promise<string | null> {
  const key = `${owner}/${repo}`.toLowerCase();

  const override = config.repoPaths[key];
  if (override) {
    if (isGitDir(override) && (await originOf(override)) === key) return override;
    log('repoPaths override does not point at a clone of', key, override);
  }

  const cached = cache.get(key);
  if (cached && isGitDir(cached)) return cached;

  for (const dir of candidateDirs(config.scanRoots)) {
    const origin = await originOf(dir);
    if (origin) cache.set(origin, dir);
    if (origin === key) return dir;
  }
  return null;
}
