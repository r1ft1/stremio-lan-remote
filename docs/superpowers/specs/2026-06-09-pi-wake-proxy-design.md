# Raspberry Pi Wake-Proxy (Sleep-Most, Wake-on-Cast)

**Date:** 2026-06-09
**Status:** Exploratory design — captures the architecture for later. **Not buildable
yet:** the Deck-wake mechanism and a few topology details must be validated on
real hardware first (see "Must validate before building").

## Motivation

The docked Deck serves as a TV media box. When idle we'd like both the **TV and the
Deck to actually sleep** (big power saving — the TV is by far the dominant draw),
yet still let a **phone cast wake everything instantly**.

That's impossible from the Deck alone, as established on-device this session:
- A script **can't blank/sleep the TV** — gamescope owns DRM (DPMS write =
  Permission denied) and there's **no CEC adapter** on the Deck/dock.
- The Deck **can't be woken remotely** once deep-suspended — Wi-Fi WoWLAN is
  unreliable and it drops off the network in S3.

A small **always-on Raspberry Pi** as a coordinator solves both: a Pi *does* have
working HDMI-CEC (can power the TV on/off) and can wake the Deck over USB-HID or
wired WoL. The Deck and TV then sleep until a cast arrives.

This supersedes the interim [[keep-deck-awake-design]] (which keeps the Deck awake
and leaves the TV on) — build that now; build this when the hardware's validated.

## Goals

- Idle: **TV off (CEC standby) and Deck asleep** — only the Pi stays on (~1–2 W).
- A phone cast **wakes the Deck + turns on the TV** and plays, with no manual input.
- The **subscription poller/control surface stays reachable 24/7** (on the Pi).

## Non-Goals

- Playing video on the Pi (it only coordinates; the Deck remains the player).
- HDMI video passthrough through the Pi (it can't; the Deck→dock→TV video path is
  unchanged — the Pi's HDMI is used only for CEC signalling).
- Replacing the Deck. The Deck stays the player and (likely) the torrent engine.

## Power Analysis (approximate — TV dominates)

| Setup | Idle draw |
|---|---|
| Keep-awake (interim) | Deck ~5–7 W **+ TV ~60–150 W** |
| **Pi wake-proxy** | Deck asleep ~0.5 W + TV standby ~0.5 W + **Pi Zero ~0.5–1.5 W** |

The win is letting the **TV** turn off; the Pi is a rounding error by comparison.

## Architecture

The Pi becomes the **always-on coordinator**; the Deck becomes a **player that
sleeps until woken**.

```
   phone ──(network / Tailscale)──► Pi  (runs the addon: cast endpoint,
                                    │     controller, subscription poller)
                        ┌───────────┼───────────────┐
              HDMI ──► spare TV input        USB ──► Anker dock USB port
              (CEC: TV on/off + select       (USB-HID gadget: key-press
               the Deck's input)              wakes the Deck from S3)

   Deck ──► Anker dock ──HDMI──► TV     (unchanged: the real video path)
   Deck runs: the shell/player (mpv) + streaming-server (:11470)
```

### What runs where
- **Pi (always on):** the Node **addon** — the Stremio addon, the mobile
  controller + **cast endpoint** the phone hits, and the **subscription poller**.
  Plus the small coordinator logic: CEC control + Deck-wake.
- **Deck (sleeps until woken):** the **shell/player** (`:7001`, mpv) and the
  **streaming-server** (`:11470`) for live playback.
- **TV:** controlled via the Pi's CEC.

## Cast Flow (happy path)

1. Phone → Pi addon: "cast `<stream>`".
2. Pi **wakes the Deck** (USB-HID key-press, or WoL magic packet).
3. Pi **wakes the TV + selects the Deck's input** via CEC ("standby off" +
   "set stream path"/active-source to the Deck's physical address).
4. Pi waits for the Deck's shell (`:7001`) + streaming-server (`:11470`) to come up
   (poll with a timeout), then forwards the existing `/cast` → `/play_url` calls.
5. Playback appears on the TV (the Deck's normal HDMI path).
6. On stop/idle for N minutes: Pi sends **CEC standby** to the TV and lets the Deck
   suspend again (don't hold a wake lock).

## Subscriptions / Downloads — two options

Torrent downloading is CPU- and storage-heavy; a Pi Zero is weak and its SD card is
small. Decide at build time:

- **Option A — downloads stay on the Deck (recommended for a Pi Zero):** the Pi's
  poller, on finding a new episode, **wakes the Deck**, triggers the download on the
  Deck's streaming-server, waits for completion, then lets the Deck sleep. Heavy
  lifting on the Deck; Pi just schedules. Files stay in `~/stremio-downloads` on the
  Deck as today.
- **Option B — downloads on the Pi (needs Pi Zero 2 W + USB storage):** move the
  streaming-server + download executor to the Pi so episodes download while the Deck
  sleeps. More self-contained but bottlenecked by Pi CPU/throughput and needs
  external storage; the Deck would still play from the Pi's share or copy on cast.

## Hardware & Cabling

- **Raspberry Pi Zero / Zero 2 W** (Zero 2 W preferred — quad-core; required for
  Option B).
- **mini-HDMI (male) → HDMI-A (male) cable** → spare TV input (for CEC). *Mini*-HDMI,
  not micro — the Zero uses mini. Any standard HDMI cable carries CEC (pin 13).
- **micro-USB (male, the Zero's DATA port) → USB-A (male)** → an Anker dock USB port
  (for USB-HID wake), with the Pi in USB-gadget mode.
- Power to the Pi's separate PWR micro-USB port.
- Pi on the network (Wi-Fi; Zero 2 W has built-in Wi-Fi) for the phone + Tailscale.

## Must Validate Before Building (unknowns)

1. **USB-HID wake actually wakes the Deck from S3** — requires the dock USB port to
   stay powered *and* USB-wake enabled in suspend. This is the make-or-break item;
   test with the Pi configured as a USB-HID gadget sending a keypress.
2. **CEC end-to-end** — Pi can put the TV in standby *and* wake it *and* select the
   Deck's input (active-source to the Deck's physical address), not the Pi's.
3. **Fallback wake = wired WoL** — only if the Anker dock has Ethernet and the Deck's
   USB-Ethernet supports WoL in S3 (cleaner wiring, but more uncertain than USB-HID).
4. **Pi Zero performance** — fine for control/poller; validate before choosing
   Option B for downloads.
5. **Network identity** — the phone/addon must reach the Pi by a stable name
   (Tailscale on the Pi); reconcile with the existing `PUBLIC_HOST` the addon uses.

## Relationship to Existing Work

- The **addon** moves hosts (Deck → Pi) but is the same Node service; `SHELL_HOST`
  would point at the Deck over the LAN/Tailscale instead of `127.0.0.1:7001`.
- The [[show-subscriptions]] poller/executor already live in the addon, so they come
  along for free (subject to the Option A/B download decision).
- This design makes the [[keep-deck-awake-design]] obsolete once shipped (that one
  keeps the Deck awake; this lets it sleep).

## Open Questions

- Pi Zero vs Zero 2 W (drives the downloads decision).
- Where downloaded files live and how the Deck reads them (Option B).
- How aggressively to idle-standby the TV (reuse the ~2 min idle threshold from the
  keep-awake discussion).
- Whether to keep a thin always-on presence on the Deck at all, or have the Pi be the
  sole coordinator.
