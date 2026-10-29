import fs from 'node:fs';
import path from 'node:path';
import type { Config } from './config.ts';
import { run } from './exec.ts';
import { log } from './log.ts';

export class GitError extends Error {}

async function git(clone: string, args: string[], timeoutMs = 120_000): Promise<string> {
  const res = await run('git', ['-C', clone, ...args], { timeoutMs });
  if (res.code !== 0) throw new GitError(`git ${args[0]} failed: ${res.stderr.trim().split('\n').slice(-3).join(' ')}`);
  return res.stdout.trim();
}

export function prRef(prNumber: number): string {
  return `refs/pr-review/${prNumber}`;
}

/** Fetches the PR head into refs/pr-review/<n>. Never touches the user's branches. */
export async function fetchPr(clone: string, prNumber: number): Promise<string> {
  await git(clone, ['fetch', '--no-tags', '--quiet', 'origin', `+pull/${prNumber}/head:${prRef(prNumber)}`]);
  return git(clone, ['rev-parse', `${prRef(prNumber)}^{commit}`]);
}

export async function hasCommit(clone: string, sha: string): Promise<boolean> {
  const res = await run('git', ['-C', clone, 'cat-file', '-e', `${sha}^{commit}`], { timeoutMs: 10_000 });
  return res.code === 0;
}

/** Makes sure a commit is present locally, fetching it by SHA if needed (GitHub allows this). */
export async function ensureCommit(clone: string, sha: string): Promise<void> {
  if (await hasCommit(clone, sha)) return;
  await git(clone, ['fetch', '--no-tags', '--quiet', 'origin', sha]);
}

export function worktreePath(config: Config, owner: string, repo: string, prNumber: number): string {
  return path.join(config.worktreeRoot, owner.toLowerCase(), repo.toLowerCase(), `pr-${prNumber}`);
}

/** Creates or reuses a detached worktree at `sha`. The caller must hold the lock. */
export async function prepareWorktree(clone: string, dir: string, sha: string): Promise<void> {
  if (fs.existsSync(path.join(dir, '.git'))) {
    await git(dir, ['reset', '--hard', '--quiet']);
    await git(dir, ['clean', '-fdq']);
    await git(dir, ['checkout', '--detach', '--quiet', sha]);
    return;
  }
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  await git(clone, ['worktree', 'prune']);
  await git(clone, ['worktree', 'add', '--detach', '--quiet', dir, sha]);
}

/** Lists files the agent changed. The worktree is reset before its next use either way. */
export async function changedFiles(dir: string): Promise<string[]> {
  const res = await run('git', ['-C', dir, 'status', '--porcelain'], { timeoutMs: 10_000 });
  return res.code === 0 ? res.stdout.split('\n').filter(Boolean) : [];
}

// Locks: one question at a time per worktree, across companion processes
// (Chrome and Edge each start their own). A lock file holds the owner's PID.

function lockFile(dir: string): string {
  return `${dir}.lock`;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function tryLock(file: string): boolean {
  try {
    fs.writeFileSync(file, String(process.pid), { flag: 'wx' });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    const owner = Number(fs.readFileSync(file, 'utf8'));
    if (!Number.isInteger(owner) || !pidAlive(owner)) {
      fs.rmSync(file, { force: true });
      return tryLock(file);
    }
    return false;
  }
}

const inProcess = new Map<string, Promise<void>>();

/** Waits for the worktree lock, queueing behind earlier questions on the same PR. */
export async function acquireLock(dir: string, signal: AbortSignal): Promise<() => void> {
  const previous = inProcess.get(dir) ?? Promise.resolve();
  let releaseQueue!: () => void;
  const mine = new Promise<void>((r) => (releaseQueue = r));
  const chained = previous.then(() => mine);
  inProcess.set(dir, chained);
  await previous;

  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const file = lockFile(dir);
  while (!tryLock(file)) {
    if (signal.aborted) {
      releaseQueue();
      throw new Error('cancelled');
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    fs.rmSync(file, { force: true });
    releaseQueue();
    if (inProcess.get(dir) === chained) inProcess.delete(dir);
  };
}

/** Removes lock files left by companion processes that died. Runs on startup. */
export function clearStaleLocks(config: Config): void {
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isFile() && e.name.endsWith('.lock')) {
        const owner = Number(fs.readFileSync(p, 'utf8'));
        if (!Number.isInteger(owner) || !pidAlive(owner)) {
          fs.rmSync(p, { force: true });
          log('cleared stale lock', p);
        }
      } else if (e.isDirectory() && depth < 2) {
        walk(p, depth + 1);
      }
    }
  };
  walk(config.worktreeRoot, 0);
}

/** Removes every Quack worktree and its refs/pr-review ref. Manual command for the Spike. */
export async function pruneAll(config: Config, findCloneFor: (owner: string, repo: string) => Promise<string | null>): Promise<string[]> {
  const removed: string[] = [];
  const owners = fs.existsSync(config.worktreeRoot) ? fs.readdirSync(config.worktreeRoot) : [];
  for (const owner of owners) {
    const ownerDir = path.join(config.worktreeRoot, owner);
    if (!fs.statSync(ownerDir).isDirectory()) continue;
    for (const repo of fs.readdirSync(ownerDir)) {
      const repoDir = path.join(ownerDir, repo);
      if (!fs.statSync(repoDir).isDirectory()) continue;
      const clone = await findCloneFor(owner, repo);
      for (const entry of fs.readdirSync(repoDir)) {
        const m = entry.match(/^pr-(\d+)$/);
        if (!m) continue;
        const dir = path.join(repoDir, entry);
        if (fs.existsSync(lockFile(dir))) {
          log('prune skipped locked worktree', dir);
          continue;
        }
        if (clone) {
          await run('git', ['-C', clone, 'worktree', 'remove', '--force', dir]);
          await run('git', ['-C', clone, 'update-ref', '-d', prRef(Number(m[1]))]);
        }
        fs.rmSync(dir, { recursive: true, force: true });
        removed.push(dir);
      }
      if (clone) await run('git', ['-C', clone, 'worktree', 'prune']);
    }
  }
  return removed;
}
