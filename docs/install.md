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
