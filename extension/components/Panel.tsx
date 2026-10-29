import { type ReactNode, useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import type {
  BackendId,
  BackendStatus,
  CodeSelection,
  CompanionMessage,
  ErrorCode,
  FixStep,
  ProgressStep,
} from '@quack/shared';
import { QUACK_VERSION } from '@quack/shared';
import { type CompanionClient, newRequestId } from '../lib/client';
import { prKey, selectionLabel } from '../lib/github';
import type { PanelPage } from '../lib/page';
import { BackendPicker, ModelPicker, StatusDot, modelLabel } from './BackendPicker';
import { CommandBlock, FixSteps } from './FixSteps';
import {
  ArrowUp,
  Check,
  ChevronRight,
  Circle,
  Close,
  ErrorCircle,
  FileIcon,
  Plus,
  QuackMark,
  Retry,
  Search,
  Spinner,
  StopSquare,
  Terminal,
  Warning,
} from './icons';
import { Markdown, type RepoLink } from './Markdown';

interface Turn {
  id: string;
  question: string;
  selections: CodeSelection[];
  backend: BackendId;
  model: string;
  steps: { step: ProgressStep; at: number; detail?: string }[];
  activity: string[];
  text: string;
  status: 'running' | 'done' | 'error';
  error?: { code: ErrorCode | 'disconnected'; message: string; fixSteps?: FixStep[] };
  headSha?: string;
  startedAt: number;
  finishedAt?: number;
  /** First question of the thread, which also creates or refreshes the worktree. */
  first: boolean;
}

interface Thread {
  backend: BackendId;
  sessionId: string | null;
  turns: Turn[];
}

type Action =
  | { type: 'start'; key: string; turn: Turn }
  | { type: 'update'; key: string; id: string; patch: (t: Turn) => Partial<Turn> }
  | { type: 'session'; key: string; sessionId: string | null }
  | { type: 'reset'; key: string; backend: BackendId };

function threadsReducer(state: Record<string, Thread>, action: Action): Record<string, Thread> {
  const thread = state[action.key];
  switch (action.type) {
    case 'start': {
      const base = thread ?? { backend: action.turn.backend, sessionId: null, turns: [] };
      return { ...state, [action.key]: { ...base, turns: [...base.turns, action.turn] } };
    }
    case 'update':
      if (!thread) return state;
      return {
        ...state,
        [action.key]: { ...thread, turns: thread.turns.map((t) => (t.id === action.id ? { ...t, ...action.patch(t) } : t)) },
      };
    case 'session':
      if (!thread) return state;
      return { ...state, [action.key]: { ...thread, sessionId: action.sessionId } };
    case 'reset':
      return { ...state, [action.key]: { backend: action.backend, sessionId: null, turns: [] } };
  }
}

type Connection = { state: 'checking' } | { state: 'connected'; version: string } | { state: 'disconnected'; error: string };

interface Prefs {
  backend: BackendId;
  models: Partial<Record<BackendId, string>>;
  recentModels?: Partial<Record<BackendId, string[]>>;
}

const PREFS_KEY = 'quack.prefs';
const INSTALL_COMMAND = 'cd ~/Documents/Dev/Projects/quack && npm run install-host';
const SHORTCUT = /Mac/.test(navigator.platform) ? '⌘⇧K' : 'Ctrl+Shift+K';

const sameSelection = (a: CodeSelection, b: CodeSelection) =>
  a.path === b.path && a.fileAnchor === b.fileAnchor && a.side === b.side && a.startLine === b.startLine && a.endLine === b.endLine;

const shortSha = (sha?: string) => sha?.slice(0, 7);

function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

function duration(ms: number): string {
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1)} s`;
  if (s < 60) return `${Math.round(s)} s`;
  return `${Math.floor(s / 60)} min${s % 60 >= 1 ? ` ${Math.round(s % 60)} s` : ''}`;
}

export function Panel({ page, client }: { page: PanelPage; client: CompanionClient }) {
  const pr = page.pr;
  const key = pr ? prKey(pr) : '';

  const [connection, setConnection] = useState<Connection>({ state: 'checking' });
  const [backends, setBackends] = useState<BackendStatus[]>([]);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [prefs, setPrefs] = useState<Prefs>({ backend: 'cursor', models: {} });
  const [threads, dispatch] = useReducer(threadsReducer, {});
  const [chips, setChips] = useState<CodeSelection[]>([]);
  const [question, setQuestion] = useState('');
  const [running, setRunning] = useState<{ requestId: string; turnId: string } | null>(null);
  const [backendMenuOpen, setBackendMenuOpen] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const answerEndRef = useRef<HTMLDivElement>(null);
  const threadsRef = useRef(threads);
  threadsRef.current = threads;

  const thread = threads[key];
  const backend = prefs.backend;
  const backendStatus = backends.find((b) => b.id === backend);
  const modelFor = (id: BackendId) => prefs.models[id] ?? backends.find((b) => b.id === id)?.models[0] ?? '';
  const model = modelFor(backend);
  const offline = connection.state === 'disconnected';

  useEffect(() => {
    browser.storage.local.get(PREFS_KEY).then((r) => {
      const saved = r[PREFS_KEY] as Prefs | undefined;
      if (saved?.backend) setPrefs(saved);
    });
  }, []);

  const savePrefs = (next: Prefs) => {
    setPrefs(next);
    browser.storage.local.set({ [PREFS_KEY]: next });
  };

  const checkStatus = useCallback(() => {
    // Keep the offline screen up while retrying instead of flashing "Connecting".
    setConnection((c) => (c.state === 'disconnected' ? c : { state: 'checking' }));
    const requestId = newRequestId();
    client.send({ type: 'status', requestId }, (msg) => {
      if (msg.type !== 'status') return;
      setConnection({ state: 'connected', version: msg.version });
      setBackends(msg.backends);
      setCheckedAt(Date.now());
    });
  }, [client]);

  useEffect(() => {
    checkStatus();
    return client.onDisconnect((error, requestIds) => {
      setConnection({ state: 'disconnected', error });
      setRunning((r) => (r && requestIds.includes(r.requestId) ? null : r));
      for (const k of Object.keys(threadsRef.current)) {
        for (const t of threadsRef.current[k].turns) {
          if (t.status === 'running') {
            dispatch({
              type: 'update',
              key: k,
              id: t.id,
              patch: () => ({ status: 'error', finishedAt: Date.now(), error: { code: 'disconnected', message: `Companion disconnected: ${error}` } }),
            });
          }
        }
      }
    });
  }, [client, checkStatus]);

  // The offline screen promises a retry every 5 s.
  useEffect(() => {
    if (!offline) return;
    const id = setInterval(checkStatus, 5000);
    return () => clearInterval(id);
  }, [offline, checkStatus]);

  // Shortcut or in-page button: attach the selection and focus the input.
  useEffect(() => {
    const { seq, selection } = page.attachRequest;
    if (!seq) return;
    if (selection) addChip(selection);
    setTimeout(() => inputRef.current?.focus(), 0);
  }, [page.attachRequest.seq]);

  useEffect(() => {
    answerEndRef.current?.scrollIntoView({ block: 'end' });
  }, [thread?.turns.at(-1)?.text.length, thread?.turns.at(-1)?.activity.length, thread?.turns.length]);

  // Esc stops a running answer (unless it is closing a menu).
  useEffect(() => {
    if (!running) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('.menu-popover')) stop();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [running]);

  function addChip(selection: CodeSelection) {
    setChips((prev) => (prev.some((c) => sameSelection(c, selection)) ? prev : [...prev, selection]));
  }

  function selectBackend(id: BackendId) {
    if (id === backend) return;
    savePrefs({ ...prefs, backend: id });
    if (key && thread?.turns.length) dispatch({ type: 'reset', key, backend: id });
  }

  function selectModel(m: string) {
    const recent = [m, ...(prefs.recentModels?.[backend] ?? []).filter((r) => r !== m)].slice(0, 5);
    savePrefs({ ...prefs, models: { ...prefs.models, [backend]: m }, recentModels: { ...prefs.recentModels, [backend]: recent } });
  }

  function ask(text = question, selections = chips, useBackend = backend) {
    const status = backends.find((b) => b.id === useBackend);
    if (!pr || !text.trim() || running || status?.state !== 'ready') return;
    const useModel = modelFor(useBackend);
    const current = threadsRef.current[key];
    const continuing = !!current && current.backend === useBackend && current.turns.length > 0;
    if (current && current.backend !== useBackend) dispatch({ type: 'reset', key, backend: useBackend });

    const requestId = newRequestId();
    const turn: Turn = {
      id: requestId,
      question: text.trim(),
      selections,
      backend: useBackend,
      model: useModel,
      steps: [],
      activity: [],
      text: '',
      status: 'running',
      startedAt: Date.now(),
      first: !continuing,
    };
    const turnKey = key;
    dispatch({ type: 'start', key: turnKey, turn });
    setRunning({ requestId, turnId: turn.id });
    setQuestion('');
    setChips([]);

    const update = (patch: (t: Turn) => Partial<Turn>) => dispatch({ type: 'update', key: turnKey, id: turn.id, patch });
    client.send(
      {
        type: 'ask',
        requestId,
        backend: useBackend,
        model: useModel,
        pr: { owner: pr.owner, repo: pr.repo, number: pr.number, headSha: pr.headSha, baseRef: pr.baseRef, title: pr.title },
        selections: turn.selections,
        question: turn.question,
        sessionId: continuing ? (current?.sessionId ?? null) : null,
      },
      (msg: CompanionMessage) => {
        if (msg.type === 'progress') {
          update((t) => ({ steps: [...t.steps, { step: msg.step, at: Date.now(), detail: msg.detail }] }));
        } else if (msg.type === 'event') {
          const ev = msg.event;
          if (ev.type === 'text') update((t) => ({ text: t.text + ev.delta }));
          else if (ev.type === 'tool') update((t) => ({ activity: [...t.activity, ev.summary] }));
          else if (ev.type === 'done') {
            update(() => ({ status: 'done', finishedAt: Date.now(), headSha: ev.headSha, model: ev.model || turn.model }));
            dispatch({ type: 'session', key: turnKey, sessionId: ev.sessionId });
            setRunning(null);
          } else if (ev.type === 'error') {
            update(() => ({ status: 'error', finishedAt: Date.now(), error: { code: ev.code, message: ev.message, fixSteps: ev.fixSteps } }));
            setRunning(null);
            if (ev.code === 'backend_not_installed' || ev.code === 'backend_not_logged_in') checkStatus();
          }
        }
      },
    );
  }

  function stop() {
    if (!running) return;
    client.send({ type: 'cancel', requestId: running.requestId });
  }

  function retry(turn: Turn, withBackend?: BackendId) {
    if (withBackend) {
      savePrefs({ ...prefs, backend: withBackend });
      ask(turn.question, turn.selections, withBackend);
    } else {
      ask(turn.question, turn.selections, turn.backend);
    }
  }

  const otherReadyBackend = useMemo(() => backends.find((b) => b.id !== backend && b.state === 'ready'), [backends, backend]);
  const lastTurn = thread?.turns.at(-1);

  // Newest commit the companion reported for this PR.
  const knownSha = useMemo(() => {
    for (const t of [...(thread?.turns ?? [])].reverse()) {
      const sha = t.headSha ?? t.steps.find((s) => s.step === 'preparing_worktree')?.detail;
      if (sha) return sha;
    }
    return pr?.headSha;
  }, [thread, pr?.headSha]);

  const repoLink: RepoLink | null = pr ? { owner: pr.owner, repo: pr.repo, sha: knownSha } : null;

  if (!pr) {
    return (
      <div className="quack panel">
        <div className="body">
          <section className="intro">
            <h2 className="brand">
              <QuackMark size={24} /> Quack
            </h2>
            <p className="muted">Open a pull request on github.com to ask about its code.</p>
          </section>
        </div>
      </div>
    );
  }

  const status: { tone: 'ok' | 'warn' | 'err' | 'idle' | 'busy'; text: string } = offline
    ? { tone: 'warn', text: 'Companion offline' }
    : connection.state === 'checking'
      ? { tone: 'idle', text: 'Connecting…' }
      : running
        ? { tone: 'busy', text: 'Working…' }
        : lastTurn?.status === 'error' && lastTurn.error?.code !== 'cancelled'
          ? { tone: 'err', text: 'Error' }
          : backendStatus && backendStatus.state !== 'ready'
            ? { tone: 'warn', text: backendStatus.state === 'not_installed' ? 'Not installed' : 'Not logged in' }
            : { tone: 'ok', text: 'Ready' };

  const versionMismatch = connection.state === 'connected' && connection.version !== QUACK_VERSION;
  const canAttach = page.lastSelection && !chips.some((c) => sameSelection(c, page.lastSelection!));
  const canAsk = !!question.trim() && backendStatus?.state === 'ready' && !running;
  const hint = backendMenuOpen
    ? 'Switching backend starts a new thread'
    : running
      ? lastTurn && !lastTurn.text && !lastTurn.activity.length
        ? 'Esc cancels'
        : 'You can type while it answers'
      : thread?.turns.length
        ? 'Keeps this thread’s context'
        : 'Enter to send · Shift+Enter for a new line';

  return (
    <div className="quack panel">
      <header className="header">
        <div className="title-row">
          <QuackMark size={16} className="logo" />
          <span className="pr-number">#{pr.number}</span>
          <span className="pr-title" title={pr.title}>
            {pr.title ?? ''}
          </span>
          {knownSha && <code className="sha">{shortSha(knownSha)}</code>}
        </div>
        <div className="picker-row">
          <BackendPicker
            backends={backends}
            selected={backend}
            companionVersion={connection.state === 'connected' ? connection.version : undefined}
            checkedAt={checkedAt}
            offline={offline}
            onSelect={selectBackend}
            onRecheck={checkStatus}
            onOpenChange={setBackendMenuOpen}
          />
          <ModelPicker
            status={backendStatus}
            model={model}
            recent={prefs.recentModels?.[backend] ?? []}
            disabled={offline}
            onChange={selectModel}
          />
          <span className={`status ${status.tone}`} title={status.text}>
            <StatusDot tone={status.tone === 'busy' ? 'ok' : status.tone} /> <span className="status-text">{status.text}</span>
          </span>
        </div>
      </header>

      {page.notice && <Banner>{page.notice}</Banner>}
      {versionMismatch && connection.state === 'connected' && (
        <Banner>
          Companion {connection.version} doesn’t match extension {QUACK_VERSION}. Reinstall it:
          <CommandBlock command={INSTALL_COMMAND} />
        </Banner>
      )}

      <main className="body" aria-live="polite">
        {offline ? (
          <CompanionOffline error={connection.error} onRetry={checkStatus} />
        ) : (
          <>
            {!thread?.turns.length && connection.state === 'connected' && (
              <Intro pr={pr} sha={knownSha} hasChips={chips.length > 0} />
            )}
            {backendStatus && backendStatus.state !== 'ready' && !lastTurn?.error?.fixSteps && (
              <BackendSetup status={backendStatus} onRecheck={checkStatus} />
            )}
            {thread?.turns.map((turn) => (
              <TurnView
                key={turn.id}
                turn={turn}
                pr={pr}
                link={repoLink!}
                onStop={stop}
                onRetry={() => retry(turn)}
                onRecheck={checkStatus}
                otherBackend={otherReadyBackend}
                onRetryOther={(id) => retry(turn, id)}
              />
            ))}
            {thread?.turns.length && !running ? (
              <button type="button" className="ghost new-thread" onClick={() => dispatch({ type: 'reset', key, backend })}>
                Start a new thread
              </button>
            ) : null}
            <div ref={answerEndRef} />
          </>
        )}
      </main>

      <footer className="composer">
        {offline ? (
          <div className="composer-disabled">Connect the companion to ask</div>
        ) : (
          <>
            <div className="attachments" aria-label="Attached context">
              {!chips.length && !canAttach && <span className="muted small">No code attached · asks about the whole PR</span>}
              {chips.map((c, i) => (
                <span key={i} className="chip">
                  <FileIcon size={12} />
                  <span className="chip-label">{selectionLabel(c)}</span>
                  <button
                    type="button"
                    className="ghost icon-only"
                    aria-label={`Remove ${selectionLabel(c)}`}
                    onClick={() => setChips(chips.filter((_, j) => j !== i))}
                  >
                    <Close size={12} />
                  </button>
                </span>
              ))}
              {canAttach && (
                <button
                  type="button"
                  className="chip add"
                  title="Attach the lines you selected in the diff"
                  onClick={() => addChip(page.lastSelection!)}
                >
                  <Plus size={12} />
                  <span className="chip-label">{selectionLabel(page.lastSelection!)}</span>
                </button>
              )}
            </div>
            <div className="input-box">
              <textarea
                ref={inputRef}
                value={question}
                rows={Math.min(6, Math.max(2, question.split('\n').length))}
                placeholder={thread?.turns.length ? 'Ask a follow-up…' : chips.length ? 'Ask about this code…' : 'Ask about this PR…'}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    ask();
                  }
                }}
                disabled={connection.state !== 'connected'}
                aria-label="Question"
              />
              <div className="input-foot">
                <span className="muted small">{hint}</span>
                {running ? (
                  <button type="button" className="secondary" onClick={stop}>
                    <StopSquare /> Stop <kbd>Esc</kbd>
                  </button>
                ) : (
                  <button type="button" className={question.trim() ? 'primary' : 'secondary'} onClick={() => ask()} disabled={!canAsk}>
                    Ask <ArrowUp size={14} />
                  </button>
                )}
              </div>
            </div>
          </>
        )}
      </footer>
    </div>
  );
}

function Banner({ children }: { children: ReactNode }) {
  return (
    <div className="banner" role="status">
      <Warning size={16} />
      <div>{children}</div>
    </div>
  );
}

function Intro({ pr, sha, hasChips }: { pr: NonNullable<PanelPage['pr']>; sha?: string; hasChips: boolean }) {
  return (
    <section className="intro">
      <h2>Ask about this pull request</h2>
      {hasChips ? (
        <p className="muted">
          Answers read the code at {sha ? <code>{shortSha(sha)}</code> : 'the PR’s latest commit'} plus whatever you attach below. Nothing is
          posted until you choose to.
        </p>
      ) : (
        <>
          {(pr.headRef || pr.baseRef || sha) && (
            <dl className="facts">
              {(pr.headRef || pr.baseRef) && (
                <>
                  <dt>Branch</dt>
                  <dd className="mono">
                    {pr.headRef ?? '…'} → {pr.baseRef ?? '…'}
                  </dd>
                </>
              )}
              {sha && (
                <>
                  <dt>Commit</dt>
                  <dd className="mono">{shortSha(sha)}</dd>
                </>
              )}
            </dl>
          )}
          <p className="tip">
            <FileIcon size={14} /> Select lines in the diff to ask about specific code <kbd>{SHORTCUT}</kbd>
          </p>
        </>
      )}
    </section>
  );
}

function BackendSetup({ status, onRecheck }: { status: BackendStatus; onRecheck: () => void }) {
  return (
    <section className="setup-card">
      <div className="setup-head">
        <span className="setup-icon">
          <Terminal size={18} />
        </span>
        <div>
          <h3>
            {status.label} {status.state === 'not_installed' ? 'isn’t installed' : 'isn’t logged in'}
          </h3>
          <p className="muted">Follow these steps, then re-check. Or pick another backend above.</p>
        </div>
      </div>
      <FixSteps steps={status.fixSteps} />
      <div className="row">
        <button type="button" className="primary" onClick={onRecheck}>
          <Retry size={14} /> Re-check
        </button>
      </div>
    </section>
  );
}

function CompanionOffline({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <section className="offline">
      <div className="setup-head">
        <span className="setup-icon">
          <Terminal size={18} />
        </span>
        <div>
          <h2>Can’t reach the companion</h2>
          <p className="muted">
            The panel needs the local companion to run agents against this PR’s code. Once it’s installed, your browser starts it automatically.
          </p>
        </div>
      </div>
      <h3>1. Install it once</h3>
      <CommandBlock command={INSTALL_COMMAND} />
      <h3>2. Restart your browser</h3>
      <p>It then picks up the companion. No terminal needs to stay open.</p>
      <div className="row center">
        <button type="button" className="primary" onClick={onRetry}>
          <Retry size={14} /> Retry connection
        </button>
        <span className="muted">Also retrying every 5 s</span>
      </div>
      <p className="muted small">
        Already installed? Run the install command again to repair it. Details: {error}
      </p>
    </section>
  );
}

const STEP_ORDER: ProgressStep[] = ['finding_repo', 'fetching_pr', 'preparing_worktree', 'starting_agent'];

function backendLabel(id: BackendId): string {
  return id === 'cursor' ? 'Cursor' : 'Claude Code';
}

function PrepCard({ turn, pr, onCancel }: { turn: Turn; pr: NonNullable<PanelPage['pr']>; onCancel: () => void }) {
  const current = turn.steps.at(-1)?.step ?? 'finding_repo';
  const currentIndex = STEP_ORDER.indexOf(current);
  const label = (step: ProgressStep, detail?: string) => {
    switch (step) {
      case 'finding_repo':
        return 'Finding local clone';
      case 'fetching_pr':
        return `Fetching PR #${pr.number}`;
      case 'preparing_worktree':
        return detail ? (
          <>
            Preparing worktree at <code>{shortSha(detail)}</code>
          </>
        ) : (
          'Preparing worktree'
        );
      case 'starting_agent':
        return `Starting ${backendLabel(turn.backend)}`;
    }
  };
  return (
    <section className="prep-card" aria-label="Preparing">
      <div className="prep-head">
        <strong>Getting the PR code ready</strong>
        <span className="muted small">{turn.first ? 'First question on this PR' : 'Follow-up'}</span>
      </div>
      <ol className="prep-steps">
        {STEP_ORDER.map((step, i) => {
          const entry = turn.steps.find((s) => s.step === step);
          const next = turn.steps.find((s) => s.step === STEP_ORDER[i + 1]);
          const state = i < currentIndex ? 'done' : i === currentIndex ? 'current' : 'waiting';
          return (
            <li key={step} className={state}>
              <span className="prep-icon">
                {state === 'done' ? <Check size={12} /> : state === 'current' ? <Spinner size={16} /> : <Circle size={16} />}
              </span>
              <span className="prep-label">{label(step, entry?.detail)}</span>
              <span className="muted small prep-state">
                {state === 'done' ? `Done${entry && next ? ` · ${duration(next.at - entry.at)}` : ''}` : state === 'current' ? 'In progress' : 'Waiting'}
              </span>
            </li>
          );
        })}
      </ol>
      <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={STEP_ORDER.length} aria-valuenow={currentIndex}>
        <span style={{ width: `${((currentIndex + 0.5) / STEP_ORDER.length) * 100}%` }} />
      </div>
      <div className="row end">
        <button type="button" className="secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </section>
  );
}

function activityIcon(summary: string) {
  if (summary.startsWith('Search')) return <Search size={14} />;
  if (summary.startsWith('Ran')) return <Terminal size={14} />;
  return <FileIcon size={14} />;
}

function activitySummary(activity: string[]): string {
  const count = (prefix: string) => activity.filter((a) => a.startsWith(prefix)).length;
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const reads = count('Read ');
  const searches = count('Searched ');
  const lists = count('Listed ');
  const commands = count('Ran ');
  const other = activity.length - reads - searches - lists - commands;
  const parts = [
    reads && `Read ${plural(reads, 'file', 'files')}`,
    searches && plural(searches, 'search', 'searches'),
    lists && plural(lists, 'listing', 'listings'),
    commands && plural(commands, 'command', 'commands'),
    other && plural(other, 'other step', 'other steps'),
  ].filter(Boolean);
  return parts.join(' · ');
}

function errorTitle(code: ErrorCode | 'disconnected', backend: string): string {
  switch (code) {
    case 'repo_not_found':
      return 'No local clone found';
    case 'fetch_failed':
      return 'Couldn’t fetch the PR';
    case 'backend_not_installed':
      return `${backend} isn’t installed`;
    case 'backend_not_logged_in':
      return `${backend} isn’t logged in`;
    case 'timeout':
      return `${backend} timed out`;
    case 'agent_failed':
      return `${backend} failed`;
    case 'disconnected':
      return 'Companion disconnected';
    case 'version_mismatch':
      return 'Companion needs updating';
    default:
      return 'Something went wrong';
  }
}

function TurnView({
  turn,
  pr,
  link,
  onStop,
  onRetry,
  onRecheck,
  otherBackend,
  onRetryOther,
}: {
  turn: Turn;
  pr: NonNullable<PanelPage['pr']>;
  link: RepoLink;
  onStop: () => void;
  onRetry: () => void;
  onRecheck: () => void;
  otherBackend?: BackendStatus;
  onRetryOther: (id: BackendId) => void;
}) {
  const [activityOpen, setActivityOpen] = useState(false);
  const isRunning = turn.status === 'running';
  const now = useNow(isRunning);
  const preparing = isRunning && !turn.text && !turn.activity.length;
  const elapsed = duration((turn.finishedAt ?? now) - turn.startedAt);
  const label = backendLabel(turn.backend);
  const error = turn.error;
  const cancelled = error?.code === 'cancelled';
  const sha = turn.headSha ?? turn.steps.find((s) => s.step === 'preparing_worktree')?.detail;

  const meta = isRunning ? (
    <>
      <Spinner size={14} /> {preparing ? 'Resuming the conversation' : 'Answering'} · {elapsed}
    </>
  ) : turn.status === 'done' ? (
    <>
      {elapsed}
      {sha && (
        <>
          {' '}
          · at <code>{shortSha(sha)}</code>
        </>
      )}
    </>
  ) : cancelled ? (
    `Stopped after ${elapsed}`
  ) : (
    `Failed after ${elapsed}`
  );

  return (
    <article className="turn">
      <section className="question" aria-label="Your question">
        <div className="question-head">
          <span className="you">You</span>
          {turn.selections.map((s, i) => (
            <span key={i} className="pill mono">
              {selectionLabel(s)}
            </span>
          ))}
        </div>
        <p>{turn.question}</p>
      </section>

      {preparing && turn.first ? (
        <PrepCard turn={turn} pr={pr} onCancel={onStop} />
      ) : (
        <section className="answer" aria-label="Answer">
          <div className="answer-head">
            <span className="badge">
              {label} · {modelLabel(turn.backend, turn.model)}
            </span>
            <span className="muted meta">{meta}</span>
          </div>

          {turn.activity.length > 0 &&
            (isRunning || activityOpen ? (
              <ul className="activity">
                {turn.activity.map((a, i) => {
                  const live = isRunning && i === turn.activity.length - 1 && !turn.text;
                  return (
                    <li key={i}>
                      {live ? <Spinner size={14} /> : activityIcon(a)}
                      <span>{a}</span>
                    </li>
                  );
                })}
                {!isRunning && (
                  <li>
                    <button type="button" className="link small" onClick={() => setActivityOpen(false)}>
                      Hide steps
                    </button>
                  </li>
                )}
              </ul>
            ) : (
              <button type="button" className="activity-toggle" onClick={() => setActivityOpen(true)}>
                <ChevronRight size={14} /> {activitySummary(turn.activity)}
                {cancelled || error ? ' before it stopped' : ''}
              </button>
            ))}

          {turn.text && <Markdown text={turn.text} link={link} streaming={isRunning} />}

          {error && cancelled && (
            <div className="row">
              <button type="button" className="secondary" onClick={onRetry}>
                <Retry size={14} /> Ask again
              </button>
            </div>
          )}

          {error && !cancelled && (
            <div className="error-card" role="alert">
              <div className="error-title">
                <ErrorCircle size={16} />
                <span>
                  <span className="err">Error</span> · <strong>{errorTitle(error.code, label)}</strong>
                </span>
              </div>
              <p>{error.message}</p>
              {error.fixSteps && error.fixSteps.length > 0 && <FixSteps steps={error.fixSteps} />}
              <code className="error-meta">
                {error.code}
                {sha ? ` · worktree ${shortSha(sha)}` : ''}
              </code>
              <div className="row">
                {(error.code === 'backend_not_installed' || error.code === 'backend_not_logged_in') && (
                  <button type="button" className="secondary" onClick={onRecheck}>
                    <Retry size={14} /> Re-check
                  </button>
                )}
                <button type="button" className="primary" onClick={onRetry}>
                  <Retry size={14} /> Retry
                </button>
                {otherBackend && (
                  <button type="button" className="secondary" onClick={() => onRetryOther(otherBackend.id)}>
                    Retry with {otherBackend.label}
                  </button>
                )}
                <button
                  type="button"
                  className="link"
                  onClick={() => navigator.clipboard.writeText(`${error.code}: ${error.message}${sha ? ` (worktree ${sha})` : ''}`)}
                >
                  Copy log
                </button>
              </div>
            </div>
          )}
        </section>
      )}
    </article>
  );
}
