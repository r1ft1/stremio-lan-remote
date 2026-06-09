#!/usr/bin/env bash
# Stremio LAN Remote shell watchdog.
# Pings the LAN remote /state endpoint. If it doesn't respond within 5s for
# two consecutive checks, force-kills the shell and relaunches it.
#
# Designed to run from a systemd user timer firing every 15s.
# State (consecutive failure count) is kept in a file so we don't act on a
# single transient failure.

set -u

STATE_URL="http://127.0.0.1:7001/state"
STATE_FILE="/tmp/stremio-lan-remote-watchdog.fails"
LOG="/tmp/stremio-lan-remote-watchdog.log"
FAIL_LIMIT=2

REPO="$HOME/dev/stremio-lan-remote"
LAUNCH="$REPO/scripts/launch-shell.sh"

log() { echo "$(date -Iseconds) $*" >> "$LOG"; }

if curl -fsS --max-time 5 -o /dev/null "$STATE_URL"; then
  rm -f "$STATE_FILE"
  exit 0
fi

fails=0
if [[ -f "$STATE_FILE" ]]; then
  fails=$(cat "$STATE_FILE" 2>/dev/null || echo 0)
fi
fails=$((fails + 1))
echo "$fails" > "$STATE_FILE"

log "ping failed (consecutive=$fails)"

if (( fails < FAIL_LIMIT )); then
  exit 0
fi

log "restarting shell after $fails consecutive failures"

pkill -9 -f 'stremio-linux-shell' || true
pkill -9 -f 'shell/data/server.js' || true
sleep 2

if [[ ! -x "$LAUNCH" ]]; then
  log "launch script missing or not executable: $LAUNCH"
  exit 1
fi

setsid "$LAUNCH" </dev/null >>"$LOG" 2>&1 &
disown

rm -f "$STATE_FILE"
log "relaunched"
