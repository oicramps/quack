# Releasing Quack

Quack ships two artifacts that release together from `QUACK_VERSION` (`shared/src/constants.ts`):

- **Browser extension (`@quack/extension`)**: Published to the Chrome Web Store (`hkdgklakkcffcmegdagdoigpaefhlipj`) and optionally Edge Add-ons.
- **Local companion (`quack-companion`)**: Packaged with `yarn pack` and published to the npm registry via GitHub OIDC Trusted Publishing (`npx quack-companion@latest install`), plus attached to GitHub Releases (`install.sh`, `quack-companion.cjs`, `quack-companion.cjs.sha256`, `quack-companion.tgz`).

`PROTOCOL_VERSION` is incremented only on breaking wire-protocol changes; the side panel prompts the user to reinstall the companion only when `PROTOCOL_VERSION` differs.

## Automated CI & Release Workflows

- **`.github/workflows/ci.yml`**: Runs on every pull request and push to `main` (`yarn install --frozen-lockfile`, `yarn test`, `yarn typecheck`, companion build, and store zip build).
- **`.github/workflows/release.yml`**: Runs on pushes/merges to `main`, `v*` tags, and manual `workflow_dispatch`.
  - Reads `QUACK_VERSION` from `shared/src/constants.ts`.
  - If GitHub Release `v<QUACK_VERSION>` already exists, exits cleanly.
  - Otherwise syncs workspace `package.json` versions, runs tests and typecheck, creates and pushes tag `v<QUACK_VERSION>`, publishes the GitHub Release, publishes `quack-companion` via OIDC Trusted Publishing (zero npm secrets stored on GitHub), and submits the Chrome/Edge `.zip` archives via `yarn wxt submit`.

### Trusted Publishing Setup (`quack-companion`)

1. Publish the initial version once locally so the package page exists on `npmjs.com`:
   ```sh
   yarn workspace quack-companion build
   yarn --cwd companion publish --access public --new-version 0.2.0 --no-git-tag-version
   ```
2. On `https://www.npmjs.com/package/quack-companion/access`, under **Trusted Publisher**, select **GitHub Actions**:
   - **Organization or user**: `oicramps`
   - **Repository**: `quack`
   - **Workflow filename**: `release.yml`
   - **Environment name**: *(leave blank)*

### Required GitHub Actions Secrets

Configure under **Settings -> Secrets and variables -> Actions** (no `NPM_TOKEN` needed):

| Secret | Source |
| --- | --- |
| `CHROME_EXTENSION_ID` | Chrome Web Store item ID (`hkdgklakkcffcmegdagdoigpaefhlipj`) |
| `CHROME_CLIENT_ID` | Google Cloud Console OAuth 2.0 Web Application Client ID |
| `CHROME_CLIENT_SECRET` | Google Cloud Console OAuth 2.0 Client Secret |
| `CHROME_REFRESH_TOKEN` | Refresh token generated via Google OAuth 2.0 Playground (`https://www.googleapis.com/auth/chromewebstore`) |

Optional Edge Add-ons secrets: `EDGE_PRODUCT_ID`, `EDGE_CLIENT_ID`, `EDGE_API_KEY`.

## First Store Upload

1. Build the store zip (`QUACK_STORE=1` omits the development `key` from `manifest.json` and outputs to `extension/.output/store/`):

   ```sh
   yarn workspace @quack/extension zip
   ```

   (`yarn dev` and `yarn build` retain `key` and write to `extension/.output/`, keeping the unpacked development ID `ikkjkdmcnmifldjmajjjgabanjomhikf`.)
2. Upload `extension/.output/store/quackextension-<version>-chrome.zip` manually once in the Chrome Web Store Developer Dashboard, complete the Store Listing, Privacy Practices, and Distribution tabs, and submit for review.
3. Ensure `STORE_EXTENSION_ID` in `shared/src/constants.ts` matches the assigned store ID so `quack-companion` includes it in `allowed_origins`.

## Store Listing Reference

### Single Purpose Description

> Quack lets you ask your own local AI agent about the code in a GitHub pull request you already have open, without checking that pull request out.

### Permissions

| Permission | Justification |
| --- | --- |
| `nativeMessaging` | Communicates with the local companion process (`quack-companion`) that runs the user's installed AI CLI. |
| `sidePanel` | Displays the Quack UI in the browser's side panel next to the pull request. |
| `storage` | Stores selected agent/model preferences and recently queried pull requests locally in `chrome.storage.local`. |
| `https://github.com/*` | Reads PR metadata and selected diff lines from the active GitHub tab and renders the in-page Ask Quack button. |

### Assets

- Icon: `extension/public/icon/128.png` (generated from `extension/assets/icon.svg` via `yarn workspace @quack/extension icons`).
- Screenshots: `1280x800` PNGs in `extension/.output/store/screenshots/` (captured from `yarn workspace @quack/extension preview`).

## Privacy Policy

Link `https://github.com/oicramps/quack/blob/main/docs/release.md` in the Chrome Web Store dashboard:

Quack is a browser extension and an open-source local companion program (`quack-companion`) that run on your computer.

- **Data read by the extension**: Activates only on `github.com` pull request pages. Reads the open pull request's repository owner/name, pull request number, title, commit SHA, and diff lines you select. Stores your chosen AI agent, model preference, and recently queried pull requests locally on your device (`chrome.storage.local`).
- **Local processing**: The companion runs locally on your machine using your local git clone and, when inspecting failing checks, your authenticated GitHub CLI (`gh`). It invokes the local AI CLI you selected (Cursor or Claude Code) with your question and repository context. Subsequent handling of that data is governed by the AI tool and account you configured.
- **No servers or telemetry**: Quack operates no servers, requires no Quack account, collects no telemetry or analytics, and does not sell, transmit, or share user data.
- **Removal**: Uninstalling the extension deletes its browser storage. Running `npx quack-companion uninstall` removes the native messaging registration and `~/.quack/bin`, and `npx quack-companion prune` removes local review worktrees under `~/.quack/worktrees`.
