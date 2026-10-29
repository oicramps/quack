# Quack

Ask Claude Code or Cursor about a pull request's code from the GitHub PR page, without stashing your work or checking the PR out.

A browser extension shows a panel in Chrome's side panel, next to the PR. A local companion, started by the browser on demand, fetches the PR into a separate git worktree at the PR's commit and runs your AI tool there, read-only. Your own checkout is never touched.

Status: **Spike**. The panel is intentionally unstyled; see `docs/spike-findings.md`.

## Layout

- `extension/`: WXT + React + TypeScript (Manifest V3, Chrome and Edge)
- `companion/`: Node native messaging host (bundled with esbuild)
- `shared/`: message protocol types and constants used by both

## Setup (about 5 minutes)

Requirements: macOS or Linux, Node 20+, git 2.30+, Chrome or Edge, and the Cursor CLI and/or Claude Code. `gh` is optional but recommended.

1. Install dependencies and build:

   ```sh
   npm install
   npm run build
   ```

2. Register the companion with Chrome, Edge and Chromium:

   ```sh
   npm run install-host
   ```

3. Load the extension: open `chrome://extensions` (or `edge://extensions`), turn on Developer mode, click **Load unpacked** and choose `extension/.output/chrome-mv3`. The extension ID must be `ikkjkdmcnmifldjmajjjgabanjomhikf`; the companion only accepts that ID.

4. Open any PR on github.com. The panel shows whether the companion is connected and which AI tools are ready, with the commands to fix anything missing.

For development, `npm run dev` rebuilds the extension on change (reload it in `chrome://extensions` afterwards).

## Using it

- Open the panel by clicking the Quack toolbar icon. It opens in Chrome's side panel and follows the active tab.
- Ask about the whole PR: type a question in the panel.
- Ask about specific code: select lines in the diff and press **Cmd/Ctrl+Shift+K** (opens the panel with the selection attached; change it in `chrome://extensions/shortcuts`), or click **Attach selection** in the panel.
- **Enter** sends, **Shift+Enter** adds a line, **Esc** stops a running answer.
- Follow-up questions continue the same agent session. Switching backend starts a new thread.

## Configuration

`~/.quack/config.json` is created on first run:

```json
{
  "scanRoots": ["~/Documents/Dev/Projects", "~/Projects", "~/Developer", "~/repos", "~/src", "~/code"],
  "repoPaths": { "owner/repo": "/path/to/clone" },
  "worktreeRoot": "~/.quack/worktrees",
  "retentionDays": 7,
  "maxWorktrees": 20
}
```

The companion finds your clone by matching its `origin` remote against the PR's repo, searching `scanRoots` two levels deep. Use `repoPaths` for clones elsewhere.

## What it changes in your clone

Only two things, both outside your working tree and branches:

- refs under `refs/pr-review/<n>` (the fetched PR heads)
- worktrees under `~/.quack/worktrees/<owner>/<repo>/pr-<n>`, detached at the PR commit

Remove them all with `npm run prune -w companion`.

## Companion commands

```sh
node companion/dist/quack-companion.cjs doctor     # config and backend readiness
node companion/dist/quack-companion.cjs prune      # remove worktrees and refs/pr-review refs
node companion/dist/quack-companion.cjs uninstall  # remove the browser registration

# Talk to the companion over native messaging without a browser:
node companion/scripts/harness.mjs status
node companion/scripts/harness.mjs ask --pr ProjetoParcas/mynah#14 --backend cursor --question "..."
```

Logs (no code, no prompts) are in `~/.quack/logs/companion.log`.

## Tests

```sh
npm test            # companion unit tests (framing, validation, parsers, cancel)
npm run typecheck
```
