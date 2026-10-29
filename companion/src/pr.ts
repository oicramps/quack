import type { PrRef } from '@quack/shared';
import { findBinary, run } from './exec.ts';
import { log } from './log.ts';
import { isSafeBranch } from './validate.ts';
import { ensureCommit, fetchPr, hasCommit } from './worktree.ts';

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

async function mergeBase(clone: string, baseRef: string, headSha: string): Promise<string> {
  if (!isSafeBranch(baseRef)) throw new Error('invalid base branch name');
  const fetch = await run('git', ['-C', clone, 'fetch', '--no-tags', '--quiet', 'origin', `refs/heads/${baseRef}`], {
    timeoutMs: 120_000,
  });
  if (fetch.code !== 0) throw new Error(`could not fetch base branch ${baseRef}`);
  const res = await run('git', ['-C', clone, 'merge-base', 'FETCH_HEAD', headSha]);
  if (res.code !== 0) throw new Error('could not find the merge base');
  return res.stdout.trim();
}

/**
 * Fetches the PR and resolves its commits. The head is the commit the page shows
 * when it shows one, otherwise the PR's latest head.
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
      headSha = (await run('git', ['-C', clone, 'rev-parse', `${pr.headSha}^{commit}`])).stdout.trim();
    }
  }

  let baseSha: string;
  if (gh?.baseRefOid) {
    await ensureCommit(clone, gh.baseRefOid);
    baseSha = gh.baseRefOid;
  } else {
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

export async function prDiff(clone: string, baseSha: string, headSha: string): Promise<{ diff: string; truncated: boolean }> {
  const res = await run('git', ['-C', clone, 'diff', '--no-color', `${baseSha}...${headSha}`], {
    timeoutMs: 60_000,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (res.code !== 0) return { diff: '', truncated: false };
  if (res.stdout.length <= MAX_DIFF_CHARS) return { diff: res.stdout, truncated: false };
  return { diff: res.stdout.slice(0, MAX_DIFF_CHARS), truncated: true };
}
