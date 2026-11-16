import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { ProgressStep } from '@quack/shared';
import { PROGRESS_LABELS } from '@quack/shared';
import { childEnv } from './exec.ts';
import { log as logLine } from './log.ts';
import { BIN_DIR, LOG_FILE } from './paths.ts';

export interface MenuTask {
  label: string;
  step: string | null;
  updatedAt: number;
}

/** Status written to the menu bar helper. Omitted fields stay hidden. */
export interface MenuStatus {
  title: string;
  subtitle?: string;
  count?: string;
}

export interface MenuBar {
  update(status: MenuStatus): void;
  stop(): void;
}

export interface MenuBarOptions {
  platform?: NodeJS.Platform;
  binary?: string;
  logFile?: string;
  log?: (...parts: unknown[]) => void;
}

const noopMenuBar: MenuBar = { update() {}, stop() {} };

/** Idle menu, or the newest ask plus a count when more than one is in flight. */
export function menuStatus(tasks: readonly MenuTask[]): MenuStatus {
  if (tasks.length === 0) return { title: 'Connected' };
  const latest = tasks.reduce((best, task) => (task.updatedAt >= best.updatedAt ? task : best));
  const status: MenuStatus = { title: latest.label };
  if (latest.step) status.subtitle = latest.step;
  if (tasks.length > 1) status.count = `${tasks.length} requests`;
  return status;
}

/** One JSON line for the helper. Idle is exactly `{"title":"Connected"}`. */
export function encodeMenuStatus(status: MenuStatus): string {
  const payload: { title: string; subtitle?: string; count?: string } = { title: status.title };
  if (status.subtitle) payload.subtitle = status.subtitle;
  if (status.count) payload.count = status.count;
  return JSON.stringify(payload);
}

/** Tracks in-flight asks so the menu can return to Connected when the last one ends. */
export class MenuActivity {
  private readonly tasks = new Map<string, MenuTask>();
  private seq = 0;

  begin(requestId: string, label: string): MenuStatus {
    this.tasks.set(requestId, { label, step: null, updatedAt: ++this.seq });
    return this.current();
  }

  progress(requestId: string, step: ProgressStep): MenuStatus | null {
    const task = this.tasks.get(requestId);
    if (!task) return null;
    task.step = PROGRESS_LABELS[step];
    task.updatedAt = ++this.seq;
    return this.current();
  }

  end(requestId: string): MenuStatus | null {
    if (!this.tasks.delete(requestId)) return null;
    return this.current();
  }

  current(): MenuStatus {
    return menuStatus([...this.tasks.values()]);
  }
}

/**
 * Spawns the macOS menu bar helper when it was compiled at install.
 * Off macOS, or when the binary is missing, updates are ignored and the host keeps running.
 */
export function startMenuBar(opts: MenuBarOptions = {}): MenuBar {
  const platform = opts.platform ?? process.platform;
  if (platform !== 'darwin') return noopMenuBar;

  const writeLog = opts.log ?? logLine;
  const binary = opts.binary ?? pathJoinBinary();
  if (!isFile(binary)) {
    writeLog('menu bar helper missing; run quack-companion install again');
    return noopMenuBar;
  }

  let child: ChildProcess;
  try {
    // Stay in this process group. Agent children use their own group so killTree cannot signal the icon.
    child = spawn(binary, [opts.logFile ?? LOG_FILE], {
      stdio: ['pipe', 'ignore', 'pipe'],
      detached: false,
      env: childEnv(),
    });
  } catch (err) {
    writeLog('menu bar helper failed', err instanceof Error ? err.message : String(err));
    return noopMenuBar;
  }

  let failed = false;
  let loggedStderr = false;
  const noteFailure = (detail: string) => {
    if (failed) return;
    failed = true;
    writeLog('menu bar helper failed', detail);
  };
  child.on('error', (err) => noteFailure(err.message));
  child.stdin?.on('error', () => {
    failed = true;
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    if (loggedStderr) return;
    loggedStderr = true;
    const text = chunk.toString('utf8').trim().slice(0, 500);
    if (text) writeLog('menu bar helper', text);
  });

  let stopped = false;
  return {
    update(status: MenuStatus): void {
      const stdin = child.stdin;
      if (failed || !stdin || stdin.destroyed || !stdin.writable) return;
      try {
        stdin.write(`${encodeMenuStatus(status)}\n`);
      } catch {
        failed = true;
      }
    },
    stop(): void {
      if (stopped) return;
      stopped = true;
      try {
        child.stdin?.end();
      } catch {
        // The pipe is already closed.
      }
      if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
        try {
          child.kill('SIGTERM');
        } catch {
          // Already gone.
        }
      }
    },
  };
}

function pathJoinBinary(): string {
  return path.join(BIN_DIR, 'quack-menubar');
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}
