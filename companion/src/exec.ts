import { execFile, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { EXTRA_BIN_DIRS } from './paths.ts';

/** Builds a `PATH` string combining the active Node binary directory, `process.env.PATH`, and standard user/system bin directories. */
export function searchPath(): string {
  const dirs = [path.dirname(process.execPath), ...(process.env.PATH ?? '').split(':'), ...EXTRA_BIN_DIRS];
  return [...new Set(dirs.filter(Boolean))].join(':');
}

/** Environment for child processes: expanded `PATH`, non-interactive git prompts, and color disabled. */
export function childEnv(): NodeJS.ProcessEnv {
  return { ...process.env, PATH: searchPath(), GIT_TERMINAL_PROMPT: '0', NO_COLOR: '1' };
}

/** Resolves the first executable matching `names` on `searchPath()`. */
export function findBinary(names: string[]): string | null {
  for (const dir of searchPath().split(':')) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // not here
      }
    }
  }
  return null;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Overrides applied to every git command. A PR can otherwise run code through
 * `core.hooksPath` (husky) or `core.fsmonitor` during checkout.
 */
export const GIT_LOCKDOWN = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];

/** Runs git with hooks and the filesystem monitor forced off. Never goes through a shell. */
export function runGit(args: string[], opts: { cwd?: string; timeoutMs?: number; maxBuffer?: number } = {}): Promise<RunResult> {
  return run('git', [...GIT_LOCKDOWN, ...args], opts);
}

/** Runs a program with an argument array. Never goes through a shell. */
export function run(
  file: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number; maxBuffer?: number } = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        cwd: opts.cwd,
        env: childEnv(),
        timeout: opts.timeoutMs ?? 60_000,
        maxBuffer: opts.maxBuffer ?? 32 * 1024 * 1024,
        encoding: 'utf8',
      },
      (err, stdout, stderr) => {
        const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
        resolve({ code, stdout: stdout ?? '', stderr: stderr ?? (err ? String(err.message) : '') });
      },
    );
  });
}

/** Spawns a child process in its own process group (`detached: true`) with piped stdout/stderr. */
export function spawnStreaming(file: string, args: string[], cwd: string, opts: { stdin?: boolean } = {}): ChildProcess {
  return spawn(file, args, { cwd, env: childEnv(), stdio: [opts.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'], detached: true });
}

/** Terminates the child's process group with SIGTERM, escalating to SIGKILL after 3s. */
export function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.pid === undefined) return;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
  setTimeout(() => {
    if (child.exitCode === null && child.pid !== undefined) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
  }, 3000).unref();
}
