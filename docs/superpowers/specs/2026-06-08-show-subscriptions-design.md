# Show Subscriptions → Headless Auto-Download

**Date:** 2026-06-08
**Status:** Design approved, pending implementation plan

## Summary

Let the user subscribe to a TV show and have newly-aired episodes automatically
downloaded to the Steam Deck in 1080p, **without the custom Stremio app needing to
be running**. Subscribing is driven from inside Stremio (an action in the stream
list). The download is unattended and survives the app being closed, the Deck
being in Gaming Mode, and sleep/wake.

This is the Stremio-native equivalent of what Sonarr does for TV: poll for new
episodes, grab a release automatically.

## Goals

- Subscribe / unsubscribe to a series from inside Stremio.
- Automatically download episodes that air **after** the subscription date, in 1080p.
- Auto-pick the **most-seeded** 1080p release per episode.
- Run **fully headless** — works with the custom app closed.
- Surface downloaded episodes in the existing "Deck Downloads — Shows" catalog.

## Non-Goals

- No back-catalog downloading. Only episodes aired after subscription. (User choice.)
- No per-show quality/language/scope overrides in v1 (global rules only).
- No web management UI in v1 (subscribe is in-Stremio only).
- No bandwidth throttling or pause-during-games (user chose full speed always).
- No movie subscriptions (series only).

## Decisions (locked during brainstorming)

| Question | Decision |
|---|---|
| Run with app closed? | **Fully headless** — add always-on services |
| Subscribe mechanism | **Action inside Stremio** stream list |
| Auto-pick rule | **Most seeders** among 1080p |
| Audio language | Take most-seeded (English in practice); **skip obviously foreign-only** releases |
| Download scope | **New episodes only** (aired after subscribedAt) |
| Poll cadence | **15 min** (matches Sonarr default; min 10, default 15) |
| Behavior while gaming | **Full speed always**, no throttle/pause |
| Fresh-release handling | Retry each poll up to **7 days** if no 1080p with **≥3 seeders**, then mark skipped |
| Retention | Keep forever; manual delete via existing 🗑 action |

## Current Architecture (as-is)

- **App / shell** (`stremio-linux-shell`, Rust): the player + `lan_remote` HTTP
  server on `:7001`. It **executes downloads** (`lan_remote.rs::download_to_file`,
  a resumable `reqwest` HTTP GET from the streaming-server to disk, tracked in
  `.downloads.json`) and **spawns the streaming-server** (`server.js`) via
  `SERVER_PATH`.
- **Streaming-server** (`shell/data/server.js`, Node): the torrent client on
  `:11470` / `:12470`. Currently a **child of the shell** — dies when the app closes.
- **Addon** (`addon/`, Node, `:7000`): a Stremio addon (always-on systemd unit
  `stremio-lan-remote-addon.service`). Resolves streams via Torrentio
  (`STREAM_RESOLVER_URL=https://torrentio.strem.fun`), proxies Cast/Download/control
  actions to the shell, and reads `.downloads.json` (via `shell:7001/downloads`) to
  render progress + the Downloads catalogs. **Delegates everything to the shell.**

**Why headless needs work:** today both the torrent client (`:11470`) and the
byte-writer (`:7001`) only exist while the app runs. The addon alone cannot download.

## Target Architecture (to-be)

Three structural changes plus the new subscription logic.

### 1. Streaming-server as its own always-on service

`server.js` runs as a dedicated systemd **user** service
(`stremio-lan-remote-server.service`), so `:11470` is up regardless of the app.

- The app stops spawning its own copy; the shell connects to the already-running
  shared server instead.
- `scripts/launch-stremio.sh` must no longer kill `:11470/:12470` or
  `shell/data/server.js` on launch (it currently does). It should detect the
  shared server and reuse it; only (re)start it if absent.
- Enable `loginctl enable-linger deck` so the service runs while idle / across
  sleep-wake and in Gaming Mode without an interactive session.

### 2. Download execution + `.downloads.json` ownership move to the addon

The resumable-download logic (mirroring `download_to_file`: HTTP GET with `Range`
resume from `:11470` → file in the downloads dir, status tracking in
`.downloads.json`) is reimplemented in the always-on **addon** (Node).

- The **addon becomes the single owner/writer** of `.downloads.json` and the
  downloads directory.
- The shell's existing manual "Download" action routes through the addon's executor
  (the addon already receives the trigger via `/download_trigger_html`), instead of
  the shell writing the file itself.
- The shell keeps **reading** `.downloads.json` for its own UI; it no longer writes it.
- This is a refactor of the existing manual-download path. Chosen over a two-writer
  lock-file approach for correctness (single writer = no concurrent-write races).

### 3. New subscription subsystem (in the addon)

**a. Subscription store** — `subscriptions.json` next to `.downloads.json`:
```json
[{ "seriesId": "tt1234567", "subscribedAt": "2026-06-08T12:00:00Z" }]
```

**b. Subscribe/unsubscribe action** — `defineStreamHandler` adds an entry to every
series-episode stream list:
- Not subscribed → `🔔 Subscribe — auto-download new 1080p`
- Subscribed → `🔕 Unsubscribe`

The entry is an `externalUrl` to a new addon endpoint (e.g. `/subscribe?id=<seriesId>`
/ `/unsubscribe?id=<seriesId>`) that updates `subscriptions.json` and returns a small
HTML page that bounces back to `stremio:///` (same pattern as `/download_trigger_html`).
`seriesId` is the base IMDb id (strip `:season:episode`).

**c. Poller** — a `setInterval` (15 min) in the addon. Each tick, for each subscription:
1. Fetch the series episode list from Cinemeta (already cached 24h in the addon).
2. Select target episodes: `released <= now` AND `released > subscribedAt` AND not
   already present/queued in `.downloads.json` for that `seriesId:season:episode`.
3. For each target, query Torrentio for that `series/<id>:<s>:<e>`.
4. Filter to 1080p; drop obviously foreign-only releases; require `seeders >= 3`;
   pick the **highest seeder count** (reuse existing `seederCount` parsing).
5. Enqueue via the addon download executor with the same filename/`meta_id`
   convention the current `/download_trigger_html` uses (so it lands in the
   "Deck Downloads — Shows" catalog correctly).

**Idempotency:** once an episode is in `.downloads.json`, later ticks skip it — no
Torrentio query, no download. Idle ticks for a caught-up show are a cached Cinemeta
read and nothing else.

**Fresh-release retry:** if step 4 finds no qualifying release, leave the episode as
a pending target and retry on subsequent ticks for up to **7 days** after its air
date, then record it as `skipped` so it stops being retried.

## Data Flow (new episode, happy path)

```
poller tick (every 15 min)
  → Cinemeta: series episode list (cached)
  → find aired-after-subscribe episode not in .downloads.json
  → Torrentio: /stream/series/<id>:<s>:<e>.json
  → filter 1080p, skip foreign-only, seeders>=3, pick max seeders
  → addon executor: GET http://127.0.0.1:11470/<infoHash>/<fileIdx>  (resumable)
       → write to downloads dir, update .downloads.json
  → episode now appears under "Deck Downloads — Shows" catalog
```

## State & Files

- `subscriptions.json` — owned by addon. List of subscribed series + subscribedAt.
- `.downloads.json` — ownership **moves to addon**. Per-download status (existing schema:
  `filename`, `source_url`, `meta_id`, `bytes`, `total`, `status`, ...). Add a
  per-episode subscription state for retry/skip tracking (e.g. `pendingSince`,
  `skipped`) — either here or in a small companion file; to be settled in the plan.
- Downloads directory — unchanged location (`~/stremio-downloads`).

## Error Handling

- Cinemeta/Torrentio request failure on a tick → log, leave targets pending, retry next tick.
- No qualifying release → pending + retry window (7 days), then `skipped`.
- Download interrupted (service restart, network) → existing resume logic (`Range`/206)
  continues on next tick / next start, same as today's `interrupted` → resume path.
- Streaming-server (`:11470`) down when a download is attempted → skip this tick, retry next.
- Subscribe action when already subscribed (or vice-versa) → idempotent no-op + friendly page.

## Testing

- **Unit (addon):** episode-selection logic (aired-after-subscribe, dedupe vs
  `.downloads.json`); release selection (1080p filter, foreign-only skip, seeder
  threshold, max-seeder pick); subscribe/unsubscribe mutations of `subscriptions.json`;
  retry-window/skip transitions. Mock Cinemeta + Torrentio (existing tests already mock
  `fetch`).
- **Unit (addon executor):** resumable download to a temp dir against a fake range
  server; `.downloads.json` updates; cancel/delete.
- **Integration:** poller end-to-end with mocked upstreams → asserts a download is
  enqueued with the correct filename/`meta_id` and shows in the series catalog.
- **Manual on Deck:** subscribe to a currently-airing show, confirm the next episode
  lands with the app closed; confirm idle ticks do nothing; confirm a download runs
  during a game.

## Open Items for the Implementation Plan

- Exact mechanism for the shell to reuse vs. start the shared streaming-server, and
  the launcher changes that follow.
- Where per-episode retry/skip state lives (`.downloads.json` vs companion file).
- Heuristic for "obviously foreign-only" detection from Torrentio titles (conservative;
  err toward keeping a release rather than skipping a wanted one).
- Migration: first run where `.downloads.json` ownership flips from shell to addon.

## Upstream Note

The shell is 6 commits / ~3 weeks behind `Stremio/stremio-linux-shell` (last tested
`261f46f` 2026-05-02; upstream HEAD `638b5af` 2026-05-22) — all chores/refactors.
Upstream's `chore: remove reqwest dep` touches the same area as our download code;
a future rebase will need attention but this is not blocking.
