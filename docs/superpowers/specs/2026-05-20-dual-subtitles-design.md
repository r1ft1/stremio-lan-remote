# Dual Subtitles

## Why

The owner is learning Japanese. While watching anime they want English and Japanese subtitles rendered on screen at the same time so the English line gives the meaning and the Japanese line gives the reading practice. Both tracks are already loaded into mpv today (embedded in the source file, or attached by Stremio's OpenSubtitles addon) — the controller just exposes a single picker, so only one can be active at a time.

## Mechanism

mpv has first-class support for two simultaneous subtitle tracks:

- `sid` (already used) selects the **primary** sub. Default render position: bottom of frame.
- `secondary-sid` selects the **secondary** sub. Default render position: top of frame.

Both render in real time. No external player changes, no `sub-add`, no font/styling work — the secondary track inherits the same styling pipeline as the primary.

## Change set

| Layer | File | Change |
|---|---|---|
| mpv property observation | `shell/src/app/imp.rs` | Add `"secondary-sid"` to the `observe_mpv_property` loop so changes flow into our state cache. |
| State snapshot | `shell/src/lan_remote.rs` | Add `pub secondary_sid: Value` (default `"auto"` per mpv convention) to `StateSnapshot` and serialize as `secondary_sid` in the JSON returned by `/state`. |
| State writer | `shell/src/app/imp.rs` | In the `connect_mpv_property_change` handler that writes into `lan_state`, add a `"secondary-sid"` arm that stores the value. |
| Track-setter validation | `addon/src/server.js` `/set_track` route | Extend the allowlist from `['aid','sid','vid']` to `['aid','sid','vid','secondary-sid']`. |
| Controller HTML | `addon/src/server.js` `controllerHtml` | Add a second `<select id="sid2">` below the existing subtitle picker, labeled "Secondary subtitles". On change → `POST /set_track` with `{kind:'secondary-sid', id: sid2.value}`. |
| Controller poll | `addon/src/server.js` `controllerHtml` `<script>` | Populate `sid2` from the same subtitle-track list as the primary picker, **filtered to exclude the primary's current selection** (option (a) per user). Update `sid2.value` from `s.secondary_sid` returned by `/state`. |

No new HTTP endpoints. No new IPC enum variants. `/set_track` already accepts an arbitrary `kind` string and passes it through to `mpv set <kind> <id>`; only the addon-side validation needs to widen.

## UI

The existing "Subtitles" picker becomes the primary. The new "Secondary subtitles" picker sits directly beneath it, styled identically (`<div class="picker"><label>…</label><select>…</select></div>`). Both default to "Off". The secondary picker is always present — even if only one sub track exists, the user sees "Off" + the one track (and the filter rule makes it just "Off" once they pick the primary). Visually:

```
┌ Audio ─────────────────────────┐
│ [English ▾]                    │
└────────────────────────────────┘
┌ Subtitles ─────────────────────┐
│ [English ▾]                    │
└────────────────────────────────┘
┌ Secondary subtitles ───────────┐
│ [Off ▾]                        │
└────────────────────────────────┘
```

## Filter rule

The secondary dropdown's options are: `Off` first, then every subtitle track from `track-list` **except** the one currently selected as primary. When the user changes the primary, the secondary dropdown rebuilds — and if the previously selected secondary is now no longer in the list (because the user picked it as primary), the secondary resets to `Off` and a `POST /set_track {kind:'secondary-sid', id:'no'}` is fired so mpv state matches the UI.

Rationale: prevents the "two tracks pointing at the same sub renders the same line twice on screen" footgun, which is confusing the first time and serves no purpose.

## State sync semantics

- `secondary-sid` is stored per-mpv-instance, not persisted to disk. New playback (loadfile) resets it to mpv's default ("no"). This matches how `sid` already behaves — Stremio doesn't carry track selection across episodes, so we don't either.
- The shell's `track-list` observation handles secondary tracks attached mid-playback (e.g., Stremio's OpenSubtitles addon loading a second language after the file starts) — the controller re-polls `/state` on `pageshow`/`focus`/`visibilitychange` already (`dd93042`), so the picker self-heals.
- If mpv reports `secondary-sid: false` or `"no"`, the controller shows `Off`.

## Risk

Low.

- `secondary-sid` is a stable mpv property documented as far back as mpv 0.10. No version sniffing needed.
- The `/set_track` change is a one-element-larger allowlist; existing callers (primary sub, audio, video) are unaffected.
- Controller HTML additions are confined to a new picker block + a small extension to the existing polling code that already rebuilds the primary picker on track-list signature change.
- No persistence layer touched.
- No interaction with `direct_mode` suppression logic in `app/imp.rs`: secondary-sid is a property Stremio's UI never sets, so there's no risk of Stremio fighting us for it.

## Out of scope

- Loading external `.srt`/`.ass` files via the controller (kitsunekko-style workflow). The user confirmed both languages are already in the dropdown via embedded tracks / OpenSubtitles addon, so we don't need `sub-add` plumbing yet.
- Customizing sub position, font, color per track.
- Remembering preferred (primary, secondary) language pair across sessions.
- Per-episode persistence.

If those become wanted later, each is an additive change on top of this design — none of this work blocks them.

## Acceptance test

1. Open an anime episode that has English (sid=1) and Japanese (sid=2) subtitle tracks loaded.
2. On the mobile controller, set Subtitles → English, Secondary subtitles → Japanese.
3. Both lines render on screen simultaneously: English at the bottom, Japanese at the top.
4. Change Subtitles → Japanese. Secondary dropdown rebuilds to exclude Japanese; English becomes selectable as secondary. Picking it → both visible (Japanese bottom, English top).
5. Set Secondary subtitles → Off. Only the primary line renders.
6. Open a video that has no subtitle tracks at all. Both pickers show only "Off"; no errors in the console.
