#!/usr/bin/env bash
# Installs the SteamDeck hardening for stremio-lan-remote:
#   - user systemd timer + service that watchdogs the shell every 15s
#   - udev rule that filters spurious power-key sources (HDMI-CEC / dock / BT
#     keyboard) while keeping the physical power button working
#
# Idempotent. Safe to re-run after a pull.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "[hardening] repo at $REPO_DIR"

# Watchdog scripts
chmod +x "$REPO_DIR/scripts/launch-shell.sh" "$REPO_DIR/scripts/watchdog.sh"

# User systemd units
mkdir -p "$HOME/.config/systemd/user"
install -m 0644 "$REPO_DIR/systemd/stremio-lan-remote-watchdog.service" "$HOME/.config/systemd/user/"
install -m 0644 "$REPO_DIR/systemd/stremio-lan-remote-watchdog.timer" "$HOME/.config/systemd/user/"
systemctl --user daemon-reload
systemctl --user enable --now stremio-lan-remote-watchdog.timer
systemctl --user status --no-pager stremio-lan-remote-watchdog.timer | head -5 || true
echo "[hardening] watchdog timer enabled"

# Udev rule (requires sudo)
if [[ -d /etc/udev/rules.d ]]; then
  sudo install -m 0644 "$REPO_DIR/udev/99-stremio-lan-remote-power-filter.rules" /etc/udev/rules.d/
  sudo udevadm control --reload
  sudo udevadm trigger --subsystem-match=input
  echo "[hardening] udev power-key filter installed"
else
  echo "[hardening] /etc/udev/rules.d missing — skipping udev install"
fi

echo "[hardening] done"
