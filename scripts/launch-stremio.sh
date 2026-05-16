#!/usr/bin/env bash
# Launch the full Stremio LAN Remote stack (shell + addon) and wait until
# the shell exits. Designed to be added to Steam as a Non-Steam Game so the
# user can launch from Gaming Mode.
#
# Lifecycle:
#   1. Kill any stale shell / streaming-server / addon processes.
#   2. Launch the addon in the background (logs to /tmp/stremio-lan-remote-addon.log).
#   3. Launch the shell in the foreground, blocking until it exits.
#   4. On shell exit, stop the addon.

set -u

REPO="$HOME/dev/stremio-lan-remote"
SHELL_BIN="$REPO/shell/target/release/stremio-linux-shell"
SERVER_JS="$REPO/shell/data/server.js"
ADDON_DIR="$REPO/addon"
ADDON_LOG="/tmp/stremio-lan-remote-addon.log"
SHELL_LOG="/tmp/stremio-lan-remote-shell.log"

# Cleanup any prior session.
pkill -9 -f 'stremio-linux-shell' 2>/dev/null || true
pkill -9 -f 'shell/data/server.js' 2>/dev/null || true
pkill -f 'addon/bin/start.js' 2>/dev/null || true
sleep 1

# Stock Stremio Flatpak holds port 11470 — kill it if present so our
# streaming-server can bind.
pkill -9 -f 'stremio-runtime' 2>/dev/null || true
sleep 1

# Addon (background).
distrobox-enter stremio-build -- bash -c "
  cd '$ADDON_DIR' && \
  STREAM_RESOLVER_URL=https://torrentio.strem.fun \
  SHELL_HOST=127.0.0.1:7001 \
  BIND=0.0.0.0:7000 \
  PUBLIC_HOST=steamdeck.tail4024ff.ts.net \
  nohup node bin/start.js >> '$ADDON_LOG' 2>&1 &
  disown
" &

# Discover the active session's XAUTHORITY at launch time.
XAUTH=$(ls -1 /run/user/1000/xauth_* 2>/dev/null | head -1 || true)
if [[ -z "${XAUTH:-}" ]]; then
  echo "no XAUTHORITY found at /run/user/1000/xauth_*, aborting" >&2
  exit 1
fi

cleanup() {
  pkill -f 'addon/bin/start.js' 2>/dev/null || true
}
trap cleanup EXIT

# Shell (foreground — blocks until it exits).
distrobox-enter stremio-build -- bash -c "
  cd '$REPO/shell' && \
  DISPLAY=:0 XAUTHORITY='$XAUTH' XDG_RUNTIME_DIR=/run/user/1000 \
  SERVER_PATH='$SERVER_JS' \
  RUST_LOG=info,lan_remote=info,server=info \
  exec '$SHELL_BIN' >> '$SHELL_LOG' 2>&1
"
