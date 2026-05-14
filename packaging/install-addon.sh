#!/usr/bin/env bash
set -euo pipefail

DEST="${HOME}/.local/share/stremio-lan-remote/addon"
UNIT_DEST="${HOME}/.config/systemd/user/stremio-lan-remote-addon.service"

mkdir -p "$DEST"
cp -r addon/. "$DEST/"

LAN_IP=$(hostname -I | awk '{print $1}')

cd "$DEST"
npm ci --omit=dev

mkdir -p "$(dirname "$UNIT_DEST")"
cp "$(dirname "$0")/stremio-lan-remote-addon.service" "$UNIT_DEST"

# Inject PUBLIC_HOST env line right after the BIND line
sed -i "/^Environment=\"BIND=/a Environment=\"PUBLIC_HOST=${LAN_IP}:7000\"" "$UNIT_DEST"

systemctl --user daemon-reload
systemctl --user enable --now stremio-lan-remote-addon.service

echo "Addon installed. On your phone, install:"
echo "  http://${LAN_IP}:7000/manifest.json"
