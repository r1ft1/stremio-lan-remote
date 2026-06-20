#!/usr/bin/env bash
# Run the Stremio LAN Remote addon (port 7000) inside the stremio-build distrobox.
#
# This is the SINGLE source of truth for starting the addon. It is invoked by the
# systemd --user service `stremio-lan-remote-addon.service` (at boot, via linger,
# and on crash-restart). launch-stremio.sh starts that service rather than
# spawning its own addon, so there is exactly one addon instance — no port-7000
# conflicts.
#
# Env knobs (all optional, sensible LAN defaults):
#   PUBLIC_HOST  host the addon advertises in cast links (default LAN mDNS name)
#   STREAM_RESOLVER_URL  Torrentio-compatible resolver
#   DECK_TOKEN   shared secret; if set, control/PWA routes require it

set -u

REPO="$HOME/dev/stremio-lan-remote"
ADDON_DIR="$REPO/addon"
LOG="/tmp/stremio-lan-remote-addon.log"

PUBLIC_HOST="${PUBLIC_HOST:-http://steamdeck.local:7000}"
STREAM_RESOLVER_URL="${STREAM_RESOLVER_URL:-https://torrentio.strem.fun}"

# Shared secret (optional). Read from the token file if present; never committed.
TOKEN_FILE="$HOME/.config/stremio-lan-remote/token"
DECK_TOKEN="${DECK_TOKEN:-$(cat "$TOKEN_FILE" 2>/dev/null || true)}"

# Ensure the build container is up (a suspend/resume or crash can stop it).
if ! distrobox-enter stremio-build -- true 2>/dev/null; then
  echo "$(date -Iseconds) stremio-build container unhealthy, restarting" >> "$LOG"
  podman restart stremio-build >/dev/null 2>&1 || podman start stremio-build >/dev/null 2>&1 || true
  sleep 3
fi

exec distrobox-enter stremio-build -- bash -lc "
  cd '$ADDON_DIR' && \
  STREAM_RESOLVER_URL='$STREAM_RESOLVER_URL' \
  SHELL_HOST=127.0.0.1:7001 \
  BIND=0.0.0.0:7000 \
  PUBLIC_HOST='$PUBLIC_HOST' \
  DECK_TOKEN='$DECK_TOKEN' \
  exec node bin/start.js >> '$LOG' 2>&1
"
