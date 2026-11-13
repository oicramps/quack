# quack-companion

Local native messaging host for **[Quack](https://chromewebstore.google.com/detail/quack/hkdgklakkcffcmegdagdoigpaefhlipj)** — the Chrome and Edge extension that runs your local **Claude Code** or **Cursor** CLI against a GitHub pull request in an isolated git worktree, without stashing local work or switching branches.

- **Chrome Web Store**: [Install Quack](https://chromewebstore.google.com/detail/quack/hkdgklakkcffcmegdagdoigpaefhlipj)
- **Repository & Architecture**: [github.com/oicramps/quack](https://github.com/oicramps/quack)

## Installation

1. Install the **[Quack browser extension](https://chromewebstore.google.com/detail/quack/hkdgklakkcffcmegdagdoigpaefhlipj)**.
2. Register the local native messaging host for Chrome, Edge, and Chromium:

```sh
npx quack-companion@latest install
```

*(Alternative installers: `yarn dlx quack-companion@latest install`, or without a package manager via `curl -fsSL https://github.com/oicramps/quack/releases/latest/download/install.sh | sh`.)*

3. Restart your browser once after initial installation and open any pull request on `github.com`.

## Requirements

- **OS**: macOS or Linux
- **Runtime**: Node.js `>= 20`, `git >= 2.30`
- **Local clone**: A local git clone of the repository being reviewed
- **AI CLI**: At least one installed and authenticated locally:
  - [Cursor CLI](https://cursor.com) (`agent` / `cursor-agent`)
  - [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (`claude`)
- **Optional**: [GitHub CLI](https://cli.github.com/) (`gh`), authenticated, to enable **Check CI** (failed job log collection and base-branch flake comparison)

## How It Works

Browser extensions cannot invoke `git` or local CLI binaries directly. `quack-companion` connects the Quack side panel to your local environment over Chrome [Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging) (`stdio`):

1. **On-demand lifecycle**: Chrome spawns `quack-companion` automatically when the Quack side panel opens on a PR and terminates it when the panel closes. No background daemon or open terminal is required.
2. **Clone discovery**: Matches `git remote get-url origin` against the PR's `owner/repo`, scanning configured project roots up to two directory levels deep.
3. **Detached worktree isolation**: Fetches `+pull/<number>/head:refs/pr-review/<number>` and checks out a detached worktree at `~/.quack/worktrees/<owner>/<repo>/pr-<number>`. Your working tree, index, and local branches are never modified.
4. **Read-only agent execution**: Runs Cursor (`acp` in `ask` mode with write/terminal capabilities disabled) or Claude Code (`--permission-mode plan`) inside the worktree and streams responses back to the side panel.
5. **Local-only**: Quack runs no servers, requires no account, and collects no telemetry.

## CLI Commands

The installer writes a launcher to `~/.quack/bin/quack-companion` pinned to your Node binary. Commands can be run via `~/.quack/bin/quack-companion` or `npx quack-companion`:

```sh
npx quack-companion install     # Register or update native messaging host manifests
npx quack-companion doctor      # Print configuration and local agent status
npx quack-companion prune       # Remove all ~/.quack/worktrees and refs/pr-review/* refs
npx quack-companion uninstall   # Remove native messaging manifests and ~/.quack/bin
npx quack-companion --version   # Print version
```

## Configuration

Created on first run at `~/.quack/config.json`:

```json
{
  "scanRoots": ["~/Documents/Dev/Projects", "~/Projects", "~/Developer", "~/repos", "~/src", "~/code"],
  "repoPaths": { "owner/repo": "/path/to/clone" },
  "worktreeRoot": "~/.quack/worktrees",
  "retentionDays": 7,
  "maxWorktrees": 20
}
```

Diagnostic logs (timings and errors only; never source code or prompts) are written to `~/.quack/logs/companion.log`.

## License

MIT
