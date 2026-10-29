import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { killTree, spawnStreaming } from '../exec.ts';
import { log } from '../log.ts';
import { QUACK_DIR } from '../paths.ts';
import type { AdapterEvent, LineParser } from './types.ts';

/**
 * Runs an agent CLI that prints one JSON object per line and yields normalized
 * events. Aborting the signal kills the process group.
 */
export async function* runJsonLines(
  bin: string,
  args: string[],
  cwd: string,
  signal: AbortSignal,
  parse: LineParser,
  recordAs: string,
): AsyncGenerator<AdapterEvent> {
  if (signal.aborted) return;
  const onRawLine = recorder(recordAs);
  const child = spawnStreaming(bin, args, cwd);
  const onAbort = () => killTree(child);
  signal.addEventListener('abort', onAbort, { once: true });

  let stderr = '';
  child.stderr!.setEncoding('utf8');
  child.stderr!.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-4000);
  });
  const exited = new Promise<number | null>((resolve) => {
    child.on('close', (code) => resolve(code));
    child.on('error', (err) => {
      stderr += String(err);
      resolve(-1);
    });
  });

  try {
    const lines = readline.createInterface({ input: child.stdout!, crlfDelay: Infinity });
    for await (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      onRawLine?.(line);
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(line);
      } catch {
        log('non-JSON line from agent ignored');
        continue;
      }
      for (const ev of parse(obj)) yield ev;
    }
    const code = await exited;
    if (!signal.aborted && code !== 0) {
      yield { type: 'error', message: stderrSummary(stderr) || `The agent exited with code ${code}.` };
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    killTree(child);
  }
}

/**
 * With QUACK_RECORD=1, raw agent output is saved to ~/.quack/recordings for
 * building parser fixtures. Off by default because it contains code.
 */
export function recorder(name: string): ((line: string) => void) | undefined {
  if (process.env.QUACK_RECORD !== '1') return undefined;
  const dir = path.join(QUACK_DIR, 'recordings');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
  return (line) => fs.appendFileSync(file, line + '\n');
}

export function stderrSummary(stderr: string): string {
  return stderr
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-3)
    .join(' ');
}

export function relativeTo(cwd: string, p: unknown): string {
  if (typeof p !== 'string') return '';
  return p.startsWith(cwd + '/') ? p.slice(cwd.length + 1) : p === cwd ? '.' : p;
}

export function clip(s: string, max = 80): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? one.slice(0, max - 1) + '…' : one;
}

export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b[()][A-Za-z0-9]/g, '');
}
