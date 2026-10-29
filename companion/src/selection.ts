import crypto from 'node:crypto';
import type { CodeSelection } from '@quack/shared';
import { run } from './exec.ts';
import { log } from './log.ts';
import { isSafeRepoPath } from './validate.ts';

const MAX_LINES = 300;

/** GitHub names each file's diff anchor "diff-" + SHA-256 of its path. */
export function fileAnchor(path: string): string {
  return crypto.createHash('sha256').update(path).digest('hex');
}

async function changedPaths(clone: string, baseSha: string, headSha: string): Promise<string[]> {
  const res = await run('git', ['-C', clone, 'diff', '--name-only', '--no-renames', `${baseSha}...${headSha}`]);
  return res.code === 0 ? res.stdout.split('\n').filter(Boolean) : [];
}

/** Reads lines from a committed file with `git show`, so symlinks in the PR can't point outside the repo. */
async function readLines(clone: string, sha: string, path: string, start: number, end: number): Promise<string | undefined> {
  const res = await run('git', ['-C', clone, 'show', `${sha}:${path}`], { maxBuffer: 64 * 1024 * 1024 });
  if (res.code !== 0) return undefined;
  const lines = res.stdout.split('\n');
  const last = Math.min(end, start + MAX_LINES - 1, lines.length);
  return lines.slice(start - 1, last).join('\n');
}

/**
 * Fills in what the page couldn't provide: the file path (from GitHub's anchor
 * hash) and the selected code (from the PR's base or head commit).
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
