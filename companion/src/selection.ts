import crypto from 'node:crypto';
import type { CodeSelection } from '@quack/shared';
import { runGit } from './exec.ts';
import { log } from './log.ts';
import { asCommitSha, isSafeRepoPath } from './validate.ts';

const MAX_LINES = 300;

/** GitHub names each file's diff anchor "diff-" + SHA-256 of its path. */
export function fileAnchor(path: string): string {
  return crypto.createHash('sha256').update(path).digest('hex');
}

async function changedPaths(clone: string, baseSha: string, headSha: string): Promise<string[]> {
  const base = asCommitSha(baseSha);
  const head = asCommitSha(headSha);
  if (!base || !head) return [];
  const res = await runGit(['-C', clone, 'diff', '--name-only', '--no-renames', `${base}...${head}`]);
  return res.code === 0 ? res.stdout.split('\n').filter(Boolean) : [];
}

/** Reads lines from a committed file with `git show`, so symlinks in the PR can't point outside the repo. */
async function readLines(clone: string, sha: string, path: string, start: number, end: number): Promise<string | undefined> {
  const commit = asCommitSha(sha);
  if (!commit) return undefined;
  const res = await runGit(['-C', clone, 'show', `${commit}:${path}`], { maxBuffer: 64 * 1024 * 1024 });
  if (res.code !== 0) return undefined;
  const lines = res.stdout.split('\n');
  const last = Math.min(end, start + MAX_LINES - 1, lines.length);
  return lines.slice(start - 1, last).join('\n');
}

/**
 * Resolves selection file paths (by matching GitHub's SHA-256 diff anchor against
 * changed paths) and loads missing snippet text from the base or head commit.
 */
export async function resolveSelections(
  clone: string,
  baseSha: string,
  headSha: string,
  selections: CodeSelection[],
): Promise<CodeSelection[]> {
  let paths: string[] | null = null;
  const out: CodeSelection[] = [];
  for (const s of selections) {
    const sel = { ...s };
    if (!sel.path && sel.fileAnchor) {
      paths ??= await changedPaths(clone, baseSha, headSha);
      sel.path = paths.find((p) => fileAnchor(p) === sel.fileAnchor);
      if (!sel.path) log('no changed file matches a selection anchor');
    }
    if (!sel.text && sel.path && isSafeRepoPath(sel.path) && sel.startLine) {
      const sha = sel.side === 'old' ? baseSha : headSha;
      sel.text = await readLines(clone, sha, sel.path, sel.startLine, sel.endLine ?? sel.startLine);
    }
    out.push(sel);
  }
  return out;
}
