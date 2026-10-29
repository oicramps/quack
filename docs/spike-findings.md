# Spike findings

Oct 29, 2026. Demo repo: `ProjetoParcas/mynah`, PR #14, on macOS with Node 25.9, git 2.50 and gh 2.92.

## Verified

| What | Result |
| --- | --- |
| Native messaging framing | Round-trips over stdio, including messages split across chunks (unit test and harness). |
| Host registration | `npm run install-host` writes the launcher and manifests for Chrome, Edge and Chromium. |
| Minimal browser environment | The installed launcher, run with launchd's `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, still finds node, git, gh and `cursor-agent` (in `~/.local/bin`). |
| Caller check | Only `chrome-extension://ikkjkdmcnmifldjmajjjgabanjomhikf/` is accepted; anything else exits. |
| Repo discovery | mynah found by its `origin` URL in about 90 ms by scanning `~/Documents/Dev/Projects`. |
| PR resolution | `gh pr view` gives head, base, title and body; fetch plus resolve takes about 2 s (network). |
| Worktree | Created in 180 ms, reused in 84 ms (target under 10 s). |
| First progress update | About 50 ms after the question (target under 1 s). |
| Isolation | After the test, the mynah checkout had the same branch (`cursor/local-release-apk`), the same HEAD and `git status`, and no new stash. The only additions were `refs/pr-review/14` and the worktree in `~/.quack/worktrees`. |
| Error states | `backend_not_logged_in` (Cursor) and `repo_not_found` return the right codes with fix steps; `backend_not_installed` for Claude Code reports install and login commands. |
| Input validation | Hostile owner, repo, PR number, SHA, branch, model, session ID and file paths are rejected before any git or agent call. This caught a real bug: a model of `--force` used to pass. |
| Stop | Aborting kills the agent's process group and the stream ends cleanly (test with a fake agent). |

## Found during the Spike

- **The installed Cursor CLI is old** (`2025.08.15`). It has no `--stream-partial-output` and no `--list-models`. The adapter reads `--help` and adapts: it streams whole messages instead of deltas and offers a fallback model list, and the panel shows a hint to run `cursor-agent update`. Newer CLIs also get `--mode ask` (read-only) and `--trust` when their help lists them.
- **The Cursor CLI was not logged in** on this machine (`cursor-agent status` says "Not logged in"), so the panel shows the "Not logged in" state with `cursor-agent login`.
- **Claude Code is not installed**, so it shows "Not installed" with the install and login steps, as planned.
- **Login detection for Claude Code** has no single documented command. The adapter tries `claude auth status`, then the macOS keychain item `Claude Code-credentials`, then `~/.claude/.credentials.json`. Verify once Claude is installed.
- **Plan mode answers**: in `--permission-mode plan`, Claude may put its answer in an `ExitPlanMode` tool call. The parser shows that plan as answer text.
- **Keyboard isolation**: GitHub's single-key shortcuts would fire while typing in the panel; the Shadow DOM UI isolates key events.

## Still to run (needs you in the browser)

Prerequisites: `cursor-agent login` (and optionally `cursor-agent update`), then load the extension as described in the README.

1. **Cursor** on PR #14: select lines in a changed file, press Cmd/Ctrl+Shift+K, ask "Do we already have something that does this?", ask a follow-up, then press Stop during a third question.
   - Record real output: `QUACK_RECORD=1 node companion/scripts/harness.mjs ask --pr ProjetoParcas/mynah#14 --backend cursor --question "..."`, then compare with `companion/test/fixtures/cursor-documented.jsonl`.
2. **Claude Code not ready**: open the backend picker. Claude Code shows "Not installed" with its install command. Follow the steps, press Recheck, and confirm it moves to "Not logged in" and then "Ready".
3. **Claude Code**: switch to it (a new thread starts) and repeat step 1.
4. **Isolation check**: in `~/Documents/Dev/Projects/mynah`, confirm the branch, `git status` and `git stash list` are unchanged.

## Open questions

| Question | Status |
| --- | --- |
| What does each CLI's stream-json actually contain? | Parsers are built from the documented formats (`companion/test/fixtures/*-documented.jsonl`). Replace them with recordings from step 1. |
| Can a resumed session change model? | Not yet tested. The panel currently allows changing the model mid-thread; if resume ignores or rejects it, model changes should start a new thread. |
| Does Cursor print mode without `--force` ever write files? | Detected either way: after each answer the companion checks `git status` in the worktree and shows a warning if the agent changed anything (the worktree is reset before its next use). Record the result from step 1. |
| Does native messaging launch reliably from Chrome and Edge? | Manifests are installed for both; launch from the real browsers still needs testing in step 1. |
| Do the diff selectors match GitHub's current diff UI? | Not yet checked on a live page. Path and line reading try several attributes; the selected text is always attached, so the agent gets the code even if line numbers can't be read. |

## Go/no-go

The local half (companion, worktrees, isolation, errors) works and is fast. Decide go or no-go for MVP after steps 1 to 4, mainly on answer quality and whether the stream formats hold up.
