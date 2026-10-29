import type { AgentEvent, AskRequest, BackendStatus, CompanionMessage, ErrorCode, FixStep, ProgressStep } from '@quack/shared';
import { AGENT_TIMEOUT_MS } from '@quack/shared';
import { adapters } from './adapters/index.ts';
import { loadConfig } from './config.ts';
import { log } from './log.ts';
import { buildFollowUp, buildPrompt } from './prompt.ts';
import { prDiff, resolvePr } from './pr.ts';
import { findClone } from './repo.ts';
import { acquireLock, changedFiles, prepareWorktree, worktreePath } from './worktree.ts';

export type Send = (message: CompanionMessage) => void;
export type GetStatus = (backend: AskRequest['backend']) => Promise<BackendStatus>;

class AskError extends Error {
  code: ErrorCode;
  fixSteps?: FixStep[];
  constructor(code: ErrorCode, message: string, fixSteps?: FixStep[]) {
    super(message);
    this.code = code;
    this.fixSteps = fixSteps;
  }
}

export async function handleAsk(req: AskRequest, send: Send, signal: AbortSignal, getStatus: GetStatus): Promise<void> {
  const { requestId, pr } = req;
  const started = Date.now();
  const emit = (event: AgentEvent) => send({ type: 'event', requestId, event });
  const progress = (step: ProgressStep, detail?: string) => {
    log(requestId, step, `+${Date.now() - started}ms`);
    send({ type: 'progress', requestId, step, detail });
  };

  let release: (() => void) | null = null;
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), AGENT_TIMEOUT_MS);
  const agentSignal = AbortSignal.any([signal, timeout.signal]);

  try {
    const adapter = adapters[req.backend];
    const config = loadConfig();

    progress('finding_repo');
    const statusPromise = getStatus(req.backend);
    const clone = await findClone(config, pr.owner, pr.repo);
    if (!clone) {
      throw new AskError('repo_not_found', `No local clone of ${pr.owner}/${pr.repo} was found.`, [
        { text: `Clone it under one of: ${config.scanRoots.join(', ')}`, command: `git clone git@github.com:${pr.owner}/${pr.repo}.git` },
        { text: `Or map it in ~/.quack/config.json under "repoPaths": { "${pr.owner}/${pr.repo}": "/path/to/clone" }` },
      ]);
    }

    const status = await statusPromise;
    if (status.state === 'not_installed') throw new AskError('backend_not_installed', `${adapter.label} is not installed.`, status.fixSteps);
    if (status.state === 'not_logged_in') throw new AskError('backend_not_logged_in', `${adapter.label} is not logged in.`, status.fixSteps);
    if (signal.aborted) throw new AskError('cancelled', 'Stopped.');

    progress('fetching_pr');
    let ctx;
    try {
      ctx = await resolvePr(clone, pr);
    } catch (err) {
      throw new AskError('fetch_failed', `Could not fetch PR #${pr.number}: ${(err as Error).message}`, [
        { text: 'Check that git can reach GitHub from your clone', command: `git -C "${clone}" fetch origin` },
      ]);
    }
    if (signal.aborted) throw new AskError('cancelled', 'Stopped.');

    progress('preparing_worktree');
    const dir = worktreePath(config, pr.owner, pr.repo, pr.number);
    try {
      release = await acquireLock(dir, signal);
    } catch {
      throw new AskError('cancelled', 'Stopped.');
    }
    await prepareWorktree(clone, dir, ctx.headSha);
    log(requestId, 'worktree ready', `+${Date.now() - started}ms`);

    let prompt: string;
    if (req.sessionId) {
      prompt = buildFollowUp(req.selections, req.question);
    } else {
      const { diff, truncated } = await prDiff(clone, ctx.baseSha, ctx.headSha);
      prompt = buildPrompt({
        owner: pr.owner,
        repo: pr.repo,
        prNumber: pr.number,
        title: ctx.title,
        body: ctx.body,
        baseSha: ctx.baseSha,
        headSha: ctx.headSha,
        diff,
        diffTruncated: truncated,
        selections: req.selections,
        question: req.question,
      });
    }

    progress('starting_agent', adapter.label);
    let sessionId = req.sessionId;
    let model = req.model;
    let firstEvent = true;
    for await (const ev of adapter.ask({ cwd: dir, prompt, model: req.model, sessionId: req.sessionId, signal: agentSignal })) {
      if (firstEvent) {
        firstEvent = false;
        log(requestId, 'first agent event', `+${Date.now() - started}ms`);
      }
      switch (ev.type) {
        case 'session':
          sessionId = ev.sessionId;
          break;
        case 'model':
          model = ev.model;
          break;
        case 'text':
          emit({ type: 'text', delta: ev.delta });
          break;
        case 'tool':
          emit({ type: 'tool', summary: ev.summary });
          break;
        case 'error':
          throw new AskError('agent_failed', ev.message);
      }
    }

    if (timeout.signal.aborted) throw new AskError('timeout', `${adapter.label} timed out after ${AGENT_TIMEOUT_MS / 60_000} minutes.`);
    if (signal.aborted) throw new AskError('cancelled', 'Stopped.');

    const changed = await changedFiles(dir);
    if (changed.length) {
      log(requestId, `agent left ${changed.length} changed files in the worktree`);
      emit({ type: 'tool', summary: `Warning: the agent changed ${changed.length} file(s) in the worktree; they will be discarded.` });
    }
    log(requestId, 'done', `+${Date.now() - started}ms`);
    emit({ type: 'done', sessionId, headSha: ctx.headSha, model });
  } catch (err) {
    const e =
      err instanceof AskError
        ? err
        : timeout.signal.aborted
          ? new AskError('timeout', `Timed out after ${AGENT_TIMEOUT_MS / 60_000} minutes.`)
          : signal.aborted
            ? new AskError('cancelled', 'Stopped.')
            : new AskError('agent_failed', (err as Error).message);
    log(requestId, 'error', e.code, e.message);
    emit({ type: 'error', code: e.code, message: e.message, fixSteps: e.fixSteps });
  } finally {
    clearTimeout(timer);
    release?.();
  }
}
