# Architecture

Quack is split into three TypeScript workspaces so the browser UI and local OS operations stay cleanly separated:

| Workspace | Path | Responsibility |
| --- | --- | --- |
| `@quack/shared` | `shared/` | Wire protocol types, shared constants, and the `quack-ci` JSON report parser |
| `@quack/extension` | `extension/` | Content script (`github.com`), background native-port multiplexer, and React side panel |
| `quack-companion` | `companion/` | Local Node.js native messaging host: clone lookup, git worktrees, `gh` CI logs, and AI CLI adapters |

---

## System Overview

```mermaid
flowchart TB
  subgraph Browser["Chrome / Edge (Manifest V3)"]
    CS["github.content.ts<br/>PR metadata, diff selection & Ask button"]
    SP["Side Panel (React)<br/>Thread UI, CI cards & review drafts"]
    BG["background.ts<br/>Multiplexes 1 native port by requestId"]
    CS -->|"PageContext"| SP
    SP <-->|"runtime.Port"| BG
  end

  subgraph Host["Local Machine (quack-companion)"]
    NM["host.ts + framing.ts<br/>32-bit LE length-prefixed JSON + validation"]
    SES["session.ts + worktree.ts<br/>Clone lookup, PR fetch & per-PR lock"]
    CHK["checks.ts<br/>gh pr checks + failed log tails"]
    ADP["Agent Adapters<br/>Cursor (ACP) / Claude Code (stream-json)"]
    NM --> SES
    NM --> CHK
    SES --> ADP
  end

  BG <-->|"Chrome Native Messaging (stdio)"| NM
  SES -->|"refs/pr-review/N"| GIT[("Local Git Clone<br/>& Detached Worktree")]
  ADP -->|"read-only cwd"| GIT
  CHK -.->|"HTTPS via gh"| GHAPI[("GitHub API")]
```

---

## Request Lifecycle

```mermaid
sequenceDiagram
  autonumber
  actor User
  participant Panel as Side Panel
  participant Host as quack-companion
  participant Git as Local Clone & Worktree
  participant Agent as Cursor / Claude CLI

  Panel->>Host: status
  Host-->>Panel: status (protocol, ready agents & models)

  User->>Panel: Ask question (or click "Check CI")
  Panel->>Host: ask { pr, agent, question, selections, task? }

  Host-->>Panel: progress (finding_repo -> fetching_pr -> preparing_worktree)
  Host->>Git: git fetch origin +pull/N/head:refs/pr-review/N
  Host->>Git: git worktree add/reset --detach ~/.quack/worktrees/.../pr-N

  opt task === "explain_ci"
    Host-->>Panel: progress (fetching_ci)
    Host->>Host: gh run view --log-failed + base-branch failure rate
  end

  Host-->>Panel: progress (starting_agent)
  Host->>Agent: Spawn / prompt in detached worktree (read-only)
  loop Streaming response
    Agent-->>Host: Text deltas & tool call updates
    Host-->>Panel: event { type: "text" | "tool" } (chunked <= 64 KB)
  end
  Host->>Git: Verify git status --porcelain is clean
  Host-->>Panel: event { type: "done", sessionId, headSha }
```

---

## PR Resolution & Worktree Isolation

1. **Clone discovery (`companion/src/repo.ts`)**: Checks `config.repoPaths` overrides first, then scans `config.scanRoots` up to 2 directory levels deep, matching `git remote get-url origin` (SSH, HTTPS, or `git://`) against `owner/repo`.
2. **PR commit resolution (`companion/src/pr.ts`)**: Fetches `+pull/<n>/head:refs/pr-review/<n>`. Uses `gh pr view` when available for `baseRefOid`, `headRefOid`, title, and body; falls back to `git fetch` + `git merge-base` when `gh` is absent.
3. **Serialized worktrees (`companion/src/worktree.ts`)**: Checks out `~/.quack/worktrees/<owner>/<repo>/pr-<n>` detached at `headSha`. Concurrent requests for the same PR wait on an in-memory promise queue (`acquireLock`).
4. **Symlink-safe line reading (`companion/src/selection.ts`)**: Resolves GitHub's `#diff-<sha256(path)>` anchors against changed files in `baseSha...headSha` and reads snippets via `git show <sha>:<path>` rather than filesystem reads.

---

## Agent Adapters

| Adapter | CLI Invocation | Read-Only Enforcement | Follow-up Sessions |
| --- | --- | --- | --- |
| **Cursor** (`cursor.ts`, `acp.ts`) | `cursor-agent acp` (JSON-RPC 2.0 over stdio) | Session mode set to `ask`; `writeTextFile: false`, `terminal: false`; permission prompts auto-cancelled | Keeps `AcpClient` alive in memory for 15 min (`ACP_IDLE_MS`) |
| **Claude Code** (`claude.ts`, `stream.ts`) | `claude -p --output-format stream-json --verbose` | Runs with `--permission-mode plan` | Resumes via `--resume <sessionId>` |

After every turn, `session.ts` checks `git status --porcelain` in the worktree (`changedFiles`), warns if anything was touched, and `git reset --hard` + `git clean -fdq` runs before the next turn.

---

## Security Boundaries

| Boundary | Mechanism |
| --- | --- |
| **Origin allowlist** | `startHost` checks Chrome's `chrome-extension://<id>/` argument against `ALLOWED_EXTENSION_IDS` before reading `stdin`. |
| **No shell execution** | External tools (`git`, `gh`, `cursor-agent`, `claude`) run via `execFile` / `spawn` argument arrays (`exec.ts`), never a shell. |
| **Strict input validation** | `validate.ts` enforces length caps and regexes on all wire fields; model names, branches, session IDs, and workflow names reject leading `-` to block flag injection. |
| **Frame bounds** | Incoming frames cap at 64 MB; outgoing text deltas split at 64 KB (`MAX_TEXT_DELTA`) to stay under Chrome's 1 MB native messaging limit. |
| **Process tree cleanup** | Subprocesses run in their own process group (`detached: true`) and are killed via `SIGTERM` → `SIGKILL` (`killTree`) on cancel or browser disconnect. |
