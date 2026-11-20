# Quacksteps

Ask your local **Claude Code** or **Cursor** about any GitHub pull request with full repository context—without stashing local work or switching branches.

Quacksteps pairs a Chrome, Edge, and Brave side-panel extension with a lightweight local companion ([`quack-companion`](https://www.npmjs.com/package/quack-companion)). When you ask a question on a PR, the companion fetches the PR commit into a separate, detached git worktree and runs your local AI CLI there in read-only mode.

```mermaid
flowchart LR
  GH["GitHub PR Tab<br/>(diff & line selection)"] --> EXT["Quacksteps Side Panel<br/>(Chrome / Edge / Brave)"]
  EXT <-->|"Native Messaging<br/>(stdio)"| COMP["quack-companion<br/>(spawned on demand)"]
  COMP -->|"git fetch pull/N/head"| CLONE["Your Local Clone<br/>(branches untouched)"]
  CLONE --> WT["Detached Worktree<br/>(~/.quack/worktrees)"]
  COMP -->|"read-only mode"| AI["Cursor / Claude Code"]
  AI -->|"reads callers, types & tests"| WT
  COMP -.->|"optional: failed logs"| GHCLI["gh CLI"]
```

---

## Quick Install

### Prerequisites
- **macOS or Linux** with `Node.js >= 20`, `git >= 2.30`, and a **local clone** of the repo you're reviewing
- **Cursor CLI** (`agent` / `cursor-agent`) and/or **Claude Code** (`claude`), signed in locally
- *(Optional)* **GitHub CLI** (`gh`), signed in, to enable **Check CI** failure triage

### 1. Install the Extension
Install **[Quacksteps from the Chrome Web Store](https://chromewebstore.google.com/detail/quacksteps/hkdgklakkcffcmegdagdoigpaefhlipj)** in Chrome, Edge, or Brave. Brave uses that same listing.

### 2. Register the Local Companion
Run once in your terminal (registers Chrome, Edge, Brave, and Chromium, including Brave Beta, Dev, and Nightly):

```sh
npx quack-companion@latest install
```

*(No npm? Run `curl -fsSL https://github.com/oicramps/quacksteps/releases/latest/download/install.sh | sh` instead.)*

Restart your browser once, open any PR on `github.com`, and click the **Quacksteps** toolbar icon.

On macOS, install also compiles `~/.quack/bin/quack-menubar` when the Xcode Command Line Tools are present. A duck then stays in the menu bar while the side panel is open.

---

## Features

| Feature | How to Use It |
| --- | --- |
| **Ask with full repo context** | Open the side panel on any PR and ask a question—your agent can inspect callers, configs, and tests outside the diff. |
| **Attach exact diff lines** | Click a line number in a GitHub diff (Shift-click for a range), then press **`Cmd/Ctrl+Shift+K`** or click **Ask Quacksteps**. |
| **Triage failing CI (`Check CI`)** | When checks fail and `gh` is logged in, click **Check CI** to separate real PR regressions (with copyable patches) from flaky jobs. |
| **Switch agents mid-thread** | Ask follow-ups in the same session, or switch between **Cursor** and **Claude Code** without losing earlier turns. |
| **Draft review comments** | Turn any answer into an editable Markdown review comment and jump straight to the GitHub diff line. |
| **Commit sync detection** | Quacksteps tracks the exact commit SHA behind each answer and offers **Re-ask on latest** when new commits land. |
| **Menu bar status (macOS)** | While the side panel is open, a duck in the menu bar shows Connected, or the pull request and step while an ask is running. **Open Log** opens the companion log. |

---

## Configuration & Cleanup

On first run, Quacksteps creates `~/.quack/config.json` and scans common project folders (`~/Documents/Dev/Projects`, `~/Projects`, `~/Developer`, `~/Development`, `~/Dev`, `~/repos`, `~/src`, `~/code`, `~/workspace`, `~/work`, `~/GitHub`, `~/git`) up to 2 levels deep to match your local clone's `origin` remote. To link a clone anywhere else (or with a custom SSH host alias):

```sh
~/.quack/bin/quack-companion link /path/to/clone owner/repo
```

Or edit `"repoPaths"` / `"scanRoots"` directly in `~/.quack/config.json`:

```json
{
  "scanRoots": ["~/Documents/Dev/Projects", "~/Projects", "~/Developer", "~/repos", "~/src", "~/code"],
  "repoPaths": { "owner/repo": "/custom/path/to/clone" },
  "worktreeRoot": "~/.quack/worktrees",
  "retentionDays": 7,
  "maxWorktrees": 20
}
```

`retentionDays` and `maxWorktrees` apply only under `worktreeRoot`. The companion applies them when it starts and when you run `prune`: a `pr-<n>` directory older than `retentionDays` is deleted, then the oldest remaining directories are deleted until `maxWorktrees` are left. The matching `refs/pr-review/<n>` ref is deleted when the clone is known. Clones and `scanRoots` are left alone.

Your working tree and local branches are **never modified**. To apply that retention policy or uninstall the host:

```sh
npx quack-companion doctor      # Check config and local AI agent status
npx quack-companion prune       # Apply retentionDays and maxWorktrees under ~/.quack/worktrees
npx quack-companion uninstall   # Unregister browser manifests and remove ~/.quack/bin
```

---

## Local Development

Requires Node.js 22+ (the extension toolchain depends on it). The published companion still runs on Node.js 20+.

### Workspace Map

| Workspace | Path | Purpose |
| --- | --- | --- |
| `@quacksteps/extension` | `extension/` | WXT + React 19 + TypeScript Manifest V3 extension |
| `quack-companion` | `companion/` | Node.js native messaging host, bundled with esbuild |
| `@quacksteps/shared` | `shared/` | Wire protocol types, constants, and `quack-ci` parser |

### Commands (Yarn `1.22+`)

```sh
yarn install                                # Install workspace dependencies
yarn build                                  # Build companion + unpacked extension
yarn install-host                           # Register local companion from source
yarn dev                                    # Watch and rebuild extension on change
yarn workspace @quacksteps/extension preview     # Open standalone UI preview server
yarn test                                   # Run companion unit tests
yarn typecheck                              # Type-check all workspaces
```

To load your local build in Chrome, Edge, or Brave: open `chrome://extensions` (`brave://extensions` in Brave), enable **Developer mode**, click **Load unpacked**, and select `extension/.output/chrome-mv3` (uses `DEV_EXTENSION_ID`, requires `yarn install-host`).

## Further Reading

- **[Architecture](docs/architecture.md)** — Message protocol, worktree locking, agent adapters, and security boundaries.
- **[Release Guide & Privacy Policy](docs/release.md)** — CI/CD workflows, Trusted Publishing, Chrome Web Store reference, and privacy policy.
