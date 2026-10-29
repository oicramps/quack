import path from 'node:path';
import type { BackendStatus, FixStep } from '@quack/shared';
import { findBinary, run } from '../exec.ts';
import { clip, relativeTo, runJsonLines, stripAnsi } from './stream.ts';
import type { Adapter, AdapterEvent, AskOpts, LineParser } from './types.ts';

const INSTALL: FixStep = { text: 'Install the Cursor CLI', command: 'curl https://cursor.com/install -fsS | bash' };
const RECHECK: FixStep = { text: 'Then press Recheck.' };

// Shown when the CLI is too old to list its models.
const FALLBACK_MODELS = ['', 'auto', 'gpt-5', 'sonnet-4', 'sonnet-4-thinking'];

interface Capabilities {
  bin: string;
  name: string;
  version: string;
  partialOutput: boolean;
  listModels: boolean;
  askMode: boolean;
  trust: boolean;
}

async function capabilities(): Promise<Capabilities | null> {
  const bin = findBinary(['cursor-agent', 'agent']);
  if (!bin) return null;
  const [version, help] = await Promise.all([
    run(bin, ['--version'], { timeoutMs: 15_000 }),
    run(bin, ['--help'], { timeoutMs: 15_000 }),
  ]);
  const h = help.stdout + help.stderr;
  if (path.basename(bin) === 'agent' && !/cursor/i.test(h)) return null;
  return {
    bin,
    name: path.basename(bin),
    version: version.stdout.trim(),
    partialOutput: h.includes('--stream-partial-output'),
    listModels: h.includes('--list-models'),
    askMode: /--mode\b[\s\S]{0,200}\bask\b/.test(h),
    trust: h.includes('--trust'),
  };
}

async function loggedIn(caps: Capabilities): Promise<boolean> {
  if (process.env.CURSOR_API_KEY) return true;
  const res = await run(caps.bin, ['status'], { timeoutMs: 20_000 });
  const out = stripAnsi(res.stdout + res.stderr);
  if (/not logged in|not authenticated/i.test(out)) return false;
  return /logged in|authenticated as|signed in/i.test(out);
}

/** Parses `--list-models` output, which lists one model per line, sometimes with a description. */
export function parseModelList(out: string): string[] {
  const models: string[] = [];
  for (const raw of stripAnsi(out).split('\n')) {
    const line = raw.replace(/^[\s\-*•>]+/, '').trim();
    const m = line.match(/^([a-z0-9][a-z0-9._:\/-]*)(?:\s|$)/i);
    if (!m || m[1].endsWith(':') || /^(available|models?|tip|usage|current|default)$/i.test(m[1])) continue;
    if (!models.includes(m[1])) models.push(m[1]);
  }
  return models;
}

async function models(caps: Capabilities): Promise<string[]> {
  if (!caps.listModels) return FALLBACK_MODELS;
  const res = await run(caps.bin, ['--list-models'], { timeoutMs: 20_000 });
  const list = res.code === 0 ? parseModelList(res.stdout) : [];
  return list.length ? ['', ...list] : FALLBACK_MODELS;
}

function summarizeTool(call: Record<string, unknown> | undefined, cwd: string): string | null {
  if (!call) return null;
  const [key, value] = Object.entries(call)[0] ?? [];
  if (!key) return null;
  const v = (value ?? {}) as { args?: Record<string, unknown>; name?: string; arguments?: unknown };
  const a = v.args ?? {};
  const kind = key.replace(/ToolCall$/, '');
  switch (kind) {
    case 'read':
      return `Read ${relativeTo(cwd, a.path)}`;
    case 'grep':
      return `Searched repo for ${clip(String(a.pattern ?? ''), 60)}`;
    case 'glob':
      return `Listed files matching ${clip(String(a.globPattern ?? a.pattern ?? ''), 60)}`;
    case 'ls':
      return `Listed ${relativeTo(cwd, a.path) || '.'}`;
    case 'semSearch':
      return `Searched codebase for ${clip(String(a.query ?? ''), 60)}`;
    case 'shell':
      return `Ran ${clip(String(a.command ?? ''), 60)}`;
    case 'edit':
    case 'write':
    case 'delete':
      return `Tried to ${kind} ${relativeTo(cwd, a.path)}`;
    case 'function':
      return `Used ${v.name ?? 'a tool'}`;
    default:
      return `Used ${kind}`;
  }
}

/**
 * Cursor's stream-json: `system` (init, with session_id and model), `assistant`
 * (text; incremental with --stream-partial-output), `tool_call` (started/completed)
 * and `result`. With partial output the final assistant message can repeat the
 * text already streamed since the last tool call, so exact repeats are dropped.
 */
export function createCursorParser(cwd: string): LineParser {
  let segment = '';
  let sessionSent = false;
  return (obj) => {
    const events: AdapterEvent[] = [];
    const sid = obj.session_id;
    if (typeof sid === 'string' && sid && !sessionSent) {
      sessionSent = true;
      events.push({ type: 'session', sessionId: sid });
    }
    switch (obj.type) {
      case 'system':
        if (typeof obj.model === 'string') events.push({ type: 'model', model: obj.model });
        break;
      case 'assistant': {
        const content = ((obj.message as { content?: unknown[] })?.content ?? []) as { type?: string; text?: string }[];
        const text = content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
        if (!text || (segment && text === segment)) break;
        segment += text;
        events.push({ type: 'text', delta: text });
        break;
      }
      case 'tool_call':
        if (obj.subtype === 'started') {
          segment = '';
          const summary = summarizeTool(obj.tool_call as Record<string, unknown>, cwd);
          if (summary) events.push({ type: 'tool', summary });
        }
        break;
      case 'result':
        if (obj.is_error) events.push({ type: 'error', message: String(obj.result ?? 'Cursor reported an error.') });
        break;
    }
    return events;
  };
}

export const cursorAdapter: Adapter = {
  id: 'cursor',
  label: 'Cursor',

  async isAvailable(): Promise<BackendStatus> {
    const caps = await capabilities();
    if (!caps) {
      return { id: 'cursor', label: 'Cursor', state: 'not_installed', models: [], fixSteps: [INSTALL, { text: 'Log in', command: 'cursor-agent login' }, RECHECK] };
    }
    const [isLoggedIn, list] = await Promise.all([loggedIn(caps), models(caps)]);
    const hint = caps.partialOutput
      ? undefined
      : `Cursor CLI ${caps.version} can't stream partial output or list models, so answers arrive in larger chunks. Update it with \`${caps.name} update\`.`;
    if (!isLoggedIn) {
      return {
        id: 'cursor',
        label: 'Cursor',
        state: 'not_logged_in',
        version: caps.version,
        models: list,
        hint,
        fixSteps: [{ text: 'Log in to the Cursor CLI (opens your browser)', command: `${caps.name} login` }, RECHECK],
      };
    }
    return { id: 'cursor', label: 'Cursor', state: 'ready', version: caps.version, models: list, hint, fixSteps: [] };
  },

  async *ask(opts: AskOpts) {
    const caps = await capabilities();
    if (!caps) {
      yield { type: 'error', message: 'Cursor CLI not found.' };
      return;
    }
    // No --force: without it the CLI does not apply file changes.
    const args = ['-p', '--output-format', 'stream-json'];
    if (caps.partialOutput) args.push('--stream-partial-output');
    if (caps.askMode) args.push('--mode', 'ask');
    if (caps.trust) args.push('--trust');
    if (opts.model) args.push('--model', opts.model);
    if (opts.sessionId) args.push('--resume', opts.sessionId);
    args.push(opts.prompt);
    yield* runJsonLines(caps.bin, args, opts.cwd, opts.signal, createCursorParser(opts.cwd), 'cursor');
  },
};
