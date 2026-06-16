# Get English Subtitles (Controller Feature)

**Date:** 2026-06-16
**Status:** Design approved (user approved build 2026-06-16)

## Why

Many torrent streams have **no embedded subtitle track** (e.g. Korean-language films
like *I Saw the Devil*, *A Tale of Two Sisters*; or English films the user wants subs
on). Today the only way to get subtitles onto such a stream is a manual operator
dance — search OpenSubtitles by IMDb id, download the `.gz`, gunzip, strip spam
ad-lines, `scp` to the Deck, and POST the shell's `/sub_add`. This has been done by
hand 4+ times. This feature puts that one tap away in the existing phone controller.

## Goal

A button in the Stremio controller that **appears only when the current playback has
no English subtitle track**, and on tap fetches the best full English subtitle from
OpenSubtitles (by IMDb id) and loads it into the live mpv via the existing
`/sub_add` route — English-only, auto-picking the best match, one tap.

## Decisions (locked during brainstorming)

| Question | Decision |
|---|---|
| Trigger / UX | **Conditional** — button shown only when no English sub track is present |
| Language | **English only** |
| Selection | **Auto-pick best** (most-downloaded full English `srt` for the release) |
| Subtitle source | OpenSubtitles **legacy REST API** (`rest.opensubtitles.org`), no API key |

## Architecture

Three layers, mirroring the existing addon → shell split:

```
controller (phone)            addon (:7000)                       shell (:7001)
  detects "no English sub"      POST /get_subtitles {id,type}        POST /sub_add {url}
  shows button  ── tap ───────► subtitleFetch.fetchEnglishSub() ──►  mpv sub-add <path> select
  re-polls /state ◄── {ok} ─────┘  (query→pick→download→clean→cache)
```

### Component 1 — `addon/src/subtitleFetch.js` (new, the reusable core)

Pure-ish functions plus one orchestrator; HTTP and fs are injectable for tests.

- `buildQueryUrl({ imdbId, season, episode })` → OpenSubtitles legacy REST search URL.
  - Movie: `https://rest.opensubtitles.org/search/imdbid-<digits>/sublanguageid-eng`
  - Series: `.../imdbid-<digits>/season-<s>/episode-<e>/sublanguageid-eng`
  - `imdbId` is the numeric part of a `tt#######` id (strip the `tt`).
- `pickBest(results)` → from the JSON array: keep `SubFormat === 'srt'`, **drop entries
  whose `MovieReleaseName` contains "foreign parts only"** (case-insensitive), sort by
  numeric `SubDownloadsCnt` descending, return the top entry (or `null`).
- `cleanSrt(text)` → split into cue blocks on blank lines; drop any block whose text
  contains a known ad marker (`osdb.link`, `opensubtitles`, `watch online movies`,
  `do you want subtitles for any video`, `subtitles by`/`subtitles ßy`); renumber the
  surviving cues sequentially; return the cleaned SRT string. (This is the exact
  cleaner refined by hand this session.)
- `fetchEnglishSub({ imdbId, season, episode }, deps)` (orchestrator) →
  1. **Cache check:** if `<cacheDir>/<cacheKey>.en.srt` exists, return its path (no network).
     `cacheKey` = `tt#######` for movies, `tt#######_S<season>E<episode>` for episodes.
  2. Else: GET `buildQueryUrl(...)` (User-Agent `TemporaryUserAgent`), JSON-parse,
     `pickBest`. If none → throw `NoSubtitlesError`.
  3. GET the winner's `SubDownloadLink` (gzip), gunzip (node `zlib`), decode as
     UTF-8 stripping a BOM.
  4. `cleanSrt`, write to `<cacheDir>/<cacheKey>.en.srt`, return the path.
  - `deps`: `{ fetch, gunzip, cacheDir }` injected (cacheDir default `~/stremio-subs`).
  - `cacheDir` is created if missing.

### Component 2 — `addon/src/server.js` route `POST /get_subtitles`

- Body/query: `{ id, type }` where `id` is the Stremio meta id (`tt#######` or
  `tt#######:season:episode`); `type` is `movie`/`series` (advisory only — parsing the
  id determines movie-vs-episode).
- Parse `id`: split on `:` → `[ttId, season, episode]`. Strip `tt` → digits for `imdbId`.
- Call `fetchEnglishSub`. On success, POST the returned path to the shell:
  `fetchFn(\`http://${shellHost}/sub_add\`, { method:'POST', json:{ url: path } })`
  (same `fetchFn`/`shellHost` pattern as the other proxy routes).
- Respond `{ ok: true }`, or `{ ok: false, reason }` with HTTP 502/404 on failure
  (`NoSubtitlesError` → 404 `"no English subtitles found"`; network/shell error → 502).
- If `id` is missing/unparseable (e.g. a `cast_local` file with no meta id): respond
  `{ ok:false, reason:'no-id' }` — the controller won't show the button in that case
  anyway (see Component 3).

### Component 3 — controller (`controllerHtml` in `addon/src/server.js`)

- Pass the content identity into `controllerHtml(title, metaDeepLink, metaId, type)`.
  `metaId`/`type` are extracted from the `/cast` handler's `id` param; `null` for
  `cast_local`/`/control` renders. Embed as JS consts `META_ID`, `CONTENT_TYPE`.
- Add a hidden button: `<button id="btn-getsubs" class="hidden">⬇ Get English subtitles</button>`.
- In the existing `/state` poll handler, compute `hasEnglishSub` from `track_list`:
  any track with `type === 'sub'` for which **any** of `lang`, `title`, or
  `external-filename` matches `/english|\beng\b|\ben\b|\.en\.srt$/i`. The
  `\.en\.srt$` clause is what matches the files this feature writes
  (`<key>.en.srt`), so the button hides after a successful load; the `lang`/`eng`
  clauses catch real embedded English tracks. Show the button when **`META_ID` is
  set AND there is no English sub track**; hide it otherwise (no id, or an English
  sub already present).
- On tap: disable button, flash "Fetching subtitles…", `POST /get_subtitles` with
  `META_ID`/`CONTENT_TYPE`. On `{ok:true}` → flash "Subtitles loaded" and force a
  `/state` re-poll (the new external sub appears as an English track → button hides).
  On failure → flash the reason ("No English subtitles found"), re-enable button.

### Component 4 — shell `/sub_add` (already exists, no change)

Already added this session: `POST /sub_add {url}` → mpv `sub-add <url> select`.
Accepts a local file path (addon and shell share the distrobox `$HOME`, so the
`~/stremio-subs/...` path written by the addon is readable by the shell's libmpv).

## Data Flow

1. Controller polls `/state`; sees no English sub + a known `META_ID` → shows button.
2. User taps → `POST /get_subtitles {id,type}`.
3. addon `fetchEnglishSub`: cache hit → path; else query→pick→download→clean→cache→path.
4. addon POSTs path to shell `/sub_add` → mpv loads + selects the sub.
5. Controller re-polls `/state` → English external track present → button hides.

## Error Handling

- **No results** → 404 `{ok:false, reason:'no English subtitles found'}` → button stays,
  flash message.
- **OpenSubtitles network error / rate-limit / non-200** → 502 `{ok:false}`; same UX.
- **Shell `/sub_add` fails** → 502 `{ok:false, reason:'player unreachable'}`.
- **Unparseable / missing id** → `{ok:false, reason:'no-id'}` (button not shown anyway).
- **Series id** (`tt..:s:e`) parsed to season/episode for the query.
- A bad/desynced auto-pick is accepted for this version (manual sub-delay tuning is
  future work; not in scope).

## Caching

Fetched subs are written to `~/stremio-subs/<cacheKey>.en.srt` and reused on repeat
(instant, offline, and survives the mpv "external subs dropped on reload" limitation —
re-tapping after a re-cast is a cache hit). The session's existing manual files can be
migrated/renamed into this dir but that is optional.

## Testing (vitest, `addon/test/`)

New `addon/test/subtitleFetch.test.js`:
- `buildQueryUrl` — movie URL and series URL (season/episode) formatting; `tt` stripped.
- `pickBest` — excludes non-srt; excludes "Foreign parts only"; picks highest
  `SubDownloadsCnt`; returns `null` on empty.
- `cleanSrt` — strips each ad-marker variant; renumbers cues; preserves real cues/timing.
- `fetchEnglishSub` — with mocked `fetch`/`gunzip`/tmp `cacheDir`: cache-miss path
  (writes file, returns path) and cache-hit path (no network call); throws on no results.

Extend `addon/test/server.test.js`:
- `POST /get_subtitles` happy path: mocked `fetchEnglishSub` + `fetchFn`; asserts it
  POSTs `/sub_add` with the path and returns `{ok:true}`.
- failure path: `NoSubtitlesError` → 404 `{ok:false}`; missing id → `no-id`.

## Files

- **New:** `addon/src/subtitleFetch.js`, `addon/test/subtitleFetch.test.js`.
- **Modify:** `addon/src/server.js` (route `/get_subtitles`; `controllerHtml` button +
  detection + pass `metaId`/`type`; `/cast` passes id/type).
- **Reuse (already present):** shell `/sub_add` (`shell/src/lan_remote.rs`,
  `shell/src/app/imp.rs`).

## Non-Goals / Risk

- Non-English languages, a language picker, a choose-from-list UI — out of scope (YAGNI).
- Sub-delay / re-sync controls — future work.
- **Risk:** the legacy `rest.opensubtitles.org` API is unauthenticated but
  rate-limited and semi-deprecated; it has worked reliably 4× this session. If it
  degrades, the fallback is the `opensubtitles.com` REST API (free API key) — a
  drop-in change behind `buildQueryUrl`/`fetchEnglishSub`. Start with the legacy API
  (zero config).
