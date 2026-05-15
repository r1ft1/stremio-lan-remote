#!/usr/bin/env bash
# Launch the stremio-linux-shell fork on the SteamDeck inside the stremio-build distrobox.
# Discovers the current XAUTHORITY file at runtime so it survives a logout/login.

set -eu

REPO="$HOME/dev/stremio-lan-remote"
SHELL_BIN="$REPO/shell/target/release/stremio-linux-shell"
SERVER_JS="$REPO/shell/data/server.js"
LOG="/tmp/stremio-lan-remote-shell.log"

XAUTH=$(ls -1 /run/user/1000/xauth_* 2>/dev/null | head -1 || true)
if [[ -z "${XAUTH:-}" ]]; then
  echo "no XAUTHORITY found at /run/user/1000/xauth_*, aborting" >&2
  exit 1
fi

exec distrobox-enter stremio-build -- bash -c "
  cd '$REPO/shell' && \
  DISPLAY=:0 XAUTHORITY='$XAUTH' XDG_RUNTIME_DIR=/run/user/1000 \
  SERVER_PATH='$SERVER_JS' \
  RUST_LOG=info,lan_remote=info,server=info \
  exec '$SHELL_BIN' >> '$LOG' 2>&1
"
