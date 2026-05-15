# Proposal: Optional LAN remote-control endpoint in stremio-linux-shell

**Status:** Draft for upstream discussion
**Target repo:** [Stremio/stremio-linux-shell](https://github.com/Stremio/stremio-linux-shell)
**Author:** james@learnkuwait.com

## Why

There is no first-class way to drive a desktop Stremio instance from another device on the same network. Useful use cases that today require either casting hardware, a Bluetooth keyboard, or a forked binary:

- Picking and starting a stream on a SteamDeck / HTPC from a phone on the couch
- Pause / resume / seek / volume / track selection from a phone
- Multi-room: trigger playback on whichever Stremio instance is closest to the screen the user is looking at

Stremio mobile is a perfectly good catalog and stream picker. The missing piece is the wire between it and a sibling desktop instance.

## Non-goals

- Internet-facing remote control (this is LAN-only by default, no auth on loopback)
- Streaming to the mobile device (the desktop already plays via libmpv; phone is just the picker)
- Replacing the streaming-server's HTTP API (separate concern)

## What this proposes

Add an **optional, off-by-default** HTTP endpoint to `stremio-linux-shell` that:

1. Binds to a configurable port (default `127.0.0.1:7001`, configurable via `--lan-remote-bind` flag and `LAN_REMOTE_BIND` env)
2. Exposes a small JSON API:
   - `POST /play_url` `{ url }` — load and play a URL in libmpv
   - `POST /stop` — stop playback, return UI to dashboard
   - `POST /pause` / `POST /resume` / `POST /toggle`
   - `POST /seek_relative` `{ seconds }` / `POST /seek_absolute` `{ seconds }`
   - `POST /volume` `{ delta }` / `POST /set_volume` `{ value }`
   - `POST /set_track` `{ kind: "aid"|"sid", id: string }`
   - `GET /state` → snapshot of mpv properties relevant to a remote controller (paused, time-pos, duration, track-list, aid, sid, volume, paused-for-cache, cache-buffering-state)

Behavior knobs:

- Off by default. Opt-in via flag/env. No port bound unless explicitly enabled.
- Bind defaults to `127.0.0.1` (LAN reachable only if user binds to `0.0.0.0` deliberately).
- When a remote `play_url` is in flight, the shell switches into a "direct" rendering mode (webview overlay set to opacity 0; mpv plays the URL directly without going through the React player). When `stop` is received, the webview returns to opacity 1 and navigates to `#/`.

## Why this layer, not an addon

The Stremio addon SDK only returns `stream` entries — there is no addon-callable way to (a) hand a URL to libmpv directly, (b) hide the React player while still playing audio+video, (c) read mpv property state. Those have to be in the shell because they touch libmpv and the GTK widget tree.

## Compatibility

- No effect on users who don't enable the flag.
- No new dependencies if you keep using the existing axum/flume from the LAN-remote sketch.
- Safe to ship behind `cfg(feature = "lan_remote")` if the Stremio team prefers compile-time gating.

## Reference implementation

The fork at [github.com/<user>/stremio-lan-remote](https://github.com/) implements this exactly. Key files:

- `shell/src/lan_remote.rs` — axum router, `LanMessage` enum, `StateSnapshot`
- `shell/src/app/imp.rs` — wires `LanMessage` to mpv commands and webview opacity, observes mpv properties into `StateSnapshot`, suppresses Stremio React IPC `stop`/`loadfile`/`set pause`/`set vid` while in direct mode so the React player can't fight the remote control

All upstream-shell code paths are untouched except for two clearly demarcated additions in `imp.rs`. PR-shaped diff ≈ 250 lines.

## Surface for a future Stremio mobile feature

If this lands, Stremio mobile could grow a native "Cast to Stremio Desktop" button in the stream picker that calls `/play_url` directly on a discovered LAN peer (mDNS advertisement is the obvious next step). Today, third-party addons have to ship their own paired desktop fork — this proposal makes pairing-free remote control possible from a vanilla install.

## Questions for the Stremio team

1. Is the team open to a remote-control surface on the shell at all, even off-by-default?
2. Prefer compile-time feature flag, runtime flag, or both?
3. Any naming preferences for the env/CLI flag?
4. Would you want the API behind authentication (token in `~/.stremio-server/...`) from day one, or is loopback-only sufficient for v1?
5. mDNS advertisement — in scope or out?

## What I'm asking for

A short conversation, not a merged PR. If the answer to (1) is "no, this belongs in a fork forever," we keep doing what we're doing. If the answer is "yes with caveats," I open a PR shaped to the team's preferences.
