#!/usr/bin/env bash
# Launch the stremio-linux-shell fork inside the stremio-build distrobox.
#
# Borrows the live graphical env (DISPLAY / WAYLAND_DISPLAY / XAUTHORITY) from the
# running Steam/gamescope session, so it works whether or not an xauth_* file
# exists on disk (this gamescope session exposes DISPLAY but no xauth_* file).
# Also ensures the distrobox container is up first — a crash or suspend/resume can
# leave it stopped, which otherwise makes every (re)launch fail.
#
# Used by the watchdog timer to relaunch a dead shell.

set -u

REPO="$HOME/dev/stremio-lan-remote"
SHELL_BIN="$REPO/shell/target/release/stremio-linux-shell"
SERVER_JS="$REPO/shell/data/server.js"
LOG="/tmp/stremio-lan-remote-shell.log"

# --- Ensure the build container is healthy ----------------------------------
if ! distrobox-enter stremio-build -- true 2>/dev/null; then
  echo "stremio-build container unhealthy, restarting..." >&2
  podman restart stremio-build >/dev/null 2>&1 || podman start stremio-build >/dev/null 2>&1 || true
  sleep 3
fi

# --- Borrow the graphical env from the running Steam/gamescope session -------
SPID=$(pgrep -f 'ubuntu12_32/steam' | head -1 || true)
g() {
  [ -n "${SPID:-}" ] || return 0
  tr '\0' '\n' < "/proc/$SPID/environ" 2>/dev/null | grep "^$1=" | head -1 | cut -d= -f2- || true
}
DISPLAY_V="$(g DISPLAY)";  DISPLAY_V="${DISPLAY_V:-:0}"
WAYLAND_V="$(g WAYLAND_DISPLAY)"
XAUTH_V="$(g XAUTHORITY)"
# Fall back to an xauth_* file only if the session didn't export one.
if [ -z "${XAUTH_V:-}" ]; then
  XAUTH_V="$(ls -1t /run/user/1000/xauth_* 2>/dev/null | head -1 || true)"
fi

echo "launch-shell: DISPLAY=$DISPLAY_V WAYLAND_DISPLAY=$WAYLAND_V XAUTHORITY=${XAUTH_V:-unset}" >&2

exec distrobox-enter stremio-build -- bash -c "
  cd '$REPO/shell' && \
  DISPLAY='$DISPLAY_V' \
  WAYLAND_DISPLAY='$WAYLAND_V' \
  XAUTHORITY='$XAUTH_V' \
  XDG_RUNTIME_DIR=/run/user/1000 \
  XDG_SESSION_TYPE=x11 \
  SERVER_PATH='$SERVER_JS' \
  RUST_LOG=info,lan_remote=info,server=info \
  exec '$SHELL_BIN' >> '$LOG' 2>&1
"
