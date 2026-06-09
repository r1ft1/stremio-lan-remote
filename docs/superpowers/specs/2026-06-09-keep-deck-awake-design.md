# Keep Deck Awake (Media-Box Mode)

**Date:** 2026-06-09
**Status:** Design approved, pending implementation plan

## Summary

Stop the docked Steam Deck from automatically suspending while it serves as the
LAN media box, so it stays reachable on the network, keeps subscription
auto-downloads running, and plays a phone-initiated cast instantly. Installed as
a one-time system change via the existing `scripts/install-deck-hardening.sh`.

## Problem

The Deck deep-S3 auto-suspends after a short idle. When it does, Wi-Fi powers off
→ it drops off Tailscale, the [[show-subscriptions]] poller/downloads pause, and a
cast can't wake it (Wi-Fi WoWLAN is unreliable on the Deck). This caused repeated
"Deck unreachable" episodes throughout development.

## Goal

While docked on AC as the media box, the Deck **does not auto-suspend** → always
reachable, downloads run 24/7, casts play immediately.

## Non-Goals

- **Turning the TV off when idle.** Not achievable here (see Findings) — the TV
  stays on showing the UI when idle; rely on the TV's own screensaver/standby.
- App-scoped behavior (sleep normally when Stremio isn't running) — user chose
  always-awake for simplicity.
- The Raspberry-Pi wake-proxy (lets TV+Deck fully sleep) — a separate, more
  power-efficient future design; not in scope here.
- TDP / clock changes.

## Decisions (locked during brainstorming)

| Question | Decision |
|---|---|
| Idle behavior | **Never auto-suspend** while in use (TV stays on) |
| Scope | **Always-awake / persistent** (not app-lifetime-scoped) |
| Install vehicle | **`scripts/install-deck-hardening.sh`** (already root, idempotent) |
| Mechanism | **Mask the systemd sleep/suspend targets** |

## Findings (on-device, grounding the design)

- Internal panel is already off when docked (`eDP-1: enabled=disabled, dpms=Off`)
  — there is no "Deck OLED" to blank.
- The TV is on `card0-DP-1` (`connected, enabled, dpms=On`).
- **A script cannot blank the TV here:** writing DPMS to `DP-1` returns
  `Permission denied` even as root (gamescope holds DRM master); and there is **no
  CEC adapter** (`cec-client` → "Found devices: NONE", no `/dev/cec*`). So TV
  on/off control from the Deck is impossible — hence the TV-stays-on non-goal.
- `IdleAction` is unset in `logind.conf` (default `ignore`), so logind idle is not
  the trigger. Auto-suspend is **Steam-driven** (`steamos-powerbuttond` /
  gamescope) invoking logind's suspend operation, which activates `suspend.target`.
- **Masking the sleep targets stops it** — verified earlier this session (masked
  during a `cargo build`; the Deck stayed up the whole time).

## Mechanism

In `scripts/install-deck-hardening.sh`, add an idempotent step:

```bash
sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target
```

This makes any suspend request (Steam auto-suspend and manual short-press) fail, so
the Deck never sleeps. Long-press power-off still works (`poweroff.target` is not
masked). Reversible via `sudo systemctl unmask …`.

Provide a revert path: an `--undo`/uninstall branch (or a documented one-liner) that
unmasks the four targets, restoring stock sleep behavior.

## Components / Files

- **Modify `scripts/install-deck-hardening.sh`:** add the mask step (idempotent —
  masking an already-masked target is a no-op) with a clear log line; add an
  uninstall/undo path that unmasks.
- **Update `docs/install.md`:** document the new behavior, the trade-off (no sleep
  at all; TV stays on when idle), and how to revert.

No application code changes. No new always-on process.

## Trade-offs (call out in docs)

- **Manual short-press sleep is also disabled** (acceptable for an always-on AC
  media box; long-press power-off still available).
- **TV stays on when idle** — burn-in only a concern on an OLED TV; otherwise just
  cosmetic. The TV's own screensaver/standby still applies.
- Slightly higher idle power than letting it sleep (the Deck ~5–7 W; the TV is the
  real cost) — accepted; the Pi wake-proxy is the future fix if power matters.

## Error Handling

- `systemctl mask` requires root — the installer already runs `sudo` for the udev
  rule; reuse that. If `sudo` is unavailable, log and skip with a clear message
  (don't fail the whole hardening install).
- Idempotent: safe to re-run after a `git pull`.

## Testing / Verification

- After install: `systemctl is-enabled suspend.target` → `masked` (likewise the
  other three).
- Leave the Deck idle past its usual auto-suspend timeout (a few minutes) and
  confirm it stays up: `/state` (`:7001`) still answers and it stays `active` on
  Tailscale.
- Confirm a subscription download continues across the former suspend window.
- Revert test: run the undo path → `systemctl is-enabled suspend.target` returns to
  `static`, and the Deck can suspend again.

## Rollback

`sudo systemctl unmask sleep.target suspend.target hibernate.target hybrid-sleep.target`
