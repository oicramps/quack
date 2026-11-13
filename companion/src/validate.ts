import type { AskRequest, AgentId, CodeSelection, ExtensionMessage, HistoryTurn, PrRef } from '@quack/shared';

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
const SHA = /^[0-9a-f]{7,40}$/;

/** A git object id, or null when the value could be a flag or a refspec. */
export function asCommitSha(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const sha = value.trim().toLowerCase();
  return SHA.test(sha) ? sha : null;
}
const BRANCH = /^[A-Za-z0-9._\/-]{1,250}$/;
// Models and session IDs are passed as CLI arguments; disallow leading dashes to prevent flag injection.
const MODEL = /^(?:[A-Za-z0-9][A-Za-z0-9._:\/-]{0,99})?$/;
const SESSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{1,100}$/;
const AGENTS: AgentId[] = ['cursor', 'claude-code'];

export class ValidationError extends Error {}

function fail(message: string): never {
  throw new ValidationError(message);
}

/** Validates that `p` is a relative repository path without `.` or `..` segments, backslashes, or null bytes. */
export function isSafeRepoPath(p: string): boolean {
  if (!p || p.length > 1000 || p.startsWith('/') || p.includes('\0') || p.includes('\\')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

/** Validates a git branch name against ref traversal (`..`, `.lock`) and CLI flag injection (`-`). */
export function isSafeBranch(name: string): boolean {
  return BRANCH.test(name) && !name.includes('..') && !name.startsWith('-') && !name.startsWith('/') && !name.endsWith('/') && !name.endsWith('.lock');
}

function validatePr(pr: unknown): PrRef {
  const p = pr as Partial<PrRef> | null;
  if (!p || typeof p !== 'object') fail('pr is required');
  if (typeof p.owner !== 'string' || !OWNER.test(p.owner)) fail('invalid owner');
  if (typeof p.repo !== 'string' || !REPO.test(p.repo) || p.repo === '.' || p.repo === '..') fail('invalid repo');
  if (!Number.isInteger(p.number) || (p.number as number) < 1 || (p.number as number) > 10_000_000) fail('invalid PR number');
  if (p.headSha !== undefined && (typeof p.headSha !== 'string' || !SHA.test(p.headSha))) fail('invalid headSha');
  if (p.baseRef !== undefined && (typeof p.baseRef !== 'string' || !isSafeBranch(p.baseRef))) fail('invalid baseRef');
  if (p.title !== undefined && typeof p.title !== 'string') fail('invalid title');
  return {
    owner: p.owner,
    repo: p.repo,
    number: p.number as number,
    headSha: p.headSha,
    baseRef: p.baseRef,
    title: p.title?.slice(0, 500),
  };
}

function validateSelection(s: unknown): CodeSelection {
  const sel = s as Partial<CodeSelection> | null;
  if (!sel || typeof sel !== 'object') fail('invalid selection');
  const out: CodeSelection = {};
  if (sel.path !== undefined) {
    if (typeof sel.path !== 'string' || !isSafeRepoPath(sel.path)) fail('invalid selection path');
    out.path = sel.path;
  }
  if (sel.fileAnchor !== undefined) {
    if (typeof sel.fileAnchor !== 'string' || !/^[0-9a-f]{64}$/.test(sel.fileAnchor)) fail('invalid fileAnchor');
    out.fileAnchor = sel.fileAnchor;
  }
  if (sel.side !== undefined) {
    if (sel.side !== 'old' && sel.side !== 'new') fail('invalid side');
    out.side = sel.side;
  }
  for (const key of ['startLine', 'endLine'] as const) {
    const v = sel[key];
    if (v !== undefined) {
      if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > 10_000_000) fail(`invalid ${key}`);
      out[key] = v as number;
    }
  }
  if (sel.text !== undefined) {
    if (typeof sel.text !== 'string') fail('invalid selection text');
    out.text = sel.text.slice(0, 20_000);
  }
  return out;
}

const MAX_HISTORY = 10;

function validateHistory(h: unknown): HistoryTurn[] {
  if (!Array.isArray(h) || h.length > MAX_HISTORY) fail('invalid history');
  return h.map((t) => {
    const turn = t as Partial<HistoryTurn> | null;
    if (!turn || typeof turn !== 'object' || typeof turn.question !== 'string' || typeof turn.answer !== 'string') fail('invalid history turn');
    return { question: turn.question.slice(0, 4000), answer: turn.answer.slice(0, 8000) };
  });
}

/** Validates and sanitizes an incoming JSON payload from the extension. Throws `ValidationError` on invalid input. */
export function validateMessage(raw: unknown): ExtensionMessage {
  const m = raw as { type?: unknown; requestId?: unknown } | null;
  if (!m || typeof m !== 'object') fail('message must be an object');
  if (typeof m.requestId !== 'string' || !REQUEST_ID.test(m.requestId)) fail('invalid requestId');
  switch (m.type) {
    case 'status':
    case 'cancel':
      return { type: m.type, requestId: m.requestId };
    case 'close_session': {
      const c = raw as { agent?: unknown; sessionId?: unknown };
      if (!AGENTS.includes(c.agent as AgentId)) fail('unknown agent');
      if (typeof c.sessionId !== 'string' || !SESSION.test(c.sessionId)) fail('invalid sessionId');
      return { type: 'close_session', requestId: m.requestId, agent: c.agent as AgentId, sessionId: c.sessionId };
    }
    case 'ask': {
      const a = raw as Partial<AskRequest>;
      if (!AGENTS.includes(a.agent as AgentId)) fail('unknown agent');
      if (typeof a.model !== 'string' || !MODEL.test(a.model)) fail('invalid model');
      if (typeof a.question !== 'string' || !a.question.trim() || a.question.length > 20_000) fail('invalid question');
      if (a.sessionId !== null && (typeof a.sessionId !== 'string' || !SESSION.test(a.sessionId))) fail('invalid sessionId');
      if (!Array.isArray(a.selections) || a.selections.length > 20) fail('invalid selections');
      if (a.task !== undefined && a.task !== 'explain_ci') fail('invalid task');
      return {
        type: 'ask',
        requestId: m.requestId,
        agent: a.agent as AgentId,
        model: a.model,
        pr: validatePr(a.pr),
        selections: a.selections.map(validateSelection),
        question: a.question,
        sessionId: a.sessionId ?? null,
        ...(a.history !== undefined && { history: validateHistory(a.history) }),
        ...(a.task !== undefined && { task: a.task }),
      };
    }
    case 'checks': {
      const c = raw as { pr?: unknown };
      return { type: 'checks', requestId: m.requestId, pr: validatePr(c.pr) };
    }
    default:
      fail('unknown message type');
  }
}
