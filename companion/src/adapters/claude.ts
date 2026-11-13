import fs from 'node:fs';
import path from 'node:path';
import type { AgentStatus, FixStep } from '@quack/shared';
import { findBinary, run } from '../exec.ts';
import { HOME } from '../paths.ts';
import { clip, relativeTo, runJsonLines, stripAnsi } from './stream.ts';
import type { Adapter, AdapterEvent, AskOpts, LineParser } from './types.ts';

const MODELS = ['sonnet', 'opus', 'haiku'];
const RECHECK: FixStep = { text: 'Then press Re-check.' };
const LOGIN: FixStep = { text: 'Log in: run Claude Code once and complete the browser sign-in, then quit it', command: 'claude' };

/**
 * Claude Code has no single documented "am I logged in" command across versions,
 * so this tries `claude auth status` and falls back to where credentials live.
 */
async function loggedIn(bin: string): Promise<boolean> {
  if (process.env.ANTHROPIC_API_KEY) return true;
  const status = await run(bin, ['auth', 'status'], { timeoutMs: 15_000 });
  const out = stripAnsi(status.stdout + status.stderr);
  if (status.code === 0 && /logged in|authenticated|"loggedIn":\s*true/i.test(out) && !/not logged in/i.test(out)) return true;
  if (/not logged in|not authenticated|"loggedIn":\s*false/i.test(out)) return false;
  if (process.platform === 'darwin') {
    const keychain = await run('/usr/bin/security', ['find-generic-password', '-s', 'Claude Code-credentials'], { timeoutMs: 5000 });
    if (keychain.code === 0) return true;
  }
  return fs.existsSync(path.join(HOME, '.claude', '.credentials.json'));
}

function summarizeTool(name: string, input: Record<string, unknown>, cwd: string): string | null {
  switch (name) {
    case 'Read':
      return `Read ${relativeTo(cwd, input.file_path)}`;
    case 'Grep':
      return `Searched repo for ${clip(String(input.pattern ?? ''), 60)}`;
    case 'Glob':
      return `Listed files matching ${clip(String(input.pattern ?? ''), 60)}`;
    case 'LS':
      return `Listed ${relativeTo(cwd, input.path) || '.'}`;
    case 'Bash':
      return `Ran ${clip(String(input.command ?? ''), 60)}`;
    case 'Task':
      return `Started a sub-agent: ${clip(String(input.description ?? ''), 60)}`;
    case 'TodoWrite':
    case 'ExitPlanMode':
      return null;
    default:
      return `Used ${name}`;
  }
}

/**
 * Parses Claude Code `--output-format stream-json --verbose` output.
 * Emits partial text deltas from `stream_event` when present, skips duplicate
 * full `assistant` text blocks, and extracts plan text from `ExitPlanMode` tool calls.
 */
export function createClaudeParser(cwd: string): LineParser {
  let partial = false;
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
        if (obj.subtype === 'init' && typeof obj.model === 'string') events.push({ type: 'model', model: obj.model });
        break;
      case 'stream_event': {
        const ev = obj.event as { type?: string; delta?: { type?: string; text?: string } } | undefined;
        if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
          partial = true;
          events.push({ type: 'text', delta: ev.delta.text });
        }
        break;
      }
      case 'assistant': {
        const content = ((obj.message as { content?: unknown[] })?.content ?? []) as {
          type?: string;
          text?: string;
          name?: string;
          input?: Record<string, unknown>;
        }[];
        for (const block of content) {
          if (block.type === 'text' && block.text && !partial) {
            events.push({ type: 'text', delta: block.text });
          } else if (block.type === 'tool_use' && block.name) {
            if (block.name === 'ExitPlanMode' && typeof block.input?.plan === 'string') {
              events.push({ type: 'text', delta: block.input.plan });
            }
            const summary = summarizeTool(block.name, block.input ?? {}, cwd);
            if (summary) events.push({ type: 'tool', summary });
          }
        }
        break;
      }
      case 'result':
        if (obj.is_error) events.push({ type: 'error', message: String(obj.result ?? obj.subtype ?? 'Claude Code reported an error.') });
        break;
    }
    return events;
  };
}

const DENIED_TOOLS = ['Bash', 'Edit', 'Write', 'NotebookEdit', 'MultiEdit', 'WebFetch', 'WebSearch', 'Task', 'mcp__*'];

/**
 * Flags that keep a PR's `.claude` settings, hooks, and MCP servers out of the
 * session, and that take shell, write, and network tools away on older CLIs
 * that have no `--restricted`. Only flags this binary advertises are returned.
 */
export function claudeGuardArgs(help: string): string[] {
  const args: string[] = [];
  if (help.includes('--restricted')) args.push('--restricted');
  else if (help.includes('--setting-sources')) args.push('--setting-sources', 'user');
  if (help.includes('--strict-mcp-config')) args.push('--strict-mcp-config');
  if (help.includes('--permission-prompts')) args.push('--permission-prompts', 'none');
  if (!help.includes('--restricted') && (help.includes('--disallowedTools') || help.includes('--disallowed-tools'))) {
    const flag = help.includes('--disallowedTools') ? '--disallowedTools' : '--disallowed-tools';
    for (const tool of DENIED_TOOLS) args.push(flag, tool);
  }
  return args;
}

export const claudeAdapter: Adapter = {
  id: 'claude-code',
  label: 'Claude Code',

  async isAvailable(): Promise<AgentStatus> {
    const bin = findBinary(['claude']);
    if (!bin) {
      return {
        id: 'claude-code',
        label: 'Claude Code',
        state: 'not_installed',
        models: MODELS,
        fixSteps: [{ text: 'Install Claude Code', command: 'curl -fsSL https://claude.ai/install.sh | bash' }, LOGIN, RECHECK],
      };
    }
    const [version, isLoggedIn] = await Promise.all([run(bin, ['--version'], { timeoutMs: 15_000 }), loggedIn(bin)]);
    return {
      id: 'claude-code',
      label: 'Claude Code',
      state: isLoggedIn ? 'ready' : 'not_logged_in',
      version: version.stdout.trim(),
      models: MODELS,
      fixSteps: isLoggedIn ? [] : [LOGIN, RECHECK],
    };
  },

  async *ask(opts: AskOpts) {
    const bin = findBinary(['claude']);
    if (!bin) {
      yield { type: 'error', message: 'Claude Code not found.' };
      return;
    }
    const help = await run(bin, ['--help'], { timeoutMs: 15_000 });
    const helpText = help.stdout + help.stderr;
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'plan', ...claudeGuardArgs(helpText)];
    if (helpText.includes('--include-partial-messages')) args.push('--include-partial-messages');
    if (opts.model) args.push('--model', opts.model);
    if (opts.sessionId) args.push('--resume', opts.sessionId);
    args.push(opts.prompt);
    yield* runJsonLines(bin, args, opts.cwd, opts.signal, createClaudeParser(opts.cwd), 'claude-code');
  },
};
