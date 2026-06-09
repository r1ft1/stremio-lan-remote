# Install

## SteamDeck (Desktop Mode)

1. Download the latest `stremio-lan-remote-*.flatpak` and `addon-*.tar.gz` from [Releases](../../releases).
2. Install the Flatpak:
   ```bash
   flatpak install --user stremio-lan-remote-*.flatpak
   ```
3. Install the addon:
   ```bash
   tar xzf addon-*.tar.gz
   ./packaging/install-addon.sh
   ```
4. The install script prints the URL to use on your phone. Open Stremio mobile and add it as a custom addon.

## Updating

After Stremio releases a new version and a new build is shipped:
```bash
flatpak install --user --reinstall stremio-lan-remote-*.flatpak
./packaging/install-addon.sh
```

## Uninstall

```bash
systemctl --user disable --now stremio-lan-remote-addon.service
rm -rf ~/.local/share/stremio-lan-remote ~/.config/systemd/user/stremio-lan-remote-addon.service
flatpak uninstall --user dev.stremiolanremote.Stremio
```

## Source build (Deck-side, distrobox)

For the local source build at `~/dev/stremio-lan-remote` that `scripts/launch-stremio.sh` uses:

```bash
cd ~/dev/stremio-lan-remote
git pull
distrobox-enter stremio-build -- bash -c "cd shell && cargo build --release"
# Addon is plain Node, no build step.
# Relaunch via Steam (Non-Steam Game) or:
~/dev/stremio-lan-remote/scripts/launch-stremio.sh
```

## Controller actions

The mobile controller (`https://<deck-host>/remote`) exposes:

| Button | Endpoint (shell) | Notes |
|--------|------------------|-------|
| ⏹ Stop Deck playback | `POST /stop` | Stops mpv, returns Stremio UI to browse mode. |
| ⏏ Exit Stremio | `POST /quit` | Calls `app.quit()` — clean GTK shutdown, returns focus to Steam / Game Mode. Confirms first. |
| ⏻ Suspend Deck | `POST /suspend` | Spawns `loginctl suspend`. Confirms first. Cleaner than poweroff for in-progress downloads. |
| Volume slider | `POST /volume` (delta), `POST /set_volume` (absolute) | mpv `volume-max=200` — can exceed system speaker level. |

## BitTorrent DHT warmup

`scripts/launch-stremio.sh` fires a background curl 15 s after launch against the most-recent infoHash from `~/stremio-downloads/.downloads.json`, with `--max-time 5`. This pre-populates streaming-server's DHT routing table so the first cast after a reboot doesn't sit on a black screen for 1–2 min waiting for peer handshakes. Skipped silently if there are no prior downloads. Log lines are appended to `/tmp/stremio-lan-remote-launcher.log` with a `[warmup …]` prefix.

## Headphones auto-volume

On the first `playback_started` of each app session, the shell shells out to `pactl get-default-sink` + `pactl list sinks` and checks the active sink's port name. If it contains `headphone`, `headset`, or the sink name contains `bluez`, mpv is told to start at volume 50%. The check runs once per app run, not per episode — manual volume changes during a binge are preserved.
