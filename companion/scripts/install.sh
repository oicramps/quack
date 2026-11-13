#!/bin/sh
# Downloads the Quack companion from GitHub Releases and registers its native
# messaging host for Chrome, Edge, Brave, and Chromium. No npm registry or repo clone
# required — only Node 20+ and curl.
set -eu

REPO="${QUACK_REPO:-__COMPANION_REPO__}"
VERSION="${QUACK_VERSION:-latest}"

if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js 20+ is required, but 'node' was not found on PATH." >&2
  exit 1
fi

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "Error: Node.js 20+ is required (found $(node -v))." >&2
  exit 1
fi

if [ "$VERSION" = "latest" ]; then
  BASE="https://github.com/${REPO}/releases/latest/download"
else
  BASE="https://github.com/${REPO}/releases/download/${VERSION}"
fi

TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/quack-install.XXXXXX")
trap 'rm -rf "$TMP_DIR"' EXIT INT TERM

BUNDLE="${TMP_DIR}/quack-companion.cjs"
echo "Downloading Quack companion from ${BASE}/quack-companion.cjs..."
curl -fsSL "${BASE}/quack-companion.cjs" -o "$BUNDLE"

if command -v shasum >/dev/null 2>&1; then
  SHA256="shasum -a 256"
elif command -v sha256sum >/dev/null 2>&1; then
  SHA256="sha256sum"
else
  echo "Error: shasum or sha256sum is required to verify the download." >&2
  exit 1
fi

curl -fsSL "${BASE}/quack-companion.cjs.sha256" -o "${BUNDLE}.sha256"
EXPECTED=$(awk '{print $1}' "${BUNDLE}.sha256")
ACTUAL=$($SHA256 "$BUNDLE" | awk '{print $1}')
if [ "$EXPECTED" != "$ACTUAL" ]; then
  echo "Error: SHA-256 checksum mismatch for quack-companion.cjs." >&2
  exit 1
fi

node "$BUNDLE" install
