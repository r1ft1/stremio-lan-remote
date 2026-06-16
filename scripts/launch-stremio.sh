#!/usr/bin/env bash
# Launch the full Stremio LAN Remote stack (shell + addon) and wait until
# the shell exits. Designed for Steam (Non-Steam Game), KDE app menu, or
# a terminal.

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

# Strip Steam's LD_PRELOAD shim — it injects gameoverlayrenderer.so which
# is harmless but logs noise + can interfere with podman/distrobox in
# edge cases.
unset LD_PRELOAD

# --- Cleanup ----------------------------------------------------------------
pkill -9 -f 'stremio-linux-shell' 2>/dev/null || true
pkill -9 -f 'shell/data/server.js' 2>/dev/null || true
pkill -f 'addon/bin/start.js' 2>/dev/null || true
pkill -9 -f 'stremio-runtime' 2>/dev/null || true
sleep 1

for port in 11470 12470; do
  pids=$(ss -tlnpH "sport = :$port" 2>/dev/null | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u)
  if [[ -n "$pids" ]]; then
    echo "freeing port $port from pids: $pids"
    kill -9 $pids 2>/dev/null || true
  fi
done
sleep 1

# --- Ensure distrobox container is healthy ----------------------------------
# A previous shell-crash + reboot can leave the container's fuse-overlayfs
# in a "transport endpoint not connected" state; a restart fixes it.
if ! distrobox-enter stremio-build -- true 2>/dev/null; then
  echo "stremio-build container unhealthy, restarting..."
  podman restart stremio-build >/dev/null 2>&1 || podman start stremio-build >/dev/null 2>&1 || true
  sleep 3
fi

# --- Env discovery ----------------------------------------------------------
# Steam launches this shortcut WITHOUT exporting XAUTHORITY (and often
# WAYLAND_DISPLAY) into the child env, and the X display can renumber across a
# suspend/resume (e.g. :0 -> :1). The old "only fall back when BOTH DISPLAY and
# WAYLAND_DISPLAY are empty" guard then left XAUTHORITY unset while DISPLAY was
# set, so the shell couldn't authenticate to X and died before binding :7001.
# Fix: borrow the live graphical env straight from the running Steam process's
# /proc/<pid>/environ (same approach as launch-shell.sh); fall back to an
# xauth_* file on disk. A value already validly set in our own env wins.
: "${XDG_RUNTIME_DIR:=/run/user/$(id -u)}"
export XDG_RUNTIME_DIR

SPID=$(pgrep -f 'ubuntu12_32/steam' | head -1 || true)
g() {
  [ -n "${SPID:-}" ] || return 0
  tr '\0' '\n' < "/proc/$SPID/environ" 2>/dev/null | grep "^$1=" | head -1 | cut -d= -f2- || true
}
export DISPLAY="${DISPLAY:-$(g DISPLAY)}"; export DISPLAY="${DISPLAY:-:0}"
export WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-$(g WAYLAND_DISPLAY)}"
export XAUTHORITY="${XAUTHORITY:-$(g XAUTHORITY)}"
if [[ -z "${XAUTHORITY:-}" ]]; then
  export XAUTHORITY="$(ls -1t /run/user/$(id -u)/xauth_* 2>/dev/null | head -1 || true)"
fi
echo "env after borrow (steam pid=${SPID:-none}): DISPLAY=${DISPLAY:-} WAYLAND_DISPLAY=${WAYLAND_DISPLAY:-} XAUTHORITY=${XAUTHORITY:-unset}"

# --- Background BitTorrent DHT warmup ----------------------------------------
# First cast after a Deck reboot stalls for 1-2min because streaming-server's
# DHT routing table is empty and torrent peer handshakes are mostly NATs that
# don't respond. Pre-warm by re-requesting the most recent previously-downloaded
# infoHash 15s after launch — by the time the user reaches for the phone, the
# swarm is already populated.
(
  sleep 15
  DLF="$HOME/stremio-downloads/.downloads.json"
  if [[ -r "$DLF" ]]; then
    IH=$(grep -oE '[0-9a-f]{40}' "$DLF" | head -1)
    if [[ -n "$IH" ]]; then
      curl -s --max-time 5 -o /dev/null "http://127.0.0.1:11470/$IH/0" || true
      echo "[warmup $(date -Iseconds)] pinged $IH" >> "$LAUNCHER_LOG"
    else
      echo "[warmup $(date -Iseconds)] no infoHash in $DLF" >> "$LAUNCHER_LOG"
    fi
  else
    echo "[warmup $(date -Iseconds)] no $DLF yet" >> "$LAUNCHER_LOG"
  fi
) >/dev/null 2>&1 &
disown

# --- Run both addon + shell from a SINGLE distrobox-enter session ----------
# Multiple parallel distrobox-enter calls have been observed to race against
# the container's overlay setup. A single session avoids that.
exec distrobox-enter stremio-build -- bash -c "
  cd '$ADDON_DIR' && \
  STREAM_RESOLVER_URL=https://torrentio.strem.fun \
  SHELL_HOST=127.0.0.1:7001 \
  BIND=0.0.0.0:7000 \
  PUBLIC_HOST=steamdeck.REDACTED.ts.net \
  nohup node bin/start.js >> '$ADDON_LOG' 2>&1 &
  ADDON_PID=\$!

  cleanup() {
    kill \$ADDON_PID 2>/dev/null || true
  }
  trap cleanup EXIT

  cd '$REPO/shell' && \
  DISPLAY='${DISPLAY:-}' \
  WAYLAND_DISPLAY='${WAYLAND_DISPLAY:-}' \
  XAUTHORITY='${XAUTHORITY:-}' \
  XDG_RUNTIME_DIR='$XDG_RUNTIME_DIR' \
  XDG_SESSION_TYPE='${XDG_SESSION_TYPE:-}' \
  SERVER_PATH='$SERVER_JS' \
  RUST_LOG=info,lan_remote=info,server=info \
  '$SHELL_BIN' >> '$SHELL_LOG' 2>&1
"
