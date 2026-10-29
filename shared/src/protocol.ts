export type BackendId = 'cursor' | 'claude-code';

export type BackendState = 'ready' | 'not_logged_in' | 'not_installed';

export type ProgressStep = 'finding_repo' | 'fetching_pr' | 'preparing_worktree' | 'starting_agent';

export type ErrorCode =
  | 'bad_request'
  | 'repo_not_found'
  | 'fetch_failed'
  | 'backend_not_installed'
  | 'backend_not_logged_in'
  | 'timeout'
  | 'cancelled'
  | 'agent_failed'
  | 'version_mismatch';

export interface FixStep {
  text: string;
  command?: string;
}

export interface BackendStatus {
  id: BackendId;
  label: string;
  state: BackendState;
  version?: string;
  /** Empty string means "let the tool pick its default model". */
  models: string[];
  fixSteps: FixStep[];
  /** Non-blocking advice, e.g. an outdated CLI that still works. */
  hint?: string;
}

export interface PrRef {
  owner: string;
  repo: string;
  number: number;
  /** Set when the page shows a specific commit; otherwise the companion resolves it. */
  headSha?: string;
  baseRef?: string;
  title?: string;
}

export interface CodeSelection {
  path?: string;
  /** GitHub's file anchor (SHA-256 of the path), used when the page doesn't expose the path. */
  fileAnchor?: string;
  /** 'old' when the lines refer to the base version (a deleted or changed line's left side). */
  side?: 'old' | 'new';
  startLine?: number;
  endLine?: number;
  /** The selected text, so the agent sees the code even when line numbers can't be read. */
  text?: string;
}

// Extension -> companion

export interface StatusRequest {
  type: 'status';
  requestId: string;
}

export interface AskRequest {
  type: 'ask';
  requestId: string;
  backend: BackendId;
  model: string;
  pr: PrRef;
  selections: CodeSelection[];
  question: string;
  sessionId: string | null;
}

export interface CancelRequest {
  type: 'cancel';
  requestId: string;
}

export type ExtensionMessage = StatusRequest | AskRequest | CancelRequest;

// Companion -> extension

export type AgentEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool'; summary: string }
  | { type: 'done'; sessionId: string | null; headSha: string; model: string }
  | { type: 'error'; code: ErrorCode; message: string; fixSteps?: FixStep[] };

export interface StatusResponse {
  type: 'status';
  requestId: string;
  version: string;
  backends: BackendStatus[];
}

export interface ProgressMessage {
  type: 'progress';
  requestId: string;
  step: ProgressStep;
  detail?: string;
}

export interface EventMessage {
  type: 'event';
  requestId: string;
  event: AgentEvent;
}

export type CompanionMessage = StatusResponse | ProgressMessage | EventMessage;

export const PROGRESS_LABELS: Record<ProgressStep, string> = {
  finding_repo: 'Finding local clone',
  fetching_pr: 'Fetching PR',
  preparing_worktree: 'Preparing worktree',
  starting_agent: 'Starting agent',
};
