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

## Always-on streaming-server (headless downloads)

Copy `shell/data/server.js` to `~/.local/share/stremio-lan-remote/server.js`, then:

```bash
mkdir -p ~/.config/systemd/user
cp packaging/stremio-lan-remote-server.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now stremio-lan-remote-server.service
loginctl enable-linger "$USER"   # keep services running while idle / across sleep
```

Verify it is listening with the app closed:

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:11470/  # expect 200
```
