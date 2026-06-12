#!/bin/zsh
set -euo pipefail

REPO_DIR="/Users/baibairui/codexclaw/codex-gateway"
NODE_BIN="/Users/baibairui/.nvm/versions/node/v22.16.0/bin"

cd "$REPO_DIR"

export PATH="$NODE_BIN:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export CODEX_SANDBOX="full-auto"

exec "$NODE_BIN/npm" start
