# Action Shapes

Captured 2026-05-14 from Stremio 5.0.0-beta.36 (stremio-linux-shell v1.0.0-beta.13) running on SteamDeck via our injected bootstrap.

## Transport architecture

stremio-core-web runs in a **Web Worker** at `<hash>/scripts/worker.js`. Main thread → worker communication is JSON-RPC over `postMessage`:

```
worker.postMessage({
  request: {
    id: <random_string>,
    path: [<method>, <subpath?>...],
    args: [...]
  }
});
```

Responses go back via `self.postMessage` inside the worker:

```
self.postMessage({
  response: { id: <matching_id>, result: { data: <opaque> } }
});
```

Common `path` values observed:
- `["init"]` — initial handshake (main → worker), args: `[{appVersion, shellVersion}]`
- `["dispatch"]` — dispatch a stremio-core action, args: `[action, field, locationHash]`
- `["getState"]` — read a state model, args: `[field_name]`
- `["analytics"]` — analytics events, args: `[event, locationHash]`
- `["localStorage", "getItem"]` / `["localStorage", "setItem"]` — worker → main, asking main thread for browser storage

## Dispatch action shapes

### Search

Triggered by typing in the search bar. Fires once per keystroke (debounced internally).

```json
{
  "action": "Search",
  "args": {
    "action": "Search",
    "args": {
      "searchQuery": "inception",
      "maxResults": 5
    }
  }
}
```

Full dispatch call: `dispatch(<above>, null, "#/search")`

### Load MetaDetails

Triggered by clicking a search result or library item.

```json
{
  "action": "Load",
  "args": {
    "model": "MetaDetails",
    "args": {
      "metaPath": {
        "resource": "meta",
        "type": "movie",
        "id": "tt1375666",
        "extra": []
      },
      "streamPath": {
        "resource": "stream",
        "type": "movie",
        "id": "tt1375666",
        "extra": []
      },
      "guessStream": true
    }
  }
}
```

For series with episode:
- `metaPath.type: "series"`, `metaPath.id: "tt1190634"`
- `streamPath.type: "series"`, `streamPath.id: "tt1190634:1:1"` (id:season:episode)
- `streamPath` may be `null` when entering the meta page without selecting an episode

Full dispatch call: `dispatch(<above>, "meta_details", "#/detail/<type>/<imdb_id>")`

### Load Player

Triggered by clicking a stream entry.

```json
{
  "action": "Load",
  "args": {
    "model": "Player",
    "args": {
      "stream": {
        "infoHash": "66672b822002b6f19af478fb7c886787afee5f9f",
        "fileIdx": 91,
        "announce": [],
        "name": "Torrentio\n1080p",
        "description": "Imdb top 263 movies ..."
      }
      // Additional fields (streamPath, metaPath, videoId, subtitlesPath, videoParams)
      // are present but were truncated by our log preview cap.
      // The locationHash encodes the full player state as URL-encoded base64-zlib JSON.
    }
  }
}
```

Full dispatch call: `dispatch(<above>, "player", "#/player/<url-encoded base64-zlib(json)>")`

**Important caveat:** Stremio's locationHash for the player is a serialized form of the entire player state (the `eAE...` prefix indicates zlib `0x78 0x01` magic bytes, base64-encoded, URL-encoded). For first-cut casting we will try dispatching with an empty `locationHash` and let stremio-core compute it internally; if the player UI fails to update, we may need to implement the same encode flow on the addon side.

For streams sourced from non-torrent URLs (HTTP direct), the stream object likely uses `url` instead of `infoHash`/`fileIdx`. Capture pending.

## Ctx side-effects (observed on startup, for reference)

These don't matter for casting but help understand the action enum surface:

- `{"action": "Ctx", "args": {"action": "PullAddonsFromAPI"}}`
- `{"action": "Ctx", "args": {"action": "PullUserFromAPI", "args": {}}}`
- `{"action": "Ctx", "args": {"action": "SyncLibraryWithAPI"}}`
- `{"action": "Ctx", "args": {"action": "PullNotifications"}}`
- `{"action": "Ctx", "args": {"action": "GetEvents"}}`
- `{"action": "Unload"}` — reset a field (sent with `field` = which model to unload)

## Open questions

1. Full Player Load `args` shape beyond `stream` — needs longer-preview capture or DevTools inspection. Likely fields: `streamPath`, `metaPath`, `videoId`, `subtitlesPath`, `videoParams`.
2. Whether `dispatch(Load(Player), "player", "")` (empty locationHash) successfully transitions the UI — to be tested in Task 14 / 16.
3. The HTTP-direct stream variant — captured shapes are torrent (`infoHash`/`fileIdx`) only.
