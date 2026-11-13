# Quack

Ask Claude Code or Cursor about a GitHub pull request directly from the PR page, without stashing local work or switching branches.

A Manifest V3 browser extension renders a side panel next to the PR. A local native messaging host (`quack-companion`), spawned on demand by the browser, fetches the PR head into an isolated git worktree and runs the selected AI CLI in read-only mode. The working tree and branches of your local clone are never modified.

## Workspace Layout

- `extension/`: WXT + React + TypeScript browser extension (Chrome and Edge Manifest V3)
- `companion/`: Node.js native messaging host, bundled into a single CJS executable with esbuild
- `shared/`: Protocol types, CI report parser, and constants shared by `extension` and `companion`
- `docs/architecture.md`: Technical architecture, protocol flow, worktree isolation, and security model
- `docs/release.md`: Release pipeline for GitHub Releases, Chrome Web Store, and Edge Add-ons

## Setup

Requirements: macOS or Linux, Node.js 20+, Yarn 1.22+, git 2.30+, Chrome or Edge, and Cursor CLI (`cursor-agent`) and/or Claude Code (`claude`). GitHub CLI (`gh`) is optional and used for PR metadata and failing CI logs.

1. Install dependencies and build both packages:

   ```sh
   yarn install
   yarn build
   ```

2. Register the native messaging host for Chrome, Edge, and Chromium:

   ```sh
   yarn install-host
   ```

   End users installing from the Chrome Web Store can register the prebuilt companion without cloning the repository:

   ```sh
   npx quack-companion@latest install
   ```

   *(Or without npm: `curl -fsSL https://github.com/oicramps/quack/releases/latest/download/install.sh | sh`, which downloads `quack-companion.cjs` from the latest GitHub Release, verifies its SHA-256 checksum, installs it to `~/.quack/bin`, and writes the native messaging host manifests.)*

3. Load the unpacked extension: open `chrome://extensions` (or `edge://extensions`), enable **Developer mode**, click **Load unpacked**, and select `extension/.output/chrome-mv3`. Development builds include `EXTENSION_PUBLIC_KEY` so the unpacked extension ID is fixed to `ikkjkdmcnmifldjmajjjgabanjomhikf`.

4. Open any pull request on `github.com`. Click the Quack toolbar icon to open the side panel.

For active development, run `yarn dev` to watch and rebuild the extension.

## Usage

- **Whole-PR questions**: Open the side panel and type a question.
- **Line selections**: Select code in the PR diff or click line numbers (Shift-click for a range), then press **Cmd/Ctrl+Shift+K** or click the floating **Ask Quack** button.
- **Failing CI analysis**: When checks fail on the PR and `gh` is authenticated, click **Check CI** in the empty state to inspect failed job logs and compare against recent base-branch runs.
- **Keyboard shortcuts**: **Enter** sends, **Shift+Enter** inserts a newline, **Esc** cancels an in-flight request.
- **Multi-turn & agent switching**: Follow-up questions reuse the active agent session. Switching agents mid-thread passes prior turns as conversation context to the new agent.

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

The companion locates local clones by matching each repository's `origin` remote URL against the PR's `owner/repo`, scanning `scanRoots` up to two directory levels deep. Explicit paths in `repoPaths` take precedence.

## Repository Isolation

The companion only writes to two locations outside your working tree and branches:

- `refs/pr-review/<number>` in the local clone's git object store
- Detached worktrees under `~/.quack/worktrees/<owner>/<repo>/pr-<number>`

Remove all Quack worktrees and `refs/pr-review/*` refs at any time:

```sh
yarn workspace quack-companion prune
```

## Companion CLI & Debugging

```sh
node companion/dist/quack-companion.cjs doctor     # Print config and agent availability
node companion/dist/quack-companion.cjs prune      # Remove all Quack worktrees and refs/pr-review/* refs
node companion/dist/quack-companion.cjs uninstall  # Remove native messaging manifests and ~/.quack/bin

# Exercise the native messaging host directly over stdio without a browser:
node companion/scripts/harness.mjs status
node companion/scripts/harness.mjs ask --pr owner/repo#14 --agent cursor --question "..."

# Record raw agent stream output to ~/.quack/recordings/ for parser test fixtures:
QUACK_RECORD=1 node companion/scripts/harness.mjs ask --pr owner/repo#14 --agent claude-code --question "..."
```

Diagnostic logs (containing timing and errors, never code or prompts) are written to `~/.quack/logs/companion.log`.

## Testing & Verification

```sh
yarn test       # Run companion unit tests (framing, validation, parsers, stream lifecycle, CI checks)
yarn typecheck  # Type-check companion and extension workspaces
```
