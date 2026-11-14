import { type ReactNode, memo, useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import type {
  AgentId,
  AgentStatus,
  CheckRun,
  CodeSelection,
  CompanionMessage,
  ErrorCode,
  FixStep,
  HistoryTurn,
  ProgressStep,
} from '@quack/shared';
import { INSTALL_COMMAND, PROTOCOL_VERSION, QUACK_VERSION, ciCommentText, isOlderVersion, parseCiReport } from '@quack/shared';
import { type CompanionClient, newRequestId } from '../lib/client';
import { prKey, selectionChip, selectionLabel } from '../lib/github';
import type { PanelPage } from '../lib/page';
import type { TabRequest } from '../lib/messages';
import { AgentPicker, ModelPicker, StatusDot, agentLabel, modelLabel } from './AgentPicker';
import { AnswerBody } from './CiReport';
import { DuckError, DuckSuccess, QuackLogo, StatusIcon } from './brand';
import { CommandBlock, FixSteps } from './FixSteps';
import { ArrowUp, ChevronRight, Circle, Close, CollapsePanel, FileIcon, Plus, Retry, Search, StopSquare, Terminal, Warning } from './icons';
import type { RepoLink } from './Markdown';
import { type Phase, ROTATE_MS, messagesFor, nextMessage, pickPhase } from './thinking';

interface Turn {
  id: string;
  question: string;
  selections: CodeSelection[];
  agent: AgentId;
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
  /** Set for the Check CI action, which asks the agent to explain failing checks. */
  task?: 'explain_ci';
}

interface Thread {
  agent: AgentId;
  sessionId: string | null;
  turns: Turn[];
}

type Action =
  | { type: 'start'; key: string; turn: Turn }
  | { type: 'update'; key: string; id: string; patch: (t: Turn) => Partial<Turn> }
  | { type: 'session'; key: string; sessionId: string | null }
  | { type: 'reset'; key: string; agent: AgentId }
  /** Another agent continues the thread: same turns, new session. */
  | { type: 'switch'; key: string; agent: AgentId };

function threadsReducer(state: Record<string, Thread>, action: Action): Record<string, Thread> {
  const thread = state[action.key];
  switch (action.type) {
    case 'start': {
      const base = thread ?? { agent: action.turn.agent, sessionId: null, turns: [] };
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
      return { ...state, [action.key]: { agent: action.agent, sessionId: null, turns: [] } };
    case 'switch':
      if (!thread) return state;
      return { ...state, [action.key]: { ...thread, agent: action.agent, sessionId: null } };
  }
}

type Connection =
  | { state: 'checking' }
  | { state: 'connected'; version: string; protocol: number }
  | { state: 'disconnected'; error: string };

const EXPLAIN_CI = 'Explain failing CI';

interface Prefs {
  agent: AgentId;
  models: Partial<Record<AgentId, string>>;
  recentModels?: Partial<Record<AgentId, string[]>>;
}

/** A PR the user asked about, listed on the panel's start screen. */
interface RecentPr {
  owner: string;
  repo: string;
  number: number;
  title?: string;
  questions: number;
  at: number;
}

const PREFS_KEY = 'quack.prefs';
const RECENT_KEY = 'quack.recent';
const MAX_RECENT = 5;
const REVIEW_REQUESTS_URL = 'https://github.com/pulls/review-requested';
const SHORTCUT = /Mac/.test(navigator.platform) ? '⌘⇧K' : 'Ctrl+Shift+K';
/** Earlier turns sent to an agent that joins a thread, newest last. */
const MAX_HISTORY = 5;
const MAX_HISTORY_ANSWER = 4000;

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

function timeAgo(at: number, now = Date.now()): string {
  const min = (now - at) / 60_000;
  if (min < 1) return 'just now';
  if (min < 60) return `${Math.round(min)} min ago`;
  if (min < 24 * 60) return `${Math.round(min / 60)} h ago`;
  const days = Math.round((new Date(now).setHours(0, 0, 0, 0) - new Date(at).setHours(0, 0, 0, 0)) / 86_400_000);
  if (days <= 1) return 'yesterday';
  if (days < 7) return new Date(at).toLocaleDateString(undefined, { weekday: 'short' });
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

const lineCount = (s: CodeSelection) => (s.startLine ? (s.endLine ?? s.startLine) - s.startLine + 1 : 0);
const linesOf = (s: CodeSelection) => (s.startLine ? `L${s.startLine}${s.endLine && s.endLine !== s.startLine ? `–${s.endLine}` : ''}` : '');

function historyOf(turns: Turn[]): HistoryTurn[] {
  return turns
    .filter((t) => t.status === 'done' && t.text.trim())
    .slice(-MAX_HISTORY)
    .map((t) => ({
      question: t.question,
      answer: t.text.length > MAX_HISTORY_ANSWER ? `${t.text.slice(0, MAX_HISTORY_ANSWER)}\n[…]` : t.text,
    }));
}

type Tone = 'ok' | 'warn' | 'err' | 'idle' | 'busy';

export function Panel({ page, client }: { page: PanelPage; client: CompanionClient }) {
  const pr = page.pr;
  const key = pr ? prKey(pr) : '';

  const [connection, setConnection] = useState<Connection>({ state: 'checking' });
  const [agents, setAgents] = useState<AgentStatus[]>([]);
  /** Agents the companion is still checking. */
  const [pendingAgents, setPendingAgents] = useState<AgentId[]>([]);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [prefs, setPrefs] = useState<Prefs>({ agent: 'cursor', models: {} });
  const [recent, setRecent] = useState<RecentPr[]>([]);
  /** Failing checks for the open PR. Null until the companion answers. */
  const [checks, setChecks] = useState<{ failing: CheckRun[]; available: boolean } | null>(null);
  /** Asked before the agent was known to be ready; sent once it is. */
  const [queued, setQueued] = useState(false);
  const [threads, dispatch] = useReducer(threadsReducer, {});
  const [chips, setChips] = useState<CodeSelection[]>([]);
  const [question, setQuestion] = useState('');
  const [running, setRunning] = useState<{ requestId: string; turnId: string } | null>(null);
  const [agentMenuOpen, setAgentMenuOpen] = useState(false);
  const [updateDismissed, setUpdateDismissed] = useState(false);
  /** The comment just copied for GitHub, offered again from the toast. */
  const [toast, setToast] = useState<{ selection: CodeSelection | null; seq: number } | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const answerEndRef = useRef<HTMLDivElement>(null);
  const threadsRef = useRef(threads);
  threadsRef.current = threads;

  const thread = threads[key];
  const agent = prefs.agent;
  const agentStatus = agents.find((b) => b.id === agent);
  const modelFor = (id: AgentId) => prefs.models[id] ?? agents.find((b) => b.id === id)?.models[0] ?? '';
  const model = modelFor(agent);
  const offline = connection.state === 'disconnected';
  const loading = !offline && !agentStatus && (connection.state === 'checking' || pendingAgents.includes(agent));

  useEffect(() => {
    browser.storage.local.get(PREFS_KEY).then((r) => {
      const saved = r[PREFS_KEY] as (Partial<Prefs> & { backend?: AgentId }) | undefined;
      const chosen = saved?.agent ?? saved?.backend;
      if (chosen) setPrefs({ agent: chosen, models: saved?.models ?? {}, recentModels: saved?.recentModels });
    });
    browser.storage.local.get(RECENT_KEY).then((r) => setRecent((r[RECENT_KEY] as RecentPr[] | undefined) ?? []));
  }, []);

  function recordQuestion(about: NonNullable<PanelPage['pr']>) {
    setRecent((list) => {
      const old = list.find((r) => prKey(r) === prKey(about));
      const entry: RecentPr = {
        owner: about.owner,
        repo: about.repo,
        number: about.number,
        title: about.title ?? old?.title,
        questions: (old?.questions ?? 0) + 1,
        at: Date.now(),
      };
      const next = [entry, ...list.filter((r) => r !== old)].slice(0, MAX_RECENT);
      browser.storage.local.set({ [RECENT_KEY]: next });
      return next;
    });
  }

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
      const pending = msg.pending ?? [];
      const reported = msg.agents ?? [];
      setConnection({ state: 'connected', version: msg.version, protocol: msg.protocol ?? 0 });
      setPendingAgents(pending);
      // While a re-check is running, keep showing the previous result for agents not checked yet.
      setAgents((prev) =>
        pending.length
          ? [...prev.map((b) => reported.find((n) => n.id === b.id) ?? b), ...reported.filter((n) => !prev.some((b) => b.id === n.id))]
          : reported,
      );
      if (!pending.length) setCheckedAt(Date.now());
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

  // Failing checks for the empty state's "Check CI" row. Hidden when gh can't answer.
  useEffect(() => {
    if (!pr || connection.state !== 'connected') return;
    const requestId = newRequestId();
    let live = true;
    setChecks(null);
    client.send(
      {
        type: 'checks',
        requestId,
        pr: { owner: pr.owner, repo: pr.repo, number: pr.number, headSha: pr.headSha, baseRef: pr.baseRef, title: pr.title },
      },
      (msg) => {
        if (live && msg.type === 'checks') setChecks({ failing: msg.failing, available: msg.available });
      },
    );
    return () => {
      live = false;
      client.forget(requestId);
    };
  }, [client, connection.state, pr?.owner, pr?.repo, pr?.number, pr?.headSha, pr?.baseRef, pr?.title]);

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

  /** Starts a fresh thread and lets the companion stop the agent kept open for the old one. */
  function resetThread(nextAgent: AgentId) {
    const old = threadsRef.current[key];
    if (old?.sessionId) {
      client.send({ type: 'close_session', requestId: newRequestId(), agent: old.agent, sessionId: old.sessionId });
    }
    dispatch({ type: 'reset', key, agent: nextAgent });
  }

  /** The next question goes to another agent, which gets the thread's earlier turns as history. */
  function switchThread(nextAgent: AgentId) {
    const old = threadsRef.current[key];
    if (!old || old.agent === nextAgent) return;
    if (old.sessionId) {
      client.send({ type: 'close_session', requestId: newRequestId(), agent: old.agent, sessionId: old.sessionId });
    }
    dispatch({ type: 'switch', key, agent: nextAgent });
  }

  function selectAgent(id: AgentId) {
    if (id === agent) return;
    savePrefs({ ...prefs, agent: id });
    if (key && thread?.turns.length) switchThread(id);
  }

  function selectModel(m: string) {
    const recent = [m, ...(prefs.recentModels?.[agent] ?? []).filter((r) => r !== m)].slice(0, 5);
    savePrefs({ ...prefs, models: { ...prefs.models, [agent]: m }, recentModels: { ...prefs.recentModels, [agent]: recent } });
  }

  function ask(text = question, selections = chips, useAgent = agent, task?: 'explain_ci') {
    const status = agents.find((b) => b.id === useAgent);
    if (!pr || !text.trim() || running || status?.state !== 'ready') return;
    const useModel = modelFor(useAgent);
    const current = threadsRef.current[key];
    const sessionId = current?.agent === useAgent ? current.sessionId : null;
    if (current && current.agent !== useAgent) switchThread(useAgent);
    const history = !sessionId && current?.turns.length ? historyOf(current.turns) : [];

    const requestId = newRequestId();
    const turn: Turn = {
      id: requestId,
      question: text.trim(),
      selections,
      agent: useAgent,
      model: useModel,
      steps: [],
      activity: [],
      text: '',
      status: 'running',
      startedAt: Date.now(),
      first: !sessionId,
      task,
    };
    const turnKey = key;
    dispatch({ type: 'start', key: turnKey, turn });
    recordQuestion(pr);
    setRunning({ requestId, turnId: turn.id });
    setQuestion('');
    setChips([]);

    const update = (patch: (t: Turn) => Partial<Turn>) => dispatch({ type: 'update', key: turnKey, id: turn.id, patch });
    client.send(
      {
        type: 'ask',
        requestId,
        agent: useAgent,
        model: useModel,
        pr: { owner: pr.owner, repo: pr.repo, number: pr.number, headSha: pr.headSha, baseRef: pr.baseRef, title: pr.title },
        selections: turn.selections,
        question: turn.question,
        sessionId,
        ...(history.length && { history }),
        ...(task && { task }),
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
            if (ev.code === 'agent_not_installed' || ev.code === 'agent_not_logged_in') checkStatus();
          }
        }
      },
    );
  }

  function submit() {
    if (loading) setQueued(!!question.trim());
    else ask();
  }

  useEffect(() => {
    if (!queued || loading) return;
    setQueued(false);
    ask();
  }, [queued, loading]);

  function stop() {
    if (!running) return;
    client.send({ type: 'cancel', requestId: running.requestId });
  }

  function retry(turn: Turn, withAgent?: AgentId) {
    if (withAgent) {
      savePrefs({ ...prefs, agent: withAgent });
      ask(turn.question, turn.selections, withAgent, turn.task);
    } else {
      ask(turn.question, turn.selections, turn.agent, turn.task);
    }
  }

  function openComment(selection: CodeSelection | null) {
    if (page.tabId === null) return;
    browser.tabs.sendMessage(page.tabId, { kind: 'open-comment', selection } satisfies TabRequest).catch(() => {});
  }

  async function postComment(selection: CodeSelection | null, text: string) {
    await navigator.clipboard.writeText(text);
    openComment(selection);
    setToast((t) => ({ selection, seq: (t?.seq ?? 0) + 1 }));
  }

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 12_000);
    return () => clearTimeout(id);
  }, [toast?.seq]);

  const otherReadyAgent = useMemo(() => agents.find((b) => b.id !== agent && b.state === 'ready'), [agents, agent]);
  const lastTurn = thread?.turns.at(-1);

  // Newest commit the companion reported for this PR.
  const knownSha = useMemo(() => {
    for (const t of [...(thread?.turns ?? [])].reverse()) {
      const sha = t.headSha ?? t.steps.find((s) => s.step === 'preparing_worktree')?.detail;
      if (sha) return sha;
    }
    return pr?.headSha ?? pr?.latestSha;
  }, [thread, pr?.headSha, pr?.latestSha]);

  // The newest answer was read at an older commit than the page now shows.
  const lastDone = thread?.turns.findLast((t) => t.status === 'done' && t.headSha);
  const staleFrom =
    !running && lastDone?.headSha && pr?.latestSha && !pr.latestSha.startsWith(lastDone.headSha) && !lastDone.headSha.startsWith(pr.latestSha)
      ? lastDone
      : undefined;

  const repoLink = useMemo<RepoLink | null>(
    () => (pr ? { owner: pr.owner, repo: pr.repo, sha: knownSha } : null),
    [pr?.owner, pr?.repo, knownSha],
  );

  // Stable for the panel's lifetime and always calling the latest handlers, so memoized turns don't re-render.
  const latest = useRef({ stop, retry, checkStatus, postComment });
  latest.current = { stop, retry, checkStatus, postComment };
  const turnActions = useMemo<TurnActions>(
    () => ({
      stop: () => latest.current.stop(),
      retry: (turn, withAgent) => latest.current.retry(turn, withAgent),
      recheck: () => latest.current.checkStatus(),
      post: (selection, text) => latest.current.postComment(selection, text),
    }),
    [],
  );

  const pickers = (
    <>
      <AgentPicker
        agents={agents}
        selected={agent}
        companionVersion={connection.state === 'connected' ? connection.version : undefined}
        checkedAt={checkedAt}
        offline={offline}
        onSelect={selectAgent}
        onRecheck={checkStatus}
        onOpenChange={setAgentMenuOpen}
      />
      <ModelPicker
        status={agentStatus}
        model={model}
        recent={prefs.recentModels?.[agent] ?? []}
        disabled={offline}
        onChange={selectModel}
      />
    </>
  );

  if (!pr) {
    const status: { tone: Tone; text: string } = offline
      ? { tone: 'warn', text: 'Companion offline' }
      : loading || !agentStatus
        ? { tone: 'idle', text: 'Checking…' }
        : agentStatus.state === 'ready'
          ? { tone: 'ok', text: 'Ready' }
          : { tone: 'warn', text: agentStatus.state === 'not_installed' ? 'Not installed' : 'Not logged in' };
    const readiness: { kind: 'success' | 'error' | 'loading'; text: string } = offline
      ? { kind: 'error', text: 'Can’t reach the companion' }
      : loading || !agentStatus
        ? { kind: 'loading', text: 'Checking your agents…' }
        : agentStatus.state === 'ready'
          ? { kind: 'success', text: `${agentStatus.label} · ${modelLabel(agent, model)} is ready` }
          : { kind: 'error', text: `${agentStatus.label} ${agentStatus.state === 'not_installed' ? 'isn’t installed' : 'isn’t logged in'}` };
    return (
      <div className="quack panel">
        <PanelHeader pickers={pickers} status={status} running={false} />
        {page.notice && <Banner>{page.notice}</Banner>}
        <NoPullRequest
        recent={recent}
        readiness={readiness}
        install={connection.state === 'disconnected' ? { error: connection.error, onRetry: checkStatus } : null}
      />
      </div>
    );
  }

  const status: { tone: Tone; text: string } = offline
    ? { tone: 'warn', text: 'Companion offline' }
    : loading
      ? { tone: 'idle', text: 'Checking…' }
      : running
        ? { tone: 'busy', text: 'Working…' }
        : lastTurn?.status === 'error' && lastTurn.error?.code !== 'cancelled'
          ? { tone: 'err', text: 'Error' }
          : agentStatus && agentStatus.state !== 'ready'
            ? { tone: 'warn', text: agentStatus.state === 'not_installed' ? 'Not installed' : 'Not logged in' }
            : { tone: 'ok', text: 'Ready' };

  const incompatible = connection.state === 'connected' && connection.protocol !== PROTOCOL_VERSION;
  const outdated =
    connection.state === 'connected' && !incompatible && !updateDismissed && isOlderVersion(connection.version, QUACK_VERSION);
  const canAttach = page.lastSelection && !chips.some((c) => sameSelection(c, page.lastSelection!));
  const canAsk = !!question.trim() && (loading || agentStatus?.state === 'ready') && !running;
  const empty = !thread?.turns.length;
  const hint = agentMenuOpen
    ? 'Switching keeps the thread. Different duck, same pond.'
    : queued
      ? `Sends once ${agentLabel(agent)} is ready`
      : loading
        ? 'Type now. It sends once the duck is up.'
        : running
          ? lastTurn && !lastTurn.text && !lastTurn.activity.length
            ? 'Esc cancels'
            : 'You can type while it paddles'
          : thread?.turns.length
            ? 'The duck remembers this thread'
            : 'Enter to send · Shift+Enter for a new line';

  return (
    <div className="quack panel">
      <PanelHeader pr={pr} sha={knownSha} pickers={pickers} status={status} running={!!running} />

      {page.notice && <Banner>{page.notice}</Banner>}
      {incompatible && connection.state === 'connected' && (
        <Banner>
          This extension speaks protocol {PROTOCOL_VERSION}, but the companion speaks{' '}
          {connection.protocol ? `protocol ${connection.protocol}` : 'an older protocol'}. Reinstall it:
          <CommandBlock command={INSTALL_COMMAND} />
        </Banner>
      )}
      {outdated && connection.state === 'connected' && (
        <UpdateBanner from={connection.version} to={QUACK_VERSION} onDismiss={() => setUpdateDismissed(true)} />
      )}
      {staleFrom && !offline && (
        <StaleBanner
          from={staleFrom.headSha!}
          to={pr.latestSha!}
          disabled={agentStatus?.state !== 'ready'}
          onReask={() => ask(staleFrom.question, staleFrom.selections, agent, staleFrom.task)}
        />
      )}

      <main className={`body ${empty ? 'roomy' : ''}`} aria-live="polite" aria-busy={loading}>
        {offline ? (
          <CompanionOffline error={connection.error} onRetry={checkStatus} />
        ) : (
          <>
            {empty && loading && <Readiness connection={connection} agent={agent} pending={pendingAgents} />}
            {empty && !loading && chips.length > 0 && <SelectionIntro chips={chips} sha={knownSha} />}
            {empty && !loading && !chips.length && (
              <EmptyAsk
                failing={checks?.available ? checks.failing : []}
                canCheck={agentStatus?.state === 'ready' && !running}
                onCheck={() => ask(EXPLAIN_CI, [], agent, 'explain_ci')}
              />
            )}
            {empty && agentStatus?.state === 'ready' && chips.length > 0 && <SelectionSuggestions chips={chips} onPick={(q) => ask(q)} />}
            {agentStatus && agentStatus.state !== 'ready' && !lastTurn?.error?.fixSteps && (
              <AgentSetup status={agentStatus} onRecheck={checkStatus} />
            )}
            {thread?.turns.map((turn) => (
              <TurnView
                key={turn.id}
                turn={turn}
                prNumber={pr.number}
                link={repoLink!}
                otherAgent={otherReadyAgent}
                checks={checks?.failing ?? []}
                actions={turnActions}
                latest={turn === lastTurn}
              />
            ))}
            {thread?.turns.length && !running ? (
              <button type="button" className="ghost new-thread" onClick={() => resetThread(agent)}>
                Start a new thread
              </button>
            ) : null}
            <div ref={answerEndRef} />
          </>
        )}
      </main>

      <footer className="composer">
        {toast && (
          <div className="toast" role="status">
            <DuckSuccess width={64} />
            <p>
              <strong>Copied.</strong> Paste it into GitHub’s comment box, then Start a review.
            </p>
            <button type="button" className="link" onClick={() => openComment(toast.selection)}>
              Show
            </button>
            <button type="button" className="ghost icon-only" aria-label="Dismiss" onClick={() => setToast(null)}>
              <Close size={12} />
            </button>
          </div>
        )}
        {offline ? (
          <div className="composer-disabled">Connect the companion to ask</div>
        ) : (
          <>
            <div className="attachments" aria-label="Attached context">
              {!chips.length && !canAttach && <span className="muted small">No code attached · asks about the whole PR</span>}
              {chips.map((c, i) => (
                <SelectionChip key={i} selection={c} onRemove={() => setChips(chips.filter((_, j) => j !== i))} />
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
                    submit();
                  }
                }}
                aria-label="Question"
              />
              <div className="input-foot">
                <span className="muted small">{hint}</span>
                {running ? (
                  <button type="button" className="secondary" onClick={stop}>
                    <StopSquare /> Stop <kbd>Esc</kbd>
                  </button>
                ) : (
                  <button
                    type="button"
                    className={question.trim() && !queued ? 'primary' : 'secondary'}
                    onClick={submit}
                    disabled={!canAsk || queued}
                  >
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

function PanelHeader({
  pr,
  sha,
  pickers,
  status,
  running,
}: {
  pr?: NonNullable<PanelPage['pr']>;
  sha?: string;
  pickers: ReactNode;
  status: { tone: Tone; text: string };
  running: boolean;
}) {
  return (
    <header className="header">
      <div className="title-row">
        <QuackLogo onDark size={16} />
        <span className="wordmark display">Quack</span>
        {pr && (
          <>
            <span className="divider" aria-hidden="true" />
            <span className="pr-number">#{pr.number}</span>
            <span className="pr-title" title={pr.title}>
              {pr.title ?? ''}
            </span>
            {sha && (
              <code className="sha" title="Head commit the agent reads">
                {shortSha(sha)}
              </code>
            )}
          </>
        )}
        <button
          type="button"
          className="ghost icon-only collapse"
          aria-label="Collapse panel"
          title={running ? 'Collapse panel (stops the current answer)' : `Collapse panel · reopen with ${SHORTCUT}`}
          onClick={() => window.close()}
        >
          <CollapsePanel size={16} />
        </button>
      </div>
      <div className="picker-row">
        {pickers}
        <span className={`status ${status.tone}`} title={status.text}>
          <StatusDot tone={status.tone === 'busy' ? 'ok' : status.tone} /> <span className="status-text">{status.text}</span>
        </span>
      </div>
    </header>
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

function UpdateBanner({ from, to, onDismiss }: { from: string; to: string; onDismiss: () => void }) {
  return (
    <div className="banner update" role="status">
      <Warning size={16} />
      <div>
        Companion update available: v{from} → v{to}. Run this, then reopen the panel:
        <CommandBlock command={INSTALL_COMMAND} />
      </div>
      <button type="button" className="ghost icon-only" aria-label="Dismiss until the panel reopens" onClick={onDismiss}>
        <Close size={12} />
      </button>
    </div>
  );
}

function StaleBanner({ from, to, disabled, onReask }: { from: string; to: string; disabled: boolean; onReask: () => void }) {
  return (
    <div className="banner stale" role="status">
      <div className="stale-text">
        <strong>New commits since this answer. The pond moved.</strong>
        <code className="small">
          {shortSha(from)} → {shortSha(to)}
        </code>
      </div>
      <button type="button" className="primary" disabled={disabled} onClick={onReask}>
        Re-ask on latest
      </button>
    </div>
  );
}

function NoPullRequest({
  recent,
  readiness,
  install,
}: {
  recent: RecentPr[];
  readiness: { kind: 'success' | 'error' | 'loading'; text: string };
  /** Present when the companion is unreachable, including before any PR is open. */
  install: { error: string; onRetry: () => void } | null;
}) {
  return (
    <div className="body start">
      <section className="start-head">
        <QuackLogo size={44} />
        <div>
          <h1 className="display">No PR, no quack.</h1>
          <p className="muted">Open a pull request and the duck takes it from there.</p>
        </div>
      </section>
      <a className="button primary block" href={REVIEW_REQUESTS_URL} target="_blank" rel="noreferrer">
        Open my review requests
      </a>
      {install && (
        <CompanionOffline
          error={install.error}
          onRetry={install.onRetry}
          detail="Quack needs its local companion before it can read a pull request. Once installed, your browser starts it on its own."
        />
      )}
      {recent.length > 0 && (
        <section className="list-section" aria-labelledby="recent-h">
          <h2 id="recent-h" className="section-title">
            Recently quacked about
          </h2>
          <div className="list-card">
            {recent.map((r) => (
              <button
                key={prKey(r)}
                type="button"
                className="list-row"
                onClick={() => browser.tabs.update({ url: `https://github.com/${r.owner}/${r.repo}/pull/${r.number}/files` })}
              >
                <span className="list-row-text">
                  <span className="list-row-title">{r.title ?? `Pull request #${r.number}`}</span>
                  <span className="muted small">
                    {r.owner}/{r.repo} #{r.number} · {plural(r.questions, 'question')} · {timeAgo(r.at)}
                  </span>
                </span>
                <ChevronRight size={14} />
              </button>
            ))}
          </div>
        </section>
      )}
      {!install && (
        <div className="start-status" role="status">
          <StatusIcon kind={readiness.kind} size={14} /> {readiness.text}
        </div>
      )}
    </div>
  );
}

function EmptyAsk({ failing, canCheck, onCheck }: { failing: CheckRun[]; canCheck: boolean; onCheck: () => void }) {
  return (
    <div className="empty-ask">
      <h2 className="display">Explain it to the duck.</h2>
      {failing.length > 0 && (
        <ul className="review-actions" aria-label="Actions for this PR">
          <li className="review-action failing">
            <StatusIcon kind="error" size={20} />
            <span className="review-copy">
              <strong>{failing.length === 1 ? '1 check failing' : `${failing.length} checks failing`}</strong>
              <span>Find out if it’s this PR or a flake</span>
            </span>
            <button type="button" className="primary" disabled={!canCheck} onClick={onCheck}>
              Check CI
            </button>
          </li>
        </ul>
      )}
      <HowToAsk />
    </div>
  );
}

function HowToAsk() {
  return (
    <section className="howto" aria-labelledby="howto-ask">
      <h3 id="howto-ask">Ask about specific code</h3>
      <div className="howto-diff" aria-hidden="true">
        <div>
          <span className="ln">39</span>
          <span>if (!user.isOwner) …</span>
        </div>
        <div className="sel">
          <span className="ln">40</span>
          <span>const invoice = await …</span>
        </div>
        <div className="sel">
          <span className="ln">41</span>
          <span>return softDelete(…)</span>
        </div>
        <div>
          <span className="ln">42</span>
          <span>{'}'}</span>
        </div>
      </div>
      <ol>
        <li>Click a line number in the diff, Shift-click another to select a range.</li>
        <li>
          Press <kbd>{SHORTCUT}</kbd> or click <strong>Ask Quack</strong>.
        </li>
      </ol>
    </section>
  );
}

function SelectionChip({ selection, onRemove }: { selection: CodeSelection; onRemove: () => void }) {
  const chip = selectionChip(selection);
  const title = selectionLabel(selection);
  return (
    <span className="chip" title={title}>
      <span className="chip-path">
        {chip.dir && <span className="chip-dir">{chip.dir}</span>}
        <b>{chip.name}</b>
      </span>
      {chip.lines && <span className="chip-lines">{chip.lines}</span>}
      <button type="button" className="ghost icon-only" aria-label={`Remove ${title}`} onClick={onRemove}>
        <Close size={12} />
      </button>
    </span>
  );
}

function SelectionIntro({ chips, sha }: { chips: CodeSelection[]; sha?: string }) {
  const lines = chips.reduce((n, c) => n + lineCount(c), 0);
  return (
    <section className="intro selection">
      <h2 className="display">{lines ? `${plural(lines, 'line')}, one duck.` : 'Your selection, one duck.'}</h2>
      <p className="muted">
        Answers read the code at {sha ? <code>{shortSha(sha)}</code> : 'the PR’s latest commit'} plus what you attach. Nothing is posted unless
        you say so.
      </p>
    </section>
  );
}

const SELECTION_SUGGESTIONS = ['Does this already exist?', 'Suggest a simpler way', 'What could break?'];

function SelectionSuggestions({ chips, onPick }: { chips: CodeSelection[]; onPick: (question: string) => void }) {
  const only = chips.length === 1 ? linesOf(chips[0]) : '';
  return (
    <section className="list-section" aria-labelledby="suggest-h">
      <h3 id="suggest-h" className="section-title">
        {only ? `Suggested for ${only}` : 'Suggested'}
      </h3>
      <div className="pill-row">
        {SELECTION_SUGGESTIONS.map((q) => (
          <button key={q} type="button" className="pill suggestion" onClick={() => onPick(q)}>
            {q}
          </button>
        ))}
      </div>
    </section>
  );
}

const NO_ACTIVITY: string[] = [];

/** A thinking headline from `thinking.ts`, swapped every few seconds. Decoration only. */
function ThinkingHeadline({ phase, agent, activity, initial }: { phase: Phase; agent: string; activity: string[]; initial?: string }) {
  const options = useMemo(() => messagesFor(phase, { agent, activity }), [phase, agent, activity]);
  const [line, setLine] = useState(() => (initial && options.includes(initial) ? initial : nextMessage(options)));
  useEffect(() => {
    setLine((prev) => (options.includes(prev) ? prev : nextMessage(options, prev)));
    const id = setInterval(() => setLine((prev) => nextMessage(options, prev)), ROTATE_MS);
    return () => clearInterval(id);
  }, [options]);
  return (
    <span className="thinking-line display" aria-hidden="true" key={line}>
      {line}
    </span>
  );
}

function Readiness({ connection, agent, pending }: { connection: Connection; agent: AgentId; pending: AgentId[] }) {
  const connected = connection.state === 'connected';
  const othersDone = connected && !pending.some((id) => id !== agent);
  const steps: { state: 'done' | 'current' | 'waiting'; label: string; meta: string }[] = [
    connected
      ? { state: 'done', label: 'Companion connected', meta: `v${connection.version}` }
      : { state: 'current', label: 'Connecting to the companion', meta: '' },
    { state: connected ? 'current' : 'waiting', label: `Checking ${agentLabel(agent)}`, meta: 'Last used' },
    { state: othersDone ? 'done' : 'waiting', label: 'Other agents', meta: othersDone ? 'Done' : 'Waiting' },
  ];
  return (
    <section className="prep-card" role="status" aria-label="Getting Quack ready">
      <div className="prep-head">
        <StatusIcon kind="loading" size={18} />
        <ThinkingHeadline phase="waking" agent={agentLabel(agent)} activity={NO_ACTIVITY} initial="Waking the duck. It is not a morning duck." />
      </div>
      <PrepSteps steps={steps} />
    </section>
  );
}

function PrepSteps({ steps }: { steps: { state: 'done' | 'current' | 'waiting'; label: ReactNode; meta: string }[] }) {
  return (
    <ol className="prep-steps">
      {steps.map((s, i) => (
        <li key={i} className={s.state}>
          <span className="prep-icon">
            {s.state === 'done' ? (
              <StatusIcon kind="success" size={14} />
            ) : s.state === 'current' ? (
              <StatusIcon kind="loading" size={14} />
            ) : (
              <Circle size={14} />
            )}
          </span>
          <span className="prep-label">{s.label}</span>
          <span className="muted small prep-state">{s.meta}</span>
        </li>
      ))}
    </ol>
  );
}

function AgentSetup({ status, onRecheck }: { status: AgentStatus; onRecheck: () => void }) {
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
          <p className="muted">Follow these steps, then re-check. Or pick another agent above.</p>
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

function CompanionOffline({
  error,
  onRetry,
  detail = 'Quack needs its local companion to read this PR’s code. Once installed, your browser starts it on its own.',
}: {
  error: string;
  onRetry: () => void;
  detail?: string;
}) {
  return (
    <section className="offline">
      <div>
        <h2 className="display">The duck can’t hear the companion.</h2>
        <p className="muted">{detail}</p>
      </div>
      <h3>1. Install it once</h3>
      <CommandBlock command={INSTALL_COMMAND} />
      <h3>2. Restart your browser</h3>
      <p className="muted">No terminal needs to stay open.</p>
      <div className="row">
        <button type="button" className="primary" onClick={onRetry}>
          Retry connection
        </button>
        <span className="muted small">Also retrying every 5 s</span>
      </div>
      <p className="muted small">
        Already installed? Run the command again to repair it. Details: {error}
      </p>
    </section>
  );
}

const PREP_STEPS: ProgressStep[] = ['finding_repo', 'fetching_pr', 'preparing_worktree', 'starting_agent'];

function prepOrder(turn: Turn): ProgressStep[] {
  if (turn.task !== 'explain_ci') return PREP_STEPS;
  return ['finding_repo', 'fetching_pr', 'preparing_worktree', 'fetching_ci', 'starting_agent'];
}

function PrepCard({ turn, prNumber, onCancel, now }: { turn: Turn; prNumber: number; onCancel: () => void; now: number }) {
  const order = prepOrder(turn);
  const current = turn.steps.at(-1)?.step ?? 'finding_repo';
  const currentIndex = Math.max(0, order.indexOf(current));
  const agent = agentLabel(turn.agent);
  const label = (step: ProgressStep, done: boolean, detail?: string) => {
    switch (step) {
      case 'finding_repo':
        return done ? 'Found the local clone' : 'Finding the local clone';
      case 'fetching_pr':
        return done ? `Fetched PR #${prNumber}` : `Fetching PR #${prNumber}`;
      case 'preparing_worktree':
        return detail ? (
          <>
            {done ? 'Worktree ready at' : 'Preparing worktree at'} <code>{shortSha(detail)}</code>
          </>
        ) : (
          'Preparing worktree'
        );
      case 'fetching_ci':
        return done ? 'Fetched CI logs' : 'Fetching CI logs';
      case 'starting_agent':
        return `Starting ${agent}`;
      default:
        return step;
    }
  };
  const steps = order.map((step, i) => {
    const entry = turn.steps.find((s) => s.step === step);
    const next = turn.steps.find((s) => s.step === order[i + 1]);
    const state = i < currentIndex ? 'done' : i === currentIndex ? 'current' : 'waiting';
    return {
      state,
      label: label(step, state === 'done', entry?.detail),
      meta: state === 'done' ? (entry && next ? duration(next.at - entry.at) : 'Done') : state === 'current' ? '' : 'Waiting',
    } as const;
  });
  const phase =
    current === 'fetching_ci' ? 'ci' : pickPhase({ preparing: true, activity: [], text: '', elapsedMs: now - turn.startedAt, task: turn.task });
  return (
    <section className="prep-card" aria-label="Preparing">
      <div className="prep-head">
        <StatusIcon kind="loading" size={18} />
        <ThinkingHeadline phase={phase} agent={agent} activity={NO_ACTIVITY} initial="Filling the pond…" />
        <span className="muted small prep-meta">{turn.first ? 'First question' : 'Follow-up'}</span>
      </div>
      <PrepSteps steps={steps} />
      <div className="progress" role="progressbar" aria-label="Preparing" aria-valuemin={0} aria-valuemax={order.length} aria-valuenow={currentIndex}>
        <span style={{ width: `${((currentIndex + 0.5) / order.length) * 100}%` }} />
      </div>
      <div className="row end">
        <button type="button" className="secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </section>
  );
}

function DraftComment({
  selections,
  answer,
  onCancel,
  onConfirm,
}: {
  selections: CodeSelection[];
  answer: string;
  onCancel: () => void;
  onConfirm: (selection: CodeSelection | null, text: string) => void;
}) {
  const [target, setTarget] = useState(0);
  const [text, setText] = useState(() => ciCommentText(answer));
  const id = useRef(`draft-${Math.random().toString(36).slice(2)}`).current;
  const options = [...selections.map((s) => ({ label: selectionLabel(s).replace(' · ', ' · lines '), selection: s as CodeSelection | null })), { label: 'Whole PR (conversation)', selection: null }];
  return (
    <section className="draft" aria-labelledby={`${id}-h`}>
      <div className="draft-head">
        <h3 id={`${id}-h`} className="display">
          Draft review comment
        </h3>
        <span className="muted small">Not posted. Yet.</span>
      </div>
      <div className="draft-body">
        <label htmlFor={`${id}-on`}>Comment on</label>
        <select id={`${id}-on`} className="mono" value={target} onChange={(e) => setTarget(Number(e.target.value))}>
          {options.map((o, i) => (
            <option key={i} value={i}>
              {o.label}
            </option>
          ))}
        </select>
        <label htmlFor={`${id}-text`}>Comment</label>
        <textarea id={`${id}-text`} className="mono" rows={9} value={text} onChange={(e) => setText(e.target.value)} />
        <p className="muted small">Markdown works. Edit freely; the duck won’t mind.</p>
        <div className="row end">
          <button type="button" className="secondary" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="primary" disabled={!text.trim()} onClick={() => onConfirm(options[target].selection, text)}>
            Copy and open in GitHub
          </button>
        </div>
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
    reads && `Paddled through ${plural(reads, 'file', 'files')}`,
    searches && plural(searches, 'search', 'searches'),
    lists && plural(lists, 'listing', 'listings'),
    commands && plural(commands, 'command', 'commands'),
    other && plural(other, 'other step', 'other steps'),
  ].filter(Boolean);
  return parts.join(' · ');
}

/** The alert's headline: it may wink; the explanation under it stays plain. */
function errorTitle(code: ErrorCode | 'disconnected', agent: string, seconds: number): string {
  switch (code) {
    case 'repo_not_found':
      return 'No local clone found';
    case 'fetch_failed':
      return 'Couldn’t fetch the PR';
    case 'agent_not_installed':
      return `${agent} isn’t installed`;
    case 'agent_not_logged_in':
      return `${agent} isn’t logged in`;
    case 'timeout':
      return `No reply in ${seconds} s. The duck went under.`;
    case 'agent_failed':
      return `${agent} failed`;
    case 'disconnected':
      return 'Companion disconnected';
    case 'version_mismatch':
      return 'Companion needs updating';
    default:
      return 'Something went wrong';
  }
}

interface TurnActions {
  stop: () => void;
  retry: (turn: Turn, agent?: AgentId) => void;
  recheck: () => void;
  post: (selection: CodeSelection | null, text: string) => Promise<void>;
}

// Memoized so typing or picking lines in the diff doesn't re-render (and
// re-highlight) every answer; only the turn being streamed changes.
const TurnView = memo(function TurnView({
  turn,
  prNumber,
  link,
  otherAgent,
  checks,
  actions,
  latest,
}: {
  turn: Turn;
  prNumber: number;
  link: RepoLink;
  otherAgent?: AgentStatus;
  checks: CheckRun[];
  actions: TurnActions;
  /** The newest turn gets the primary action. */
  latest: boolean;
}) {
  const onStop = actions.stop;
  const onRetry = () => actions.retry(turn);
  const onRecheck = actions.recheck;
  const onRetryOther = (id: AgentId) => actions.retry(turn, id);
  const [activityOpen, setActivityOpen] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [copied, setCopied] = useState(false);
  const isRunning = turn.status === 'running';
  const now = useNow(isRunning);
  const silent = isRunning && !turn.text && !turn.activity.length;
  const preparing = silent && turn.steps.at(-1)?.step !== 'thinking';
  const elapsedMs = (turn.finishedAt ?? now) - turn.startedAt;
  const elapsed = duration(elapsedMs);
  const label = agentLabel(turn.agent);
  const jobLogs = turn.task === 'explain_ci' ? (parseCiReport(turn.text).findings?.length ?? 0) : 0;
  const error = turn.error;
  const cancelled = error?.code === 'cancelled';
  const sha = turn.headSha ?? turn.steps.find((s) => s.step === 'preparing_worktree')?.detail;

  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(id);
  }, [copied]);

  const meta = isRunning ? (
    elapsed
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
        <PrepCard turn={turn} prNumber={prNumber} onCancel={onStop} now={now} />
      ) : (
        <section className="answer" aria-label="Answer">
          <div className="answer-head">
            <span className="badge">
              {label} · {modelLabel(turn.agent, turn.model)}
              {jobLogs > 0 && ` · read ${jobLogs} job ${jobLogs === 1 ? 'log' : 'logs'}`}
            </span>
            <span className="muted meta">{meta}</span>
          </div>

          {turn.activity.length > 0 &&
            (isRunning || activityOpen ? (
              <ul className="activity" aria-live="polite">
                {turn.activity.map((a, i) => {
                  const live = isRunning && i === turn.activity.length - 1 && !turn.text;
                  return (
                    <li key={i} className={live ? 'live' : ''}>
                      {!isRunning && activityIcon(a)}
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

          {turn.text && <AnswerBody text={turn.text} link={link} streaming={isRunning} checks={checks} />}

          {isRunning && (
            <div className="thinking">
              <StatusIcon kind="loading" size={18} />
              <ThinkingHeadline
                phase={pickPhase({ preparing, activity: turn.activity, text: turn.text, elapsedMs, task: turn.task })}
                agent={label}
                activity={turn.activity}
              />
            </div>
          )}

          {turn.status === 'done' && turn.text && (drafting ? (
            <DraftComment
              selections={turn.selections}
              answer={turn.text}
              onCancel={() => setDrafting(false)}
              onConfirm={(selection, text) => {
                actions.post(selection, text).then(() => setDrafting(false), () => {});
              }}
            />
          ) : (
            <div className="row answer-actions">
              <button type="button" className={latest ? 'primary' : 'secondary'} onClick={() => setDrafting(true)}>
                Post as review comment
              </button>
              <button
                type="button"
                className="secondary"
                onClick={() => navigator.clipboard.writeText(ciCommentText(turn.text)).then(() => setCopied(true), () => {})}
              >
                {copied ? 'Copied' : 'Copy answer'}
              </button>
            </div>
          ))}

          {error && cancelled && (
            <div className="row">
              <button type="button" className="secondary" onClick={onRetry}>
                <Retry size={14} /> Ask again
              </button>
            </div>
          )}

          {error && !cancelled && (
            <div className="error-card" role="alert">
              <DuckError width={64} />
              <div className="error-content">
                <strong className="error-title">{errorTitle(error.code, label, Math.round(elapsedMs / 1000))}</strong>
                <p className="muted small">{error.message}</p>
                {error.fixSteps && error.fixSteps.length > 0 && <FixSteps steps={error.fixSteps} />}
                <div className="row">
                  {(error.code === 'agent_not_installed' || error.code === 'agent_not_logged_in') && (
                    <button type="button" className="secondary" onClick={onRecheck}>
                      Re-check
                    </button>
                  )}
                  <button type="button" className="primary" onClick={onRetry}>
                    Retry
                  </button>
                  {otherAgent && (
                    <button type="button" className="secondary" onClick={() => onRetryOther(otherAgent.id)}>
                      Try {otherAgent.label}
                    </button>
                  )}
                  <button
                    type="button"
                    className="link"
                    onClick={() =>
                      navigator.clipboard.writeText(`${error.code}: ${error.message}${sha ? ` (worktree ${sha})` : ''}`)
                    }
                  >
                    Copy log
                  </button>
                </div>
              </div>
            </div>
          )}
        </section>
      )}
    </article>
  );
});
