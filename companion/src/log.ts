import fs from 'node:fs';
import path from 'node:path';
import { LOG_FILE } from './paths.ts';

// stdout carries the native messaging protocol, so diagnostics go to a file.
// Never log prompts, diffs or answers: logs must not contain code.
let ready = false;

export function log(...parts: unknown[]): void {
  try {
    if (!ready) {
      fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
      ready = true;
    }
    const line = parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ');
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} [${process.pid}] ${line}\n`);
  } catch {
    // Logging must never break the host.
  }
}
