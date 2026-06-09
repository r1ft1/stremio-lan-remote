#!/usr/bin/env bash
# Install the Stremio LAN Remote launcher as a .desktop file so it shows up
# in the KDE app menu and in Steam's "Add a Non-Steam Game" dialog.
#
# Idempotent.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APPS_DIR="$HOME/.local/share/applications"
DESKTOP_NAME="stremio-lan-remote.desktop"

chmod +x "$REPO_DIR/scripts/launch-stremio.sh"

mkdir -p "$APPS_DIR"
install -m 0644 "$REPO_DIR/packaging/$DESKTOP_NAME" "$APPS_DIR/$DESKTOP_NAME"

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$APPS_DIR" || true
fi

echo "[steam-shortcut] installed $APPS_DIR/$DESKTOP_NAME"
echo
echo "Next steps on the Deck (Desktop Mode):"
echo "  1. Open Steam → Games (top-left) → Add a Non-Steam Game to My Library…"
echo "     The 'Stremio LAN Remote' entry should appear in the list."
echo "  2. Tick the box, click 'Add Selected Programs'."
echo "  3. Switch to Gaming Mode — it shows up under Non-Steam (Library)."
echo
echo "Or launch from the KDE app menu directly: search 'Stremio LAN Remote'."
