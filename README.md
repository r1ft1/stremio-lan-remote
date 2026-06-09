# Stremio LAN Remote

Control a desktop Stremio v5+ instance from Stremio mobile on the same LAN. Built for SteamDeck.

## What it does

Phone user opens a movie or episode in Stremio mobile, taps the "📺 Cast to Deck" stream entry, and the Deck's Stremio app starts playing — no clicks on the Deck.

Also supports background downloads to the Deck with resume-on-restart, a "Deck Downloads" catalog, full playback control (pause / seek / volume / fullscreen / audio + subtitle track selection) from a mobile web controller, and cancel / delete inside Stremio mobile.

The mobile controller also exposes **Exit Stremio** and **Suspend Deck** buttons (both behind a confirmation prompt). When playback starts and headphones are detected on the Deck (3.5mm jack, USB headset, or Bluetooth), the initial volume is automatically set to 50%. The volume cap was raised from mpv's default 130% to 200%.

## Install on Stremio mobile (Android, iOS, or web)

The addon is currently hosted at:

> **`https://steamdeck.REDACTED.ts.net/manifest.json`**

> ⚠️ This URL is served by Tailscale Funnel from a personal SteamDeck. It's publicly reachable from anywhere — Tailscale is **not** required on the phone — but only when the host is online and Funnel is enabled. For your own self-hosted instance, see [docs/install.md](docs/install.md).

To install:

1. Open Stremio on the phone.
2. Settings → Add-ons → "Add Add-on" (or the `+` icon).
3. Paste the manifest URL above.
4. Install.

Or, on web: visit [web.stremio.com](https://web.stremio.com), sign in, paste the URL into the add-on installer. Stremio syncs the addon to mobile automatically.

After install, new stream entries appear on every movie / episode meta page:

- `📺 Cast: …` — start playback on the Deck.
- `⬇ Download: …` — save a copy to the Deck for later.

A new "Deck Downloads" carousel appears on Board / Discover for browsing what's been downloaded.

## Architecture

See [the design doc](docs/superpowers/specs/2026-05-14-stremio-lan-remote-design.md).

## Self-host

See [docs/install.md](docs/install.md).

## Status

Tracks upstream Stremio releases via [nightly CI](.github/workflows/upstream-rebase.yml). See open issues for known breakage on the latest upstream commit.

## License

MIT.
