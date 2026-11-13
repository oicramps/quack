import type { PrRef } from '@quack/shared';
import { findBinary, run, runGit } from './exec.ts';
import { log } from './log.ts';
import { asCommitSha, isSafeBranch } from './validate.ts';
import { GitError, ensureCommit, fetchPr, hasCommit } from './worktree.ts';

export interface PrContext {
  headSha: string;
  baseSha: string;
  title: string;
  body: string;
}

interface GhPr {
  baseRefOid: string;
  headRefOid: string;
  baseRefName: string;
  title: string;
  body: string;
}

/** Queries PR metadata via `gh pr view`. Returns null when `gh` is missing or unauthenticated. */
async function viaGh(pr: PrRef): Promise<GhPr | null> {
  const gh = findBinary(['gh']);
  if (!gh) return null;
  const res = await run(
    gh,
    ['pr', 'view', String(pr.number), '--repo', `${pr.owner}/${pr.repo}`, '--json', 'baseRefOid,headRefOid,baseRefName,title,body'],
    { timeoutMs: 20_000 },
  );
  if (res.code !== 0) {
    log('gh pr view failed, falling back to git:', res.stderr.trim().split('\n')[0]);
    return null;
  }
  try {
    return JSON.parse(res.stdout) as GhPr;
  } catch {
    return null;
  }
}

/** Fetches `refs/heads/<baseRef>` from origin and computes the merge-base with `headSha`. */
async function mergeBase(clone: string, baseRef: string, headSha: string): Promise<string> {
  if (!isSafeBranch(baseRef)) throw new Error('invalid base branch name');
  const head = asCommitSha(headSha);
  if (!head) throw new Error('invalid head commit');
  const fetch = await runGit(['-C', clone, 'fetch', '--no-tags', '--quiet', 'origin', `refs/heads/${baseRef}`], {
    timeoutMs: 120_000,
  });
  if (fetch.code !== 0) throw new Error(`could not fetch base branch ${baseRef}`);
  const res = await runGit(['-C', clone, 'merge-base', 'FETCH_HEAD', head]);
  const base = asCommitSha(res.stdout);
  if (res.code !== 0 || !base) throw new Error('could not find the merge base');
  return base;
}

/**
 * Fetches the PR and resolves its base and head commits. Uses `pr.headSha` when
 * the user is viewing a specific commit; otherwise uses the latest PR head.
 */
export async function resolvePr(clone: string, pr: PrRef): Promise<PrContext> {
  const fetchedHead = await fetchPr(clone, pr.number);
  const gh = await viaGh(pr);

  let headSha = fetchedHead;
  if (pr.headSha) {
    if (!(await hasCommit(clone, pr.headSha))) {
      await ensureCommit(clone, pr.headSha).catch(() => log('page head SHA could not be fetched, using the PR head'));
    }
    if (await hasCommit(clone, pr.headSha)) {
      const parsed = asCommitSha((await runGit(['-C', clone, 'rev-parse', `${asCommitSha(pr.headSha)}^{commit}`])).stdout);
      if (parsed) headSha = parsed;
    }
  }

  let baseSha: string;
  const ghBase = asCommitSha(gh?.baseRefOid);
  if (ghBase) {
    await ensureCommit(clone, ghBase);
    baseSha = ghBase;
  } else {
    if (gh?.baseRefOid) log('ignoring gh baseRefOid that is not a commit id');
    baseSha = await mergeBase(clone, gh?.baseRefName ?? pr.baseRef ?? 'main', headSha);
  }

  return {
    headSha,
    baseSha,
    title: gh?.title ?? pr.title ?? `PR #${pr.number}`,
    body: gh?.body ?? '',
  };
}

const MAX_DIFF_CHARS = 120_000;

/** Computes `git diff baseSha...headSha`, truncated to `MAX_DIFF_CHARS`. */
export async function prDiff(clone: string, baseSha: string, headSha: string): Promise<{ diff: string; truncated: boolean }> {
  const base = asCommitSha(baseSha);
  const head = asCommitSha(headSha);
  if (!base || !head) throw new GitError('refusing to diff a non-commit id');
  const res = await runGit(['-C', clone, 'diff', '--no-color', `${base}...${head}`], {
    timeoutMs: 60_000,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (res.code !== 0) return { diff: '', truncated: false };
  if (res.stdout.length <= MAX_DIFF_CHARS) return { diff: res.stdout, truncated: false };
  return { diff: res.stdout.slice(0, MAX_DIFF_CHARS), truncated: true };
}
