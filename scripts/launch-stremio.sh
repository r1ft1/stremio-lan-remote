#!/usr/bin/env bash
# Launch the full Stremio LAN Remote stack (shell + addon) and wait until
# the shell exits. Designed to be added to Steam as a Non-Steam Game, also
# launchable from KDE app menu (Desktop Mode) or directly from a terminal.
#
# Lifecycle:
#   1. Kill any stale shell / streaming-server / addon processes.
#   2. Launch the addon in the background.
#   3. Launch the shell in the foreground, blocking until it exits.
#   4. On shell exit, stop the addon.

set -u

REPO="$HOME/dev/stremio-lan-remote"
SHELL_BIN="$REPO/shell/target/release/stremio-linux-shell"
SERVER_JS="$REPO/shell/data/server.js"
ADDON_DIR="$REPO/addon"
ADDON_LOG="/tmp/stremio-lan-remote-addon.log"
SHELL_LOG="/tmp/stremio-lan-remote-shell.log"
LAUNCHER_LOG="/tmp/stremio-lan-remote-launcher.log"

exec >>"$LAUNCHER_LOG" 2>&1
echo "=== launcher start $(date -Iseconds) ==="
echo "DISPLAY=${DISPLAY:-} WAYLAND_DISPLAY=${WAYLAND_DISPLAY:-} XDG_SESSION_TYPE=${XDG_SESSION_TYPE:-}"
echo "XAUTHORITY=${XAUTHORITY:-} XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-}"

# --- Cleanup ----------------------------------------------------------------
pkill -9 -f 'stremio-linux-shell' 2>/dev/null || true
pkill -9 -f 'shell/data/server.js' 2>/dev/null || true
pkill -f 'addon/bin/start.js' 2>/dev/null || true
# Stock Stremio Flatpak holds port 11470 — kill it if present.
pkill -9 -f 'stremio-runtime' 2>/dev/null || true
sleep 1

# Free port 11470 / 12470 of any leftover node process.
for port in 11470 12470; do
  pids=$(ss -tlnpH "sport = :$port" 2>/dev/null | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u)
  if [[ -n "$pids" ]]; then
    echo "freeing port $port from pids: $pids"
    kill -9 $pids 2>/dev/null || true
  fi
done
sleep 1

# --- Env discovery ----------------------------------------------------------
# When launched from Steam Gaming Mode or the KDE app menu the graphical env
# is already exported by the parent. When launched from ssh, we need to
# discover it.

: "${XDG_RUNTIME_DIR:=/run/user/$(id -u)}"
export XDG_RUNTIME_DIR

if [[ -z "${DISPLAY:-}" && -z "${WAYLAND_DISPLAY:-}" ]]; then
  # No graphical env — try to discover one from a recent xauth_* or
  # fall back to :0.
  XAUTH_FROM_DISK=$(ls -1t /run/user/$(id -u)/xauth_* 2>/dev/null | head -1 || true)
  if [[ -n "$XAUTH_FROM_DISK" ]]; then
    export XAUTHORITY="$XAUTH_FROM_DISK"
  fi
  export DISPLAY="${DISPLAY:-:0}"
  echo "no graphical env from parent; using DISPLAY=$DISPLAY XAUTHORITY=${XAUTHORITY:-unset}"
fi

# --- Addon (background) -----------------------------------------------------
distrobox-enter stremio-build -- bash -c "
  cd '$ADDON_DIR' && \
  STREAM_RESOLVER_URL=https://torrentio.strem.fun \
  SHELL_HOST=127.0.0.1:7001 \
  BIND=0.0.0.0:7000 \
  PUBLIC_HOST=steamdeck.tail4024ff.ts.net \
  nohup node bin/start.js >> '$ADDON_LOG' 2>&1 &
  disown
" &

cleanup() {
  echo "=== launcher cleanup $(date -Iseconds) ==="
  pkill -f 'addon/bin/start.js' 2>/dev/null || true
}
trap cleanup EXIT

# --- Shell (foreground) -----------------------------------------------------
# Pass DISPLAY / XAUTHORITY / WAYLAND_DISPLAY through to distrobox.
distrobox-enter stremio-build -- bash -c "
  cd '$REPO/shell' && \
  DISPLAY='${DISPLAY:-}' \
  WAYLAND_DISPLAY='${WAYLAND_DISPLAY:-}' \
  XAUTHORITY='${XAUTHORITY:-}' \
  XDG_RUNTIME_DIR='$XDG_RUNTIME_DIR' \
  XDG_SESSION_TYPE='${XDG_SESSION_TYPE:-}' \
  SERVER_PATH='$SERVER_JS' \
  RUST_LOG=info,lan_remote=info,server=info \
  exec '$SHELL_BIN' >> '$SHELL_LOG' 2>&1
"
echo "=== launcher done $(date -Iseconds) ==="
