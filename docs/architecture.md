# Architecture

Quack consists of three workspaces:

- `@quack/shared` (`shared/`): Wire protocol types, constants, and the `quack-ci` report parser.
- `@quack/extension` (`extension/`): Manifest V3 extension (content script, background service worker, and React side panel).
- `quack-companion` (`companion/`): Local Node.js native messaging host that manages git worktrees and spawns local AI CLIs.

## Data Flow

1. **Page inspection (`extension/entrypoints/github.content.ts`, `extension/lib/github.ts`)**
   The content script runs on `https://github.com/*`, tracks SPA navigations, extracts PR metadata (`owner`, `repo`, `number`, `headSha`, `baseRef`, `title`, diff stats), and detects diff selections (DOM text selection, `#diff-<sha256>R10-R20` URL hash line picks, or open inline comment boxes). It renders a Shadow DOM floating button (`extension/lib/askButton.ts`) above selected diff lines and reports `PageContext` changes to the side panel.

2. **Background bridge (`extension/entrypoints/background.ts`)**
   The background service worker owns a single Chrome Native Messaging port (`browser.runtime.connectNative('com.quack.companion')`) shared across open side panels. It routes responses back to the requesting panel by `requestId`, sends `cancel` messages if a panel disconnects mid-request, and disconnects the native port when the last side panel closes.

3. **Native messaging framing (`companion/src/framing.ts`, `companion/src/host.ts`)**
   Chrome Native Messaging frames each message on `stdin`/`stdout` with a 32-bit little-endian byte length followed by UTF-8 JSON.
   - Incoming messages are capped at 64 MB (`MAX_INCOMING`) and validated by `validateMessage` (`companion/src/validate.ts`) before dispatch.
   - Outgoing text deltas larger than 64 KB (`MAX_TEXT_DELTA`) are split into multiple messages to stay well below Chrome's 1 MB host-to-browser frame limit.
   - When `stdin` closes (browser closes the port), the host aborts all in-flight requests and terminates open agent child processes.

## PR Resolution & Worktree Isolation

Handled by `companion/src/session.ts`, `companion/src/repo.ts`, `companion/src/pr.ts`, and `companion/src/worktree.ts`:

1. **Clone discovery (`findClone`)**: Checks `config.repoPaths` overrides first, then scans `config.scanRoots` up to two levels deep, matching `git remote get-url origin` (SSH, HTTPS, or `git://`) against `owner/repo`.
2. **PR fetch (`resolvePr`)**: Fetches `+pull/<n>/head:refs/pr-review/<n>` from `origin`. Queries `gh pr view` (when `gh` is installed) for `baseRefOid`, `headRefOid`, `title`, and `body`; falls back to `git fetch` + `git merge-base` when `gh` is unavailable.
3. **Detached worktree (`prepareWorktree`)**: Creates or resets a detached worktree at `~/.quack/worktrees/<owner>/<repo>/pr-<n>` checked out at `headSha`. Access to each worktree path is serialized via an in-memory promise queue (`acquireLock`).
4. **Selection resolution (`resolveSelections`)**: Resolves GitHub diff file anchors (`sha256(path)`) against changed file paths in `baseSha...headSha`, and reads selected line ranges via `git show <sha>:<path>` so repository symlinks cannot escape the repository root.

## Agent Adapters

Defined in `companion/src/adapters/`:

- **Cursor (`cursor.ts`, `acp.ts`)**: Runs `cursor-agent acp` (Agent Client Protocol over newline-delimited JSON-RPC 2.0 on stdio).
  - Sessions are set to `modeId: 'ask'` (read-only), and client capabilities disable file writes and terminal execution (`writeTextFile: false`, `terminal: false`). Any `session/request_permission` request from the agent is automatically cancelled.
  - The `AcpClient` process is kept alive in memory across follow-up questions in the same thread and closed after 15 minutes of inactivity (`ACP_IDLE_MS`), on explicit `close_session`, or on host shutdown.
- **Claude Code (`claude.ts`, `stream.ts`)**: Spawns `claude -p --output-format stream-json --verbose --permission-mode plan` (plus `--include-partial-messages` when supported, and `--resume <sessionId>` on follow-ups).
  - `createClaudeParser` normalizes partial `stream_event` text deltas, skips duplicate full assistant blocks when partial deltas were emitted, extracts `ExitPlanMode` plan text, and summarizes tool calls.

After every agent run, `handleAsk` checks `git status --porcelain` in the worktree (`changedFiles`) and emits a warning if the agent modified any files; the worktree is hard-reset before the next run.

## CI Failure Analysis

Handled by `companion/src/checks.ts`, `companion/src/prompt.ts`, and `shared/src/ci.ts`:

1. `listFailingChecks` runs `gh pr checks <n> --json name,state,bucket,link,workflow` and filters for failed checks.
2. When the user triggers **Check CI** (`task: 'explain_ci'`), `collectCi` fetches the last 200 lines of failed logs (`gh run view --log-failed`) within a 48 KB total budget (`TOTAL_LOG_CHARS`) and queries recent base-branch conclusions (`gh run list --branch <base> --workflow <name>`) to compute the base-branch failure rate.
3. `buildCiPrompt` instructs the agent to output a fenced `quack-ci` JSON block with verdicts (`caused_by_pr`, `flaky`, `unclear`), file references, and optional minimal patches, which `parseCiReport` parses into structured cards for the UI.

## Security Model

- **Origin verification**: `startHost` verifies the `chrome-extension://<id>/` CLI argument passed by Chrome against `ALLOWED_EXTENSION_IDS` before reading `stdin`.
- **No shell execution**: All external binaries (`git`, `gh`, `cursor-agent`, `claude`) are invoked via `execFile` or `spawn` with argument arrays (`companion/src/exec.ts`), never through a shell.
- **Input validation**: `validateMessage` (`companion/src/validate.ts`) validates every field from the extension against strict regexes and length bounds. Model names, session IDs, branch names, and workflow names reject leading `-` to prevent CLI flag injection.
- **Process group cleanup**: Child processes are spawned with `detached: true` and terminated via `process.kill(-pid, 'SIGTERM')` followed by `SIGKILL` after 3 seconds (`killTree`).
