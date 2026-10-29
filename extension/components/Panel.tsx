import { useCallback, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from 'react';
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
import { PROGRESS_LABELS, QUACK_VERSION } from '@quack/shared';
import { type CompanionClient, newRequestId } from '../lib/client';
import { githubTheme, prKey, selectionLabel } from '../lib/github';
import { PANEL_WIDTH, RAIL_WIDTH, type PageStore, setDock } from '../lib/page';
import { BackendPicker } from './BackendPicker';
import { FixSteps } from './FixSteps';

interface Turn {
  id: string;
  question: string;
  selections: CodeSelection[];
  backend: BackendId;
  model: string;
  steps: ProgressStep[];
  activity: string[];
  text: string;
  status: 'running' | 'done' | 'error';
  error?: { code: ErrorCode | 'disconnected'; message: string; fixSteps?: FixStep[] };
  headSha?: string;
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
}

const PREFS_KEY = 'quack.prefs';

export function Panel({ store, client }: { store: PageStore; client: CompanionClient }) {
  const page = useSyncExternalStore(store.subscribe, store.get);
  const pr = page.pr;
  const key = pr ? prKey(pr) : '';

  const [connection, setConnection] = useState<Connection>({ state: 'checking' });
  const [backends, setBackends] = useState<BackendStatus[]>([]);
  const [prefs, setPrefs] = useState<Prefs>({ backend: 'cursor', models: {} });
  const [threads, dispatch] = useReducer(threadsReducer, {});
  const [chips, setChips] = useState<CodeSelection[]>([]);
  const [question, setQuestion] = useState('');
  const [running, setRunning] = useState<{ requestId: string; turnId: string } | null>(null);
  const [theme, setTheme] = useState(githubTheme());
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const answerEndRef = useRef<HTMLDivElement>(null);

  const thread = threads[key];
  const backend = prefs.backend;
  const backendStatus = backends.find((b) => b.id === backend);
  const model = prefs.models[backend] ?? backendStatus?.models[0] ?? '';

  // Dock: reserve space for the panel or the collapsed rail.
  useEffect(() => {
    setDock(page.open ? PANEL_WIDTH : RAIL_WIDTH);
    return () => setDock(0);
  }, [page.open]);

  // Follow GitHub's light/dark theme.
  useEffect(() => {
    const update = () => setTheme(githubTheme());
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-color-mode', 'data-dark-theme'] });
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', update);
    return () => {
      observer.disconnect();
      mq.removeEventListener('change', update);
    };
  }, []);

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
    setConnection({ state: 'checking' });
    const requestId = newRequestId();
    client.send({ type: 'status', requestId }, (msg) => {
      if (msg.type !== 'status') return;
      setConnection({ state: 'connected', version: msg.version });
      setBackends(msg.backends);
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
            dispatch({ type: 'update', key: k, id: t.id, patch: () => ({ status: 'error', error: { code: 'disconnected', message: `Companion disconnected: ${error}` } }) });
          }
        }
      }
    });
  }, [client, checkStatus]);

  const threadsRef = useRef(threads);
  threadsRef.current = threads;

  // Shortcut: attach the current selection and focus the input.
  useEffect(() => {
    const { seq, selection } = page.attachRequest;
    if (!seq) return;
    if (selection) addChip(selection);
    setTimeout(() => inputRef.current?.focus(), 0);
  }, [page.attachRequest.seq]);

  useEffect(() => {
    answerEndRef.current?.scrollIntoView({ block: 'end' });
  }, [thread?.turns.at(-1)?.text.length, thread?.turns.length]);

  // Esc stops a running answer.
  useEffect(() => {
    if (!running) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') stop();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [running]);

  function addChip(selection: CodeSelection) {
    setChips((prev) =>
      prev.some((c) => c.path === selection.path && c.startLine === selection.startLine && c.endLine === selection.endLine)
        ? prev
        : [...prev, selection],
    );
  }

  function selectBackend(id: BackendId) {
    if (id === backend) return;
    savePrefs({ ...prefs, backend: id });
    if (key) dispatch({ type: 'reset', key, backend: id });
  }

  function selectModel(m: string) {
    savePrefs({ ...prefs, models: { ...prefs.models, [backend]: m } });
  }

  function ask() {
    if (!pr || !question.trim() || running) return;
    if (thread && thread.backend !== backend) dispatch({ type: 'reset', key, backend });
    const requestId = newRequestId();
    const turn: Turn = {
      id: requestId,
      question: question.trim(),
      selections: chips,
      backend,
      model,
      steps: [],
      activity: [],
      text: '',
      status: 'running',
    };
    const sessionId = thread && thread.backend === backend ? thread.sessionId : null;
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
        backend,
        model,
        pr: { owner: pr.owner, repo: pr.repo, number: pr.number, headSha: pr.headSha, baseRef: pr.baseRef, title: pr.title },
        selections: turn.selections,
        question: turn.question,
        sessionId,
      },
      (msg: CompanionMessage) => {
        if (msg.type === 'progress') {
          update((t) => ({ steps: [...t.steps, msg.step] }));
        } else if (msg.type === 'event') {
          const ev = msg.event;
          if (ev.type === 'text') update((t) => ({ text: t.text + ev.delta }));
          else if (ev.type === 'tool') update((t) => ({ activity: [...t.activity, ev.summary] }));
          else if (ev.type === 'done') {
            update(() => ({ status: 'done', headSha: ev.headSha, model: ev.model || turn.model }));
            dispatch({ type: 'session', key: turnKey, sessionId: ev.sessionId });
            setRunning(null);
          } else if (ev.type === 'error') {
            update(() => ({ status: 'error', error: { code: ev.code, message: ev.message, fixSteps: ev.fixSteps } }));
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
    if (withBackend) selectBackend(withBackend);
    setQuestion(turn.question);
    setChips(turn.selections);
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  const versionMismatch = connection.state === 'connected' && connection.version !== QUACK_VERSION;
  const otherReadyBackend = useMemo(() => backends.find((b) => b.id !== backend && b.state === 'ready'), [backends, backend]);

  if (!pr) return null;

  if (!page.open) {
    return (
      <div className="quack rail" data-theme={theme}>
        <button className="rail-button" onClick={() => store.set({ open: true })} title="Open Quack (Cmd/Ctrl+Shift+K)" aria-label="Open Quack">
          Q
        </button>
      </div>
    );
  }

  return (
    <div className="quack panel" data-theme={theme} style={{ width: PANEL_WIDTH }}>
      <header className="header">
        <div className="title-row">
          <span className="pr-title" title={pr.title}>
            #{pr.number} {pr.title ?? ''}
          </span>
          {thread?.turns.at(-1)?.headSha && <code className="sha">{thread.turns.at(-1)!.headSha!.slice(0, 7)}</code>}
          <button className="icon" onClick={() => store.set({ open: false })} aria-label="Collapse panel" title="Collapse">
            ⟩
          </button>
        </div>
        {connection.state === 'connected' && (
          <div className="pickers">
            <BackendPicker backends={backends} selected={backend} onSelect={selectBackend} onRecheck={checkStatus} />
            <ModelPicker status={backendStatus} model={model} onChange={selectModel} />
          </div>
        )}
      </header>

      {connection.state === 'checking' && <p className="muted pad">Connecting to the companion…</p>}

      {connection.state === 'disconnected' && (
        <section className="notice pad" role="alert">
          <strong>Companion not connected</strong>
          <p>Quack needs its local companion to run the AI tools against the PR code. Install it once; the browser starts it on demand.</p>
          <FixSteps
            steps={[
              { text: 'Install the companion from the Quack repo', command: 'cd ~/Documents/Dev/Projects/quack && npm run install-host' },
              { text: 'Restart the browser, then press Retry.' },
            ]}
          />
          <p className="muted small">Details: {connection.error}</p>
          <button onClick={checkStatus}>Retry</button>
        </section>
      )}

      {versionMismatch && connection.state === 'connected' && (
        <section className="notice warn pad" role="status">
          Companion {connection.version} doesn't match extension {QUACK_VERSION}.
          <FixSteps steps={[{ text: 'Reinstall the companion', command: 'cd ~/Documents/Dev/Projects/quack && npm run install-host' }]} />
        </section>
      )}

      {backendStatus?.hint && <p className="hint pad small">{backendStatus.hint}</p>}

      <main className="thread" aria-live="polite">
        {!thread?.turns.length && connection.state === 'connected' && (
          <div className="empty pad muted">
            <p>Ask about this PR, or select lines in the diff and press Cmd/Ctrl+Shift+K to ask about them.</p>
          </div>
        )}
        {thread?.turns.map((turn) => (
          <TurnView
            key={turn.id}
            turn={turn}
            onRetry={() => retry(turn)}
            onRecheck={checkStatus}
            otherBackend={otherReadyBackend}
            onRetryOther={(id) => retry(turn, id)}
          />
        ))}
        <div ref={answerEndRef} />
      </main>

      <footer className="composer">
        {page.lastSelection && (
          <button className="link small" onClick={() => addChip(page.lastSelection!)} title="Attach the last code you selected in the diff">
            + Attach selection ({selectionLabel(page.lastSelection)})
          </button>
        )}
        {chips.length > 0 && (
          <ul className="chips">
            {chips.map((c, i) => (
              <li key={i} className="chip">
                <span>{selectionLabel(c)}</span>
                <button className="icon" aria-label={`Remove ${selectionLabel(c)}`} onClick={() => setChips(chips.filter((_, j) => j !== i))}>
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
        <textarea
          ref={inputRef}
          value={question}
          rows={Math.min(6, Math.max(2, question.split('\n').length))}
          placeholder={chips.length ? 'Ask about this code…' : 'Ask about this PR…'}
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
        <div className="composer-actions">
          {running ? (
            <button onClick={stop}>Stop (Esc)</button>
          ) : (
            <button className="primary" onClick={ask} disabled={!question.trim() || backendStatus?.state !== 'ready'}>
              Ask
            </button>
          )}
          {thread?.turns.length ? (
            <button className="link small" onClick={() => key && dispatch({ type: 'reset', key, backend })} disabled={!!running}>
              New thread
            </button>
          ) : null}
        </div>
      </footer>
    </div>
  );
}

function ModelPicker({ status, model, onChange }: { status?: BackendStatus; model: string; onChange: (m: string) => void }) {
  const [custom, setCustom] = useState(false);
  if (!status) return null;
  const known = status.models.includes(model);
  const allowCustom = status.id === 'claude-code';
  if (custom || (!known && model)) {
    return (
      <input
        className="model-input"
        defaultValue={model}
        placeholder="Model ID"
        aria-label="Custom model ID"
        onBlur={(e) => {
          const v = e.target.value.trim();
          onChange(v);
          if (!v) setCustom(false);
        }}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
    );
  }
  return (
    <select
      value={model}
      aria-label="Model"
      onChange={(e) => (e.target.value === '__custom' ? setCustom(true) : onChange(e.target.value))}
    >
      {status.models.map((m) => (
        <option key={m} value={m}>
          {m || 'Default model'}
        </option>
      ))}
      {allowCustom && <option value="__custom">Custom model ID…</option>}
    </select>
  );
}

function TurnView({
  turn,
  onRetry,
  onRecheck,
  otherBackend,
  onRetryOther,
}: {
  turn: Turn;
  onRetry: () => void;
  onRecheck: () => void;
  otherBackend?: BackendStatus;
  onRetryOther: (id: BackendId) => void;
}) {
  const [activityOpen, setActivityOpen] = useState(false);
  const showActivity = turn.status === 'running' || activityOpen;
  const waiting = turn.status === 'running' && !turn.text;
  return (
    <article className="turn">
      <div className="question">
        {turn.selections.length > 0 && <div className="small muted">{turn.selections.map(selectionLabel).join(', ')}</div>}
        <div>{turn.question}</div>
      </div>

      {waiting && (
        <ol className="steps small">
          {turn.steps.map((s, i) => (
            <li key={s} className={i === turn.steps.length - 1 ? 'current' : 'done'}>
              {i === turn.steps.length - 1 ? '…' : '✓'} {s === 'starting_agent' ? `Starting ${labelFor(turn.backend)}` : PROGRESS_LABELS[s]}
            </li>
          ))}
        </ol>
      )}

      {turn.activity.length > 0 &&
        (showActivity ? (
          <ul className="activity small muted">
            {turn.activity.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
            {turn.status !== 'running' && (
              <li>
                <button className="link small" onClick={() => setActivityOpen(false)}>
                  Hide activity
                </button>
              </li>
            )}
          </ul>
        ) : (
          <button className="link small muted" onClick={() => setActivityOpen(true)}>
            {turn.activity.length} agent step{turn.activity.length === 1 ? '' : 's'}
          </button>
        ))}

      {turn.text && <div className="answer">{turn.text}</div>}

      {turn.status === 'done' && (
        <div className="answer-meta small muted">
          {labelFor(turn.backend)} · {turn.model || 'default model'}
          <button className="link small" onClick={() => navigator.clipboard.writeText(turn.text)}>
            Copy answer
          </button>
        </div>
      )}

      {turn.status === 'error' && turn.error && (
        <div className={`error ${turn.error.code === 'cancelled' ? 'quiet' : ''}`} role="alert">
          <strong>{turn.error.code === 'cancelled' ? 'Stopped' : errorTitle(turn.error.code)}</strong>
          {turn.error.code !== 'cancelled' && <p>{turn.error.message}</p>}
          {turn.error.fixSteps && <FixSteps steps={turn.error.fixSteps} />}
          <div className="row">
            {(turn.error.code === 'backend_not_installed' || turn.error.code === 'backend_not_logged_in') && (
              <button onClick={onRecheck}>Recheck</button>
            )}
            <button onClick={onRetry}>{turn.error.code === 'cancelled' ? 'Ask again' : 'Retry'}</button>
            {otherBackend && turn.error.code !== 'cancelled' && (
              <button onClick={() => onRetryOther(otherBackend.id)}>Retry with {otherBackend.label}</button>
            )}
          </div>
        </div>
      )}
    </article>
  );
}

function labelFor(id: BackendId): string {
  return id === 'cursor' ? 'Cursor' : 'Claude Code';
}

function errorTitle(code: ErrorCode | 'disconnected'): string {
  switch (code) {
    case 'repo_not_found':
      return 'No local clone found';
    case 'fetch_failed':
      return "Couldn't fetch the PR";
    case 'backend_not_installed':
      return 'Not installed';
    case 'backend_not_logged_in':
      return 'Not logged in';
    case 'timeout':
      return 'Timed out';
    case 'disconnected':
      return 'Companion disconnected';
    default:
      return 'Something went wrong';
  }
}
