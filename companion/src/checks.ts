import type { CheckRun, PrRef } from '@quack/shared';
import { findBinary, run } from './exec.ts';
import { log } from './log.ts';
import { isSafeBranch } from './validate.ts';

const FAILED_STATES = new Set(['FAILURE', 'ERROR', 'TIMED_OUT']);
const FAILED_CONCLUSIONS = new Set(['failure', 'timed_out', 'startup_failure']);
const TAIL_LINES = 200;
const PER_LOG_CHARS = 12_000;
const TOTAL_LOG_CHARS = 48_000;
const MAX_CHECKS = 6;

export interface CiLog {
  check: CheckRun;
  /** Tail of the failed log. Empty when it could not be read. */
  log: string;
  /** How often this workflow failed on the base branch recently. */
  recent?: { failed: number; total: number; branch: string };
}

export function parseRunLink(link: string): { runId?: string; jobId?: string } {
  const run = link.match(/\/actions\/runs\/(\d+)(?:\/job\/(\d+))?/);
  if (run) return { runId: run[1], ...(run[2] && { jobId: run[2] }) };
  const job = link.match(/\/runs\/(\d+)/);
  if (job) return { jobId: job[1] };
  return {};
}

export function tailLog(text: string, lines = TAIL_LINES, maxChars = PER_LOG_CHARS): string {
  const tail = text.trimEnd().split(/\r?\n/).slice(-lines).join('\n');
  return tail.length <= maxChars ? tail : tail.slice(tail.length - maxChars);
}

export function failureRate(conclusions: string[]): { failed: number; total: number } {
  return {
    failed: conclusions.filter((c) => FAILED_CONCLUSIONS.has(c)).length,
    total: conclusions.filter((c) => c && c !== 'skipped' && c !== 'cancelled').length,
  };
}

/** Workflow names become a gh argument, so they must not look like a flag. */
export function isSafeWorkflow(name: string): boolean {
  return /^[A-Za-z0-9._ /()+-]{1,200}$/.test(name) && !name.startsWith('-') && !name.includes('..');
}

/** Keeps the failing checks from `gh pr checks --json`. */
export function failingFromPayload(value: unknown): CheckRun[] {
  if (!Array.isArray(value)) return [];
  const checks: CheckRun[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const row = item as { name?: unknown; state?: unknown; bucket?: unknown; link?: unknown; workflow?: unknown };
    const bucket = typeof row.bucket === 'string' ? row.bucket : '';
    const state = typeof row.state === 'string' ? row.state : '';
    const failing = bucket ? bucket === 'fail' : FAILED_STATES.has(state);
    const name = typeof row.name === 'string' ? row.name.trim() : '';
    if (!failing || !name) continue;
    const link = typeof row.link === 'string' ? row.link : '';
    checks.push({
      name,
      workflow: typeof row.workflow === 'string' ? row.workflow : '',
      link,
      ...parseRunLink(link),
    });
  }
  return checks;
}

const repoArgs = (pr: PrRef) => ['--repo', `${pr.owner}/${pr.repo}`];

/** Failing checks on the PR. `available` is false when gh is missing or cannot answer. */
export async function listFailingChecks(pr: PrRef): Promise<{ failing: CheckRun[]; available: boolean }> {
  const gh = findBinary(['gh']);
  if (!gh) return { failing: [], available: false };
  const res = await run(gh, ['pr', 'checks', String(pr.number), ...repoArgs(pr), '--json', 'name,state,bucket,link,workflow'], {
    timeoutMs: 20_000,
  });
  const text = res.stdout.trim();
  if (text.startsWith('[')) {
    try {
      return { failing: failingFromPayload(JSON.parse(text)), available: true };
    } catch {
      log('gh pr checks returned invalid JSON');
    }
  }
  const err = `${res.stderr}\n${res.stdout}`.toLowerCase();
  if (err.includes('no checks')) return { failing: [], available: true };
  log('gh pr checks unavailable:', (res.stderr || res.stdout).trim().split('\n')[0]);
  return { failing: [], available: false };
}

async function baseBranch(gh: string, pr: PrRef): Promise<string | null> {
  if (pr.baseRef && isSafeBranch(pr.baseRef)) return pr.baseRef;
  const res = await run(gh, ['pr', 'view', String(pr.number), ...repoArgs(pr), '--json', 'baseRefName'], { timeoutMs: 20_000 });
  try {
    const name = (JSON.parse(res.stdout) as { baseRefName?: unknown }).baseRefName;
    return typeof name === 'string' && isSafeBranch(name) ? name : null;
  } catch {
    return null;
  }
}

async function failedLog(gh: string, pr: PrRef, check: CheckRun): Promise<string> {
  if (!check.runId && !check.jobId) return '';
  const args = ['run', 'view'];
  if (check.runId) args.push(check.runId);
  args.push(...repoArgs(pr), '--log-failed');
  if (check.jobId) args.push('--job', check.jobId);
  const res = await run(gh, args, { timeoutMs: 25_000, maxBuffer: 32 * 1024 * 1024 });
  if (!res.stdout.trim()) return '';
  return tailLog(res.stdout);
}

async function recentFailures(
  gh: string,
  pr: PrRef,
  workflow: string,
  branch: string,
): Promise<{ failed: number; total: number; branch: string } | undefined> {
  const res = await run(
    gh,
    ['run', 'list', ...repoArgs(pr), '--branch', branch, '--workflow', workflow, '--json', 'conclusion', '--limit', '20'],
    { timeoutMs: 20_000 },
  );
  if (res.code !== 0 || !res.stdout.trim()) return undefined;
  try {
    const rows = JSON.parse(res.stdout) as { conclusion?: unknown }[];
    if (!Array.isArray(rows) || !rows.length) return undefined;
    const rate = failureRate(rows.map((row) => (typeof row.conclusion === 'string' ? row.conclusion : '')));
    return rate.total > 0 ? { ...rate, branch } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Failing checks plus the tail of each failed log, and how that workflow has
 * been doing on the base branch. Stops early once the log budget is spent.
 */
export async function collectCi(pr: PrRef, signal: AbortSignal): Promise<{ checks: CiLog[]; available: boolean }> {
  const listed = await listFailingChecks(pr);
  if (!listed.available || signal.aborted) return { checks: [], available: listed.available && !signal.aborted };
  const gh = findBinary(['gh']);
  if (!gh) return { checks: [], available: false };
  const branch = await baseBranch(gh, pr);
  const checks: CiLog[] = [];
  let used = 0;
  for (const check of listed.failing.slice(0, MAX_CHECKS)) {
    if (signal.aborted || used >= TOTAL_LOG_CHARS) break;
    let tail = '';
    try {
      tail = await failedLog(gh, pr, check);
    } catch (err) {
      log('CI log failed', check.name, String(err));
    }
    if (used + tail.length > TOTAL_LOG_CHARS) tail = tail.slice(tail.length - (TOTAL_LOG_CHARS - used));
    used += tail.length;
    let recent: CiLog['recent'];
    if (branch && isSafeWorkflow(check.workflow) && !signal.aborted) {
      recent = await recentFailures(gh, pr, check.workflow, branch).catch(() => undefined);
    }
    checks.push({ check, log: tail, recent });
  }
  return { checks, available: true };
}
