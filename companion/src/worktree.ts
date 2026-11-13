import fs from 'node:fs';
import path from 'node:path';
import type { Config } from './config.ts';
import { run } from './exec.ts';

export class GitError extends Error {}

async function git(clone: string, args: string[], timeoutMs = 120_000): Promise<string> {
  const res = await run('git', ['-C', clone, ...args], { timeoutMs });
  if (res.code !== 0) throw new GitError(`git ${args[0]} failed: ${res.stderr.trim().split('\n').slice(-3).join(' ')}`);
  return res.stdout.trim();
}

export function prRef(prNumber: number): string {
  return `refs/pr-review/${prNumber}`;
}

/** Fetches `pull/<n>/head` from origin into `refs/pr-review/<n>` and returns the commit SHA. */
export async function fetchPr(clone: string, prNumber: number): Promise<string> {
  await git(clone, ['fetch', '--no-tags', '--quiet', 'origin', `+pull/${prNumber}/head:${prRef(prNumber)}`]);
  return git(clone, ['rev-parse', `${prRef(prNumber)}^{commit}`]);
}

export async function hasCommit(clone: string, sha: string): Promise<boolean> {
  const res = await run('git', ['-C', clone, 'cat-file', '-e', `${sha}^{commit}`], { timeoutMs: 10_000 });
  return res.code === 0;
}

/** Ensures `sha` exists in the local object store, fetching it from `origin` if missing. */
export async function ensureCommit(clone: string, sha: string): Promise<void> {
  if (await hasCommit(clone, sha)) return;
  await git(clone, ['fetch', '--no-tags', '--quiet', 'origin', sha]);
}

export function worktreePath(config: Config, owner: string, repo: string, prNumber: number): string {
  return path.join(config.worktreeRoot, owner.toLowerCase(), repo.toLowerCase(), `pr-${prNumber}`);
}

/** Creates or hard-resets a detached worktree at `sha`. Caller must hold `acquireLock(dir)`. */
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

/** Returns modified or untracked entries in `dir` via `git status --porcelain`. */
export async function changedFiles(dir: string): Promise<string[]> {
  const res = await run('git', ['-C', dir, 'status', '--porcelain'], { timeoutMs: 10_000 });
  return res.code === 0 ? res.stdout.split('\n').filter(Boolean) : [];
}

const queues = new Map<string, Promise<void>>();

/** Serializes concurrent operations targeting the same worktree directory. */
export async function acquireLock(dir: string, signal: AbortSignal): Promise<() => void> {
  const previous = queues.get(dir) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  const chained = previous.then(() => mine);
  queues.set(dir, chained);
  await previous;
  const done = () => {
    release();
    if (queues.get(dir) === chained) queues.delete(dir);
  };
  if (signal.aborted) {
    done();
    throw new Error('cancelled');
  }
  return done;
}

/** Removes all Quack worktrees under `config.worktreeRoot` and deletes their `refs/pr-review/*` refs. */
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
