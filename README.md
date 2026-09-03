# Stremio LAN Remote

Control a desktop Stremio v5+ instance from Stremio mobile on the same LAN. Built for SteamDeck.

## What it does

Phone user opens a movie or episode in Stremio mobile, taps the "📺 Cast to Deck" stream entry, and the Deck's Stremio app starts playing — no clicks on the Deck.

Also supports background downloads to the Deck with resume-on-restart, a "Deck Downloads" catalog, full playback control (pause / seek / volume / fullscreen / audio + subtitle track selection) from a mobile web controller, and cancel / delete inside Stremio mobile.

**Casting YouTube.** Share a video from the YouTube app (or any app that shares a link) to **Deck**, and it plays on the Deck with the same controller — pause, seek, volume, tracks. mpv resolves the link with `yt-dlp`, so most streaming sites work, not just YouTube. See [YouTube and other links](#youtube-and-other-links).

The mobile controller also exposes an **Exit Stremio** button (behind a confirmation prompt). When playback starts and headphones are detected on the Deck (3.5mm jack, USB headset, or Bluetooth), the initial volume is automatically set to 50%. The volume cap was raised from mpv's default 130% to 200%.

## Getting started on a Steam Deck (from source)

> **Heads up — not one-click.** This is a custom Rust/GTK build of the Stremio shell plus a Node addon, so first-time setup is manual (budget ~20 min). It's vibecoded, but the author uses it daily. Everything runs **locally on your Deck**; nothing is exposed to the internet unless you deliberately do so.

Do all of this in **Desktop Mode**.

### 1. Prerequisites
- A Steam Deck on SteamOS, on your Wi-Fi. SteamOS already ships `podman`; install [`distrobox`](https://distrobox.it/) if it's missing.
- **[Tailscale](https://tailscale.com)** — optional but strongly recommended. It's how you reach the phone controller over **HTTPS** (which Firefox/iOS need), and how you SSH into the Deck to debug. Install it on the Deck *and* your phone, both on the same tailnet.

### 2. Clone
```bash
git clone https://github.com/r1ft1/stremio-lan-remote.git ~/dev/stremio-lan-remote
cd ~/dev/stremio-lan-remote
```

### 3. Create the build container
The shell needs GTK4 / WebKit / mpv, so it builds inside an Arch `distrobox` named `stremio-build`:
```bash
distrobox create --name stremio-build --image docker.io/library/archlinux:latest
distrobox-enter stremio-build -- bash -c '
  sudo pacman -Syu --noconfirm base-devel git rustup pkgconf \
    gtk4 libadwaita webkitgtk-6.0 mpv nodejs npm && rustup default stable'
```

### 4. Build
```bash
# Rust shell — a few minutes the first time
distrobox-enter stremio-build -- bash -c "cd ~/dev/stremio-lan-remote/shell && cargo build --release"
# Addon dependencies (plain Node, no build step)
distrobox-enter stremio-build -- bash -c "cd ~/dev/stremio-lan-remote/addon && npm install"
```

### 5. (Optional) RealDebrid
For instant cached streams, save your RealDebrid API key to a file — **never commit it** (it lives outside the repo):
```bash
mkdir -p ~/.config/stremio-lan-remote
printf '%s' 'YOUR_RD_API_KEY' > ~/.config/stremio-lan-remote/realdebrid-key
chmod 600 ~/.config/stremio-lan-remote/realdebrid-key
```
Without a key, the addon falls back to plain torrentio (streams via the Deck's built-in BitTorrent server). *(Note: RealDebrid + torrentio is currently broken by RealDebrid's 2026 API changes — plain torrentio still works.)*

### 6. (Optional) YouTube and other links
Casting links needs `yt-dlp` **inside the build container** (that's where the shell runs), on `PATH`:
```bash
distrobox-enter stremio-build -- bash -lc '
  curl -fL -o /tmp/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux
  sudo install -m 755 /tmp/yt-dlp /usr/local/bin/yt-dlp && rm /tmp/yt-dlp'
```
The standalone binary is used rather than the distro package because it self-updates (`sudo yt-dlp -U`) and pulls in no dependencies. Verify the download against the release's `SHA2-256SUMS` if you care to.

yt-dlp also needs a **JavaScript runtime** for YouTube — without one it warns that extraction is deprecated and silently loses formats. Deno is its default, but the container already has Node:
```bash
mkdir -p ~/.config/yt-dlp && echo '--js-runtimes node' > ~/.config/yt-dlp/config
```

### 7. Run it
```bash
./scripts/install-steam-shortcut.sh    # adds a .desktop entry (KDE menu + "Add a Non-Steam Game")
```
Then in Steam → **Add a Non-Steam Game → Stremio LAN Remote**, and launch it from Game Mode. Or run it directly:
```bash
./scripts/launch-stremio.sh
```
This starts the player shell + the addon on port 7000. A control **token is auto-generated** at `~/.config/stremio-lan-remote/token` on first launch.

### 8. (Optional) Keep the addon alive across sleep/reboot
```bash
mkdir -p ~/.config/systemd/user
cp systemd/stremio-lan-remote-addon.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now stremio-lan-remote-addon.service
loginctl enable-linger "$USER"
```

### 9. Open the controller
- **On your Wi-Fi:** `http://steamdeck.local:7000/app?token=<token>` (token from the file above; use `http://<deck-lan-ip>:7000/...` if `steamdeck.local` won't resolve).
- **Over Tailscale (HTTPS — required for Firefox/iOS):** give the addon a real cert:
  ```bash
  sudo tailscale serve --bg --https=443 127.0.0.1:7000
  ```
  then open `https://<deck>.<your-tailnet>.ts.net/app?token=<token>`. After the first tokenized visit a 1-year cookie is set, so the bare host works — **Add to Home Screen** for an app icon.

### Debugging
SSH in over Tailscale: `ssh deck@<deck-tailscale-ip>`. Logs live in `/tmp/`: `stremio-lan-remote-addon.log`, `stremio-lan-remote-shell.log`, `stremio-lan-remote-launcher.log`. Rebuild the shell after edits with the Step 4 command, then relaunch via Steam.

## Install on Stremio mobile (Android, iOS, or web)

This addon is **self-hosted on your own SteamDeck** and intended for your **local network** (or your own private Tailscale tailnet). Control/PWA routes are protected by an auto-generated token; even so, do **not** port-forward or tunnel it to the public internet. Set up the Deck first (see [Getting started](#getting-started-on-a-steam-deck-from-source) below or [docs/install.md](docs/install.md)), then install it from your Deck's address on the same Wi-Fi:

> **`http://steamdeck.local:7000/manifest.json`**  (or `http://<your-deck-lan-ip>:7000/manifest.json`)

To install:

1. Open Stremio on the phone (on the same Wi-Fi as the Deck).
2. Settings → Add-ons → "Add Add-on" (or the `+` icon).
3. Paste your Deck's manifest URL above.
4. Install.

There's also an installable phone web app (search → cast → control) at **`http://steamdeck.local:7000/app`** — open it in Safari/Chrome and Add to Home Screen.

Or, on web: visit [web.stremio.com](https://web.stremio.com), sign in, paste the URL into the add-on installer. Stremio syncs the addon to mobile automatically.

After install, new stream entries appear on every movie / episode meta page:

- `📺 Cast: …` — start playback on the Deck.
- `⬇ Download: …` — save a copy to the Deck for later.

A new "Deck Downloads" carousel appears on Board / Discover for browsing what's been downloaded.

### YouTube and other links

Two ways to send a link to the Deck, both landing on the usual controller (pause / seek / volume / tracks):

- **Share sheet (Android).** In the YouTube app, Share → **Deck**. The web app declares a [share target](https://developer.mozilla.org/en-US/docs/Web/Manifest/share_target), so it appears alongside your other apps. Titles are resolved through YouTube's oEmbed endpoint, so the controller shows the real video name.
- **Paste a link.** The `/app` page has a "…or paste a YouTube link" box under the search field. Works on any phone.

> **The share sheet entry only appears after the web app is installed**, and Android caches the manifest at install time. If you added the app to your home screen before this feature existed, remove it and re-add it from `/app`.
>
> **iOS can't do share targets.** Use the paste box, or make a Shortcut that opens `https://<deck>/cast_youtube?url=` with the shared URL appended.

Resolution is mpv's `yt-dlp` hook, so this is not YouTube-specific — most sites yt-dlp supports will play. Requires [step 6](#6-optional-youtube-and-other-links) of the setup. Only `http`/`https` links are accepted.

## Architecture

See [the design doc](docs/superpowers/specs/2026-05-14-stremio-lan-remote-design.md).

## Self-host

See [docs/install.md](docs/install.md).

## Status

Tracks upstream Stremio releases via [nightly CI](.github/workflows/upstream-rebase.yml). See open issues for known breakage on the latest upstream commit.

## License

MIT.
