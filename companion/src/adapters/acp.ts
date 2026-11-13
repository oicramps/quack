import type { ChildProcess } from 'node:child_process';
import readline from 'node:readline';
import { killTree, spawnStreaming } from '../exec.ts';
import { log } from '../log.ts';
import { clip, recorder, relativeTo, stderrSummary } from './stream.ts';
import type { AdapterEvent, AskOpts } from './types.ts';

type Json = Record<string, unknown>;

/** Idle timeout before a cached ACP session process is terminated. */
export const ACP_IDLE_MS = 15 * 60_000;

/** JSON-RPC 2.0 client over stdio for an Agent Client Protocol (`<agent> acp`) subprocess. */
export class AcpClient {
  alive = true;
  onUpdate: ((sessionId: string, update: Json) => void) | null = null;
  private child: ChildProcess;
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();
  private stderr = '';
  private record = recorder('cursor-acp');

  constructor(bin: string, cwd: string, spawnArgs: string[]) {
    this.child = spawnStreaming(bin, spawnArgs, cwd, { stdin: true });
    this.child.stdin!.on('error', () => {});
    this.child.stderr!.setEncoding('utf8');
    this.child.stderr!.on('data', (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-4000);
    });
    readline.createInterface({ input: this.child.stdout!, crlfDelay: Infinity }).on('line', (line) => this.receive(line));
    const gone = (why: string) => {
      if (!this.alive) return;
      this.alive = false;
      const err = new Error(stderrSummary(this.stderr) || why);
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    };
    this.child.on('close', (code) => gone(`The agent exited with code ${code}.`));
    this.child.on('error', (err) => gone(String(err)));
  }

  request<T = Json>(method: string, params: Json): Promise<T> {
    if (!this.alive) return Promise.reject(new Error('The agent is not running.'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params: Json): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  close(): void {
    killTree(this.child);
  }

  private write(message: Json): void {
    if (this.alive) this.child.stdin!.write(JSON.stringify(message) + '\n');
  }

  private receive(line: string): void {
    if (!line.trim()) return;
    this.record?.(line);
    let msg: Json;
    try {
      msg = JSON.parse(line);
    } catch {
      log('non-JSON line from ACP agent ignored');
      return;
    }
    if (typeof msg.method === 'string') {
      const params = (msg.params ?? {}) as Json;
      if (msg.method === 'session/update') {
        this.onUpdate?.(String(params.sessionId), (params.update ?? {}) as Json);
      } else if (msg.id !== undefined) {
        // Enforce read-only mode: cancel permission requests and reject client-side FS/terminal RPCs.
        if (msg.method === 'session/request_permission') {
          this.write({ jsonrpc: '2.0', id: msg.id, result: { outcome: { outcome: 'cancelled' } } });
        } else {
          this.write({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
        }
      }
      return;
    }
    const p = this.pending.get(msg.id as number);
    if (!p) return;
    this.pending.delete(msg.id as number);
    const error = msg.error as { message?: string; data?: { message?: string } } | undefined;
    if (error) p.reject(new Error(error.data?.message ?? error.message ?? 'The agent returned an error.'));
    else p.resolve(msg.result);
  }
}

export interface AcpModel {
  /** What the picker shows and the extension sends, e.g. `gpt-5.6-luna`. */
  id: string;
  /** What the agent expects, e.g. `gpt-5.6-luna[context=272k,reasoning=medium,fast=false]`. */
  value: string;
}

const baseModel = (value: string) => value.replace(/\[.*$/, '');

export function acpModels(result: Json): AcpModel[] {
  const available = ((result.models as { availableModels?: { modelId?: unknown }[] } | undefined)?.availableModels ?? [])
    .map((m) => m.modelId)
    .filter((v): v is string => typeof v === 'string');
  return available.map((value) => ({ id: baseModel(value), value })).filter((m) => m.id && m.id !== 'default');
}

/** Exact match, or the base of a CLI variant name such as `gpt-5.6-luna-high`. */
export function matchModel(models: AcpModel[], wanted: string): AcpModel | undefined {
  return (
    models.find((m) => m.id === wanted) ??
    models.filter((m) => wanted.startsWith(m.id + '-')).sort((a, b) => b.id.length - a.id.length)[0]
  );
}

interface ToolCall {
  kind?: string;
  title?: string;
  rawInput?: Json;
  emitted?: boolean;
}

function summarizeTool(t: ToolCall, cwd: string): string {
  const a = t.rawInput ?? {};
  const title = clip(String(t.title ?? ''), 80);
  switch (t.kind) {
    case 'read':
      return a.path ? `Read ${relativeTo(cwd, a.path)}` : title || 'Read a file';
    case 'search':
      if (a.globPattern) return `Listed files matching ${clip(String(a.globPattern), 60)}`;
      if (a.query) return `Searched codebase for ${clip(String(a.query), 60)}`;
      if (a.pattern) return `Searched repo for ${clip(String(a.pattern), 60)}`;
      return title || 'Searched the repo';
    case 'execute':
      return `Ran ${clip(String(a.command ?? t.title ?? ''), 60)}`;
    case 'edit':
    case 'delete':
    case 'move':
      return `Tried to ${t.kind} ${relativeTo(cwd, a.path) || title}`;
    default:
      return title ? `Used ${title}` : 'Used a tool';
  }
}

/** Maps `session/update` notifications into normalized text and deduplicated tool events. */
export function createUpdateMapper(cwd: string): (update: Json) => AdapterEvent[] {
  const tools = new Map<string, ToolCall>();
  let wroteText = false;
  let toolSinceText = false;
  return (u) => {
    switch (u.sessionUpdate) {
      case 'agent_message_chunk': {
        const c = u.content as { type?: string; text?: string } | undefined;
        if (c?.type !== 'text' || !c.text) return [];
        // Insert a paragraph break when text resumes after a tool call.
        const delta = toolSinceText && wroteText ? `\n\n${c.text.replace(/^\n+/, '')}` : c.text;
        wroteText = true;
        toolSinceText = false;
        return [{ type: 'text', delta }];
      }
      case 'tool_call':
      case 'tool_call_update': {
        toolSinceText = true;
        const id = String(u.toolCallId);
        const t = tools.get(id) ?? {};
        if (typeof u.kind === 'string') t.kind = u.kind;
        if (typeof u.title === 'string') t.title = u.title;
        if (u.rawInput && typeof u.rawInput === 'object' && Object.keys(u.rawInput).length) t.rawInput = u.rawInput as Json;
        tools.set(id, t);
        const started = t.rawInput || (u.status && u.status !== 'pending');
        if (t.emitted || !started) return [];
        t.emitted = true;
        return [{ type: 'tool', summary: summarizeTool(t, cwd) }];
      }
      default:
        return [];
    }
  };
}

interface LiveSession {
  client: AcpClient;
  sessionId: string;
  cwd: string;
  models: AcpModel[];
  defaultModel: string;
  model: string;
  busy: boolean;
  idle?: NodeJS.Timeout;
}

const sessions = new Map<string, LiveSession>();

export function closeAcpSession(sessionId: string): void {
  const s = sessions.get(sessionId);
  if (!s) return;
  clearTimeout(s.idle);
  sessions.delete(sessionId);
  s.client.close();
  log('closed agent session', sessionId);
}

export function closeAllAcpSessions(): void {
  for (const id of [...sessions.keys()]) closeAcpSession(id);
}

const CLIENT_INFO = { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } };

async function openSession(bin: string, opts: AskOpts, spawnArgs: string[]): Promise<LiveSession> {
  const client = new AcpClient(bin, opts.cwd, spawnArgs);
  const onAbort = () => client.close();
  opts.signal.addEventListener('abort', onAbort, { once: true });
  try {
    await client.request('initialize', CLIENT_INFO);
    const params = { cwd: opts.cwd, mcpServers: [] };
    let sessionId: string;
    let result: Json;
    if (opts.sessionId) {
      sessionId = opts.sessionId;
      try {
        // Replays the conversation as updates, which are ignored: the panel already shows it.
        result = await client.request('session/load', { sessionId, ...params });
      } catch (err) {
        throw new Error(`Couldn't reopen this conversation (${(err as Error).message}). Start a new thread.`);
      }
    } else {
      result = await client.request('session/new', params);
      sessionId = String(result.sessionId);
    }
    await client.request('session/set_mode', { sessionId, modeId: 'ask' });
    const current = String((result.models as { currentModelId?: unknown } | undefined)?.currentModelId ?? '');
    const live: LiveSession = { client, sessionId, cwd: opts.cwd, models: acpModels(result), defaultModel: current, model: current, busy: false };
    sessions.set(sessionId, live);
    log(opts.sessionId ? 'reopened agent session' : 'opened agent session', sessionId);
    return live;
  } catch (err) {
    client.close();
    throw err;
  } finally {
    opts.signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Sends a prompt over a persistent ACP session. Reuses the live process across
 * follow-ups and terminates it after `ACP_IDLE_MS` idle, on `close_session`, or on host exit.
 */
export async function* askAcp(
  bin: string,
  opts: AskOpts,
  onModels?: (models: AcpModel[]) => void,
  spawnArgs: string[] = ['acp'],
): AsyncGenerator<AdapterEvent> {
  let s = opts.sessionId ? sessions.get(opts.sessionId) : undefined;
  if (s && (!s.client.alive || s.cwd !== opts.cwd || s.busy)) {
    closeAcpSession(s.sessionId);
    s = undefined;
  }
  if (s) {
    clearTimeout(s.idle);
  } else {
    try {
      s = await openSession(bin, opts, spawnArgs);
    } catch (err) {
      if (!opts.signal.aborted) yield { type: 'error', message: (err as Error).message };
      return;
    }
    if (s.models.length) onModels?.(s.models);
  }
  const session = s;
  session.busy = true;
  const { client, sessionId } = session;
  const updates: AdapterEvent[] = [];
  let wake: (() => void) | null = null;
  let finished = false;
  const push = (ev: AdapterEvent) => {
    updates.push(ev);
    wake?.();
  };
  // A cancelled prompt should end promptly; if the agent doesn't, stop its process.
  let killTimer: NodeJS.Timeout | undefined;
  const onAbort = () => {
    client.notify('session/cancel', { sessionId });
    killTimer = setTimeout(() => closeAcpSession(sessionId), 5000);
  };

  try {
    yield { type: 'session', sessionId };
    const wanted = opts.model ? matchModel(session.models, opts.model) : undefined;
    if (opts.model && !wanted) {
      yield { type: 'error', message: `Cursor has no model “${opts.model}”. Pick another one in the model menu.` };
      return;
    }
    const target = wanted?.value ?? session.defaultModel;
    if (target && target !== session.model) {
      await client.request('session/set_model', { sessionId, modelId: target });
      session.model = target;
    }
    if (session.model) yield { type: 'model', model: baseModel(session.model) };

    const map = createUpdateMapper(opts.cwd);
    client.onUpdate = (sid, update) => {
      if (sid === sessionId) for (const ev of map(update)) push(ev);
    };
    opts.signal.addEventListener('abort', onAbort, { once: true });
    client
      .request<{ stopReason?: string }>('session/prompt', { sessionId, prompt: [{ type: 'text', text: opts.prompt }] })
      .then(
        (r) => {
          if (r?.stopReason === 'refusal') push({ type: 'error', message: 'Cursor declined to answer.' });
        },
        (err: Error) => {
          if (!opts.signal.aborted) push({ type: 'error', message: err.message });
        },
      )
      .finally(() => {
        finished = true;
        wake?.();
      });

    while (true) {
      if (updates.length) {
        yield updates.shift()!;
        continue;
      }
      if (finished) break;
      await new Promise<void>((resolve) => (wake = resolve));
      wake = null;
    }
  } catch (err) {
    if (!opts.signal.aborted) yield { type: 'error', message: (err as Error).message };
  } finally {
    opts.signal.removeEventListener('abort', onAbort);
    clearTimeout(killTimer);
    client.onUpdate = null;
    session.busy = false;
    if (!client.alive) {
      sessions.delete(sessionId);
    } else if (sessions.get(sessionId) === session) {
      session.idle = setTimeout(() => closeAcpSession(sessionId), ACP_IDLE_MS);
      session.idle.unref();
    }
  }
}

/** Opens a throwaway session in `cwd` to read the model list. */
export async function probeAcpModels(bin: string, cwd: string, spawnArgs: string[] = ['acp']): Promise<AcpModel[]> {
  const client = new AcpClient(bin, cwd, spawnArgs);
  const timer = setTimeout(() => client.close(), 20_000);
  try {
    await client.request('initialize', CLIENT_INFO);
    return acpModels(await client.request('session/new', { cwd, mcpServers: [] }));
  } finally {
    clearTimeout(timer);
    client.close();
  }
}
