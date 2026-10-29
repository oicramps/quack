import type { BackendId, BackendStatus } from '@quack/shared';

export interface AskOpts {
  cwd: string;
  prompt: string;
  /** Empty string: the tool's default model. */
  model: string;
  sessionId: string | null;
  signal: AbortSignal;
}

export type AdapterEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool'; summary: string }
  | { type: 'session'; sessionId: string }
  | { type: 'model'; model: string }
  | { type: 'error'; message: string };

export interface Adapter {
  id: BackendId;
  label: string;
  isAvailable(): Promise<BackendStatus>;
  ask(opts: AskOpts): AsyncIterable<AdapterEvent>;
}

/** Turns one parsed stream-json line into zero or more adapter events. */
export type LineParser = (line: Record<string, unknown>) => AdapterEvent[];
