# Deck PWA — lightweight search → cast → control

**Date:** 2026-06-16
**Status:** Design approved (user approved build 2026-06-16)

## Why

Today the phone flow is: official Stremio app (browse) → "Cast to Deck" stream →
browser handoff to the controller. The user wants **one installable app** to search
content, cast it to the Deck, and control playback — usable on **iOS**. A full
stremio-web fork was ruled out (weeks of work + permanent upstream-sync tax); the
chosen scope is a **lightweight** companion: *search → cast → control*, no account /
library / continue-watching / other addons.

## Goal

An installable app (Add-to-Home-Screen on iOS, no App Store) served by the addon:
search movies/series (via Cinemeta), tap to cast to the Deck, land on the existing
controller. Reuses the existing resolver, `/cast`, and controller (with Get-Subtitles).

## HTTPS / hosting

Served by the **addon** (same origin → no CORS, no mixed-content). The addon is
already fronted by **`tailscale serve`** HTTPS on `https://steamdeck.REDACTED.ts.net`
(evidence: `publicBase()` defaults to `https://<host>` and the existing "Cast to Deck"
links work). So the PWA rides existing valid-cert HTTPS — no warnings, no new setup.
(Verify `tailscale serve` is running before relying on it.)

## Architecture

Two pages, same origin:
- **`/app`** — the install start page: search box + "Popular" rows; renders results;
  for a series, shows its episodes inline. Tapping a movie → `/cast?id=…`; tapping an
  episode → `/cast?id=…&season=…&episode=…`.
- **controller** (existing `/cast` output) — playback control. Same origin + in
  manifest `scope`, so it opens inside the standalone app.

### Component 1 — `addon/src/discover.js` (new, testable; injectable `fetch`)

Thin Cinemeta client. Base `https://v3-cinemeta.strem.io`.
- `cinemetaSearch(query, {fetch})` → query both `catalog/movie/top/search=<q>.json` and
  `catalog/series/top/search=<q>.json`; merge + normalize to `{id,type,name,poster,year}`.
  Returns `[]` on empty query or per-type fetch failure (best-effort).
- `cinemetaPopular(type, {fetch})` → `catalog/<type>/top.json` → normalized metas (`[]` on error).
- `cinemetaEpisodes(id, {fetch})` → `meta/series/<id>.json` → `meta.videos` normalized to
  `{id,season,episode,name,released,thumbnail}`, drop season 0 (specials), sort by season then episode.

### Component 2 — `addon/src/server.js` routes

- `GET /app` → `discoverHtml()` page (search UI + manifest link + apple meta + icons).
- `GET /api/search?q=` → `cinemetaSearch(q, {fetch:fetchFn})` → JSON list.
- `GET /api/catalog/popular?type=movie|series` → `cinemetaPopular` → JSON list.
- `GET /api/meta?id=` → `cinemetaEpisodes(id, {fetch:fetchFn})` → JSON episode list.
- `GET /manifest.webmanifest` → manifest JSON (`start_url:/app`, `scope:/`,
  `display:standalone`, icons 192/512).
- `GET /icons/icon-180.png|icon-192.png|icon-512.png` → static PNG icons.
- **Cast = reuse existing `/cast`** (no change): a result navigates to
  `/cast?id=…[&season&episode]`, which resolves the best 1080p stream, plays on the
  Deck, and serves the controller.

`createServer` gets injectable `discover` deps default to the real functions only if
needed; simplest is routes use the already-injectable `fetchFn`, so tests drive
Cinemeta via the `fetch` mock.

### Component 3 — controller + `/app` head (PWA install bits)

Shared `<head>` snippet on both `/app` and `controllerHtml`: viewport (`viewport-fit=cover`),
`<link rel="manifest" href="/manifest.webmanifest">`,
`apple-mobile-web-app-capable=yes`, `apple-mobile-web-app-status-bar-style=black-translucent`,
`apple-mobile-web-app-title=Deck`, `<link rel="apple-touch-icon" href="/icons/icon-180.png">`.
This keeps the controller standalone when reached from `/app`.

### Component 4 — icons

Add `addon/assets/icon-180.png`, `icon-192.png`, `icon-512.png` (dark bg + play glyph),
generated from a small SVG.

## Data flow

Open `/app` (standalone) → Popular rows load (`/api/catalog/popular`) → type a query →
`/api/search` → tap result. Movie → `/cast?id=…` → controller. Series → `/api/meta?id=…`
→ episode list → tap episode → `/cast?id=…&season&episode` → controller.

## Error handling

- Cinemeta down / non-200 → search & popular return `[]`; UI shows "No results"
  (best-effort, never throws the page).
- `/api/meta` for a bad id → 502 JSON; UI flashes "Couldn't load episodes".
- Empty query → empty list, no request.
- Cast errors are handled by the existing `/cast` route.

## Mobile-first

Constrained layout (max-width container, no wide stretch), dark theme matching the
controller, touch-sized tap targets, posters in a responsive grid.

## Testing (vitest, `addon/test/`)

New `addon/test/discover.test.js`:
- `cinemetaSearch` — mocked fetch returns movie + series metas → merged + normalized;
  `[]` on empty query; per-type failure tolerated.
- `cinemetaPopular` — normalized; `[]` on error.
- `cinemetaEpisodes` — normalized, season 0 dropped, sorted; episode/number fallback.

Extend `addon/test/server.test.js`:
- `GET /app` → 200 text/html containing the manifest link + search UI.
- `GET /manifest.webmanifest` → 200 JSON, `start_url:/app`, `display:standalone`.
- `GET /api/search?q=x` with a fetch mock → JSON results.
- `GET /api/meta?id=…` with a fetch mock → episode JSON.

## Files

- **New:** `addon/src/discover.js`, `addon/test/discover.test.js`,
  `addon/assets/icon-{180,192,512}.png`.
- **Modify:** `addon/src/server.js` (routes + `discoverHtml` + manifest/icons + shared
  PWA head on the controller).
- **Reuse (unchanged):** `/cast`, controller, resolver, `/get_subtitles`.

## Non-Goals

Account/library/continue-watching, other addons, full discovery, offline service
worker (not needed — app requires the live Deck; over the existing HTTPS a SW could be
added later for web push, but notifications are better served by ntfy).
