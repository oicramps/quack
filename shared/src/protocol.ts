export type AgentId = 'cursor' | 'claude-code';

export type AgentState = 'ready' | 'not_logged_in' | 'not_installed';

/** `thinking`: the agent is running and working on the answer, before any output. */
export type ProgressStep = 'finding_repo' | 'fetching_pr' | 'preparing_worktree' | 'fetching_ci' | 'starting_agent' | 'thinking';

/** Set on an ask that should explain failing checks instead of answering free text. */
export type AskTask = 'explain_ci';

export type ErrorCode =
  | 'bad_request'
  | 'repo_not_found'
  | 'fetch_failed'
  | 'agent_not_installed'
  | 'agent_not_logged_in'
  | 'timeout'
  | 'cancelled'
  | 'agent_failed'
  | 'version_mismatch';

export interface FixStep {
  text: string;
  command?: string;
}

export interface AgentStatus {
  id: AgentId;
  label: string;
  state: AgentState;
  version?: string;
  /** Empty string means "let the tool pick its default model". */
  models: string[];
  fixSteps: FixStep[];
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
  agent: AgentId;
  model: string;
  pr: PrRef;
  selections: CodeSelection[];
  question: string;
  sessionId: string | null;
  /** Earlier turns of the thread, sent when it continues on a new agent session (e.g. after switching agents). */
  history?: HistoryTurn[];
  task?: AskTask;
}

export interface HistoryTurn {
  question: string;
  answer: string;
}

export interface CancelRequest {
  type: 'cancel';
  requestId: string;
}

/** A check that is failing on the pull request. `link` opens the job on GitHub. */
export interface CheckRun {
  name: string;
  workflow: string;
  link: string;
  runId?: string;
  jobId?: string;
}

export interface ChecksRequest {
  type: 'checks';
  requestId: string;
  pr: PrRef;
}

/** The thread is over: the companion can stop the agent process kept open for it. No reply. */
export interface CloseSessionRequest {
  type: 'close_session';
  requestId: string;
  agent: AgentId;
  sessionId: string;
}

export interface WorkspacePrTarget {
  owner: string;
  repo: string;
}

export interface WorkspaceCheckRequest {
  type: 'workspace_check';
  requestId: string;
  pr?: WorkspacePrTarget;
}

export interface WorkspaceSaveRequest {
  type: 'workspace_save';
  requestId: string;
  /** Replace configured scanRoots when provided. */
  scanRoots?: string[];
  /** Add a single folder of repos or an individual git clone path. */
  addPath?: string;
  /** Remove or set repoPaths entries (null removes the key). */
  repoPaths?: Record<string, string | null>;
  pr?: WorkspacePrTarget;
}

export type ExtensionMessage =
  | StatusRequest
  | AskRequest
  | CancelRequest
  | CloseSessionRequest
  | ChecksRequest
  | WorkspaceCheckRequest
  | WorkspaceSaveRequest;

// Companion -> extension

export type AgentEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool'; summary: string }
  | { type: 'done'; sessionId: string | null; headSha: string; model: string }
  | { type: 'error'; code: ErrorCode; message: string; fixSteps?: FixStep[] };

export type RootState = 'ok' | 'empty' | 'missing' | 'blocked';

export interface RootCheck {
  path: string;
  state: RootState;
  repoCount: number;
}

export interface RepoOverrideCheck {
  repo: string;
  path: string;
  state: 'ok' | 'missing' | 'blocked' | 'not_git' | 'mismatch';
  detail?: string;
}

export interface WorkspaceStatus {
  /** True when ~/.quack/config.json exists on disk. */
  configured: boolean;
  /** False when the companion could not run `git --version`. */
  gitAvailable: boolean;
  roots: RootCheck[];
  overrides: RepoOverrideCheck[];
  /** Total accessible git repositories across scanRoots and valid repoPaths. */
  totalRepos: number;
  /** Present when checked for an open PR. */
  prMatch?: {
    repo: string;
    found: boolean;
    path?: string;
    detail?: string;
  };
}

export interface StatusResponse {
  type: 'status';
  requestId: string;
  version: string;
  /** PROTOCOL_VERSION of this companion. Missing on companions from before it existed. */
  protocol?: number;
  /** Feature flags advertised by the companion. */
  capabilities?: { workspace?: boolean };
  /** The agents checked so far. */
  agents: AgentStatus[];
  /** Agents still being checked. A further status message follows until this is empty or absent. */
  pending?: AgentId[];
}

export interface WorkspaceResponse {
  type: 'workspace';
  requestId: string;
  workspace: WorkspaceStatus;
  /** Validation or permission error when saving a new path, if any. */
  error?: string;
  /** Human-readable note when a path was added/verified. */
  notice?: string;
}

export interface ChecksResponse {
  type: 'checks';
  requestId: string;
  failing: CheckRun[];
  /** False when gh is missing or not logged in. The panel then hides the CI row. */
  available: boolean;
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

export type CompanionMessage = StatusResponse | ProgressMessage | EventMessage | ChecksResponse | WorkspaceResponse;

export const PROGRESS_LABELS: Record<ProgressStep, string> = {
  finding_repo: 'Finding local clone',
  fetching_pr: 'Fetching PR',
  preparing_worktree: 'Preparing worktree',
  fetching_ci: 'Fetching CI logs',
  starting_agent: 'Starting agent',
  thinking: 'Thinking',
};
