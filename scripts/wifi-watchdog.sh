#!/usr/bin/env bash
# Wi-Fi reconnect watchdog for the Steam Deck.
#
# The Deck's ath11k Wi-Fi intermittently drops (disassociates / firmware stall),
# taking the Deck off the network for hours until someone manually toggles Wi-Fi.
# This detects the drop and re-toggles Wi-Fi automatically — the scripted version
# of what you do by hand.
#
# Runs from a systemd --user timer every 30s. Acts only after N consecutive
# failures so a single transient blip doesn't cycle the radio.
#
# DETECTION: associated to an AP (`iw dev wlan0 link` shows "Connected to") AND
# has a private IPv4. Either missing = a failure tick.
#
# RECOVERY (escalating): first re-associate the interface
# (`nmcli device disconnect/connect`), and if that hasn't helped after more
# failures, toggle the radio (`nmcli radio wifi off/on`, what the UI toggle does).
#
# NOTE: nmcli network control may require polkit/root depending on session.
# Verify on-device before enabling this timer (see deploy notes).

set -u

IFACE="wlan0"
STATE_FILE="/tmp/stremio-wifi-watchdog.fails"
LOG="/tmp/stremio-wifi-watchdog.log"
FAIL_LIMIT=2          # consecutive failures before acting
ESCALATE_AT=4         # failures before escalating to a full radio toggle

log() { echo "$(date -Iseconds) $*" >> "$LOG"; }

healthy() {
  iw dev "$IFACE" link 2>/dev/null | grep -q "Connected to" || return 1
  ip -4 addr show "$IFACE" 2>/dev/null | grep -qE "inet (192\.168|10\.|172\.)" || return 1
  return 0
}

if healthy; then
  rm -f "$STATE_FILE"
  exit 0
fi

fails=0
[[ -f "$STATE_FILE" ]] && fails=$(cat "$STATE_FILE" 2>/dev/null || echo 0)
fails=$((fails + 1))
echo "$fails" > "$STATE_FILE"
log "wifi unhealthy (consecutive=$fails)"

(( fails < FAIL_LIMIT )) && exit 0

if (( fails >= ESCALATE_AT )); then
  log "escalating: toggling wifi radio"
  nmcli radio wifi off 2>>"$LOG"; sleep 3; nmcli radio wifi on 2>>"$LOG"
  rm -f "$STATE_FILE"
else
  log "re-associating $IFACE"
  nmcli device disconnect "$IFACE" 2>>"$LOG"; sleep 2; nmcli device connect "$IFACE" 2>>"$LOG"
fi

sleep 5
if healthy; then log "recovered"; rm -f "$STATE_FILE"; fi
