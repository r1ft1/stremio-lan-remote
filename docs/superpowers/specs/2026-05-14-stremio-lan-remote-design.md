# Stremio LAN Remote — Design

**Date:** 2026-05-14
**Target:** Stremio v5+ desktop on SteamDeck (Linux, Flatpak), controlled from Stremio Android/iOS over LAN.

## Goal

A phone running Stremio mobile drives a desktop Stremio instance over LAN: search, browse meta details, pick season/episode, pick a stream, start playback on the desktop. Zero clicks required on the desktop side.

## Non-goals (v1)

- Showing on the phone what the desktop is currently displaying
- Multi-desktop support from one phone
- Letting the phone-side Stremio addons (rather than the desktop's) drive the resolved stream URL
- Windows/macOS desktop support

## Why this isn't a pure addon

The Stremio addon protocol is pull-only. Addons respond to HTTP requests from clients with JSON (catalogs, metas, streams) and have no callback into the client. A client only fetches when its user navigates somewhere. There is no documented Stremio API for a third party to push navigation or playback commands to a running Stremio instance — and the feature request to add HTTP control was closed wontfix by Stremio maintainers in 2024. So driving the desktop Stremio UI requires code running inside the desktop process. An addon alone cannot do it.

## Why a fork instead of a patcher script

Stremio loads its UI from a remote URL at runtime (v5: `http://127.0.0.1:11470/proxy/d=https%3A%2F%2Fweb.stremio.com/` via the local streaming server; v4: `https://app.strem.io/shell-v<ver>/`). There is no `stremio-web` bundle on disk to modify. A "patcher script" against stock Stremio would need a runtime injection path (Web Inspector attach, LD_PRELOAD, etc.) — these are all fragile, undocumented, and add a persistent companion service to the user's system. Forking the open-source `stremio-linux-shell` and adding a tiny patch is cleaner: less code, fewer moving parts, clearer failure modes, straightforward CI.

Users install our Flatpak instead of stock Stremio. Our fork tracks upstream releases.

## Architecture

Three components, all running on the SteamDeck:

```
Phone (LAN) — Stremio mobile app
   ↓ HTTP (Stremio addon protocol)
   ↓
SteamDeck
├── Node SDK addon (port 7000, LAN-bound)
│     manifest, stream proxy, /cast endpoint
│        ↓ localhost HTTP
├── Forked stremio-linux-shell
│     localhost command server (port 7001)
│     inject_script: bootstrap.js at document-start
│        ↓ WebKitGTK evaluate_script
└── WebKitGTK ─ stremio-web (loaded from web.stremio.com)
        bootstrap.js dispatches into stremio-core-web
```

## Component 1: forked `stremio-linux-shell`

Source: https://github.com/Stremio/stremio-linux-shell

The patch is intentionally small to minimize rebase pain:

1. **`include_str!("../bootstrap.js")`** registered as a `UserScript` on the `UserContentManager`, injection time `Start`, top frame only.
2. **New module `src/lan_remote.rs`** — owns the localhost-only command server (axum or tiny-http on `127.0.0.1:7001`). Accepts `POST /dispatch` with a JSON body. Forwards to the main thread via a channel.
3. **Wiring in `main.rs`** — on a `/dispatch` message, call `webview.evaluate_javascript(format!("window.__lanRemote.cmd({})", json))`.

The diff against upstream files (steps 1 and 3) is comment-free to keep rebase hunks minimal. Step 2 is a new file we own; comments inside it are unrestricted.

Build artifact: a Flatpak with a distinct app ID (e.g., `dev.<owner>.StremioLANRemote`). Updates ship as new Flatpak builds on a GitHub Releases feed.

## Component 2: `bootstrap.js`

Single IIFE injected at document-start of every page load. Two responsibilities:

1. Capture the `stremio-core-web` WASM dispatch function as the module loads. The capture mechanism hooks both `WebAssembly.instantiate` and `WebAssembly.instantiateStreaming` to grab `instance.exports.dispatch` and `getState` regardless of which loader stremio-web uses.
2. Expose `window.__lanRemote.cmd(json)` for the shell to call. `cmd` parses the JSON and forwards `(action, field, locationHash)` into the captured dispatch.

```javascript
(function () {
  const origInstantiate = WebAssembly.instantiate;
  const origInstantiateStreaming = WebAssembly.instantiateStreaming;

  function capture(instance) {
    if (instance?.exports?.dispatch) {
      window.__lanRemote = window.__lanRemote || {};
      window.__lanRemote.dispatch = instance.exports.dispatch;
      window.__lanRemote.getState = instance.exports.getState;
    }
  }

  WebAssembly.instantiate = async function (...args) {
    const result = await origInstantiate.apply(this, args);
    capture(result.instance || result);
    return result;
  };

  WebAssembly.instantiateStreaming = async function (...args) {
    const result = await origInstantiateStreaming.apply(this, args);
    capture(result.instance || result);
    return result;
  };

  window.__lanRemote = window.__lanRemote || {};
  window.__lanRemote.cmd = function (json) {
    const { action, field, locationHash } = JSON.parse(json);
    return window.__lanRemote.dispatch(action, field || "", locationHash || "");
  };
})();
```

A third fallback (probe for a discoverable global like `window.core`) can be added if the WASM hooks miss in a future stremio-web build.

## Component 3: Node SDK addon

Standard `stremio-addon-sdk` server. Single Node process, runs on the Deck alongside the shell, binds `0.0.0.0:7000`.

Endpoints:

- `GET /manifest.json` — declares `streams` resource for `movie` and `series` types. No catalogs in v1.
- `GET /stream/:type/:id` — returns a single entry, `📺 Cast to Deck`, whose URL points at `/cast`. v1 does not enumerate or proxy upstream results; the cast endpoint resolves "best stream" server-side at tap time.
- `GET /cast?id=<imdb>&season=<n>&episode=<n>` — non-SDK side endpoint hit by the phone when the user taps "Cast to Deck." Resolves the stream URL using the same upstream provider, builds the `Load(Player(PlayerSelected{...}))` action JSON, `POST`s to `127.0.0.1:7001/dispatch`, and responds to the phone with a tiny placeholder MP4 so the mobile player doesn't error.

Environment configuration:

- `STREAM_RESOLVER_URL` — upstream addon manifest URL (e.g., Torrentio)
- `SHELL_HOST` — defaults to `127.0.0.1:7001`
- `BIND` — defaults to `0.0.0.0:7000`

Distribution: shipped as a Node module with a systemd `--user` unit. The Flatpak does not bundle the addon — keeps the shell patch and the addon as independently versioned, independently restartable units.

## Phone-side install

Phone user opens Stremio mobile, adds addon by URL: `http://<deck-lan-ip>:7000/manifest.json`. The deck's IP is the device identifier — no discovery service needed.

## Cast walkthrough

1. Phone user opens Stremio, navigates to an episode via their normal addons.
2. Stream list shows the usual results plus one extra entry from our addon: `📺 Cast to Deck`.
3. User taps. Phone Stremio fetches `http://<deck-ip>:7000/cast?id=tt0903747&season=2&episode=3`.
4. Addon resolves the best stream from the upstream provider.
5. Addon `POST`s a `Load(Player(...))` action to `127.0.0.1:7001/dispatch` on the deck shell.
6. Shell calls `webview.evaluate_javascript("window.__lanRemote.cmd(...)")`.
7. `bootstrap.js` forwards to `stremio-core-web`'s `dispatch`. UI on the Deck transitions to the player.
8. Addon returns a placeholder MP4 to the phone. Phone briefly shows "Casting" then idles.

## Action dispatch encoding

The `stremio-core-web` `dispatch(action, field, locationHash)` function (defined at `stremio-core/stremio-core-web/src/stremio_core_web.rs:182`) takes serde-deserialized `JsValue` args. Action enum is at `stremio-core/src/runtime/msg/action.rs`. Relevant variants for v1:

- `Action::Search { search_query, max_results }` — opens search UI with results
- `Action::Load(ActionLoad::MetaDetails(...))` — opens meta page
- `Action::Load(ActionLoad::Player(Box<PlayerSelected>))` — starts playback

The exact serde JSON shape of the wrapper (tagged vs untagged, `{"Load":...}` vs flat) is unverified at design time. First implementation step is capturing a real round-trip from a running Stremio v5 instance to confirm. The CI smoke test then locks in that shape per release.

## CI / nightly compatibility test

`.github/workflows/upstream-compat.yml`, runs nightly at 04:00 UTC, plus on `workflow_dispatch`.

Steps on an `ubuntu-latest` runner:

1. Checkout this repo.
2. Rebase our patch branch onto `upstream/main` of `Stremio/stremio-linux-shell`. On conflict: open/update an issue with the conflict diff, fail the job.
3. `apt install flatpak flatpak-builder xvfb dbus`. Install the GNOME platform runtime.
4. `flatpak-builder` our fork.
5. Launch Stremio under Xvfb (`Xvfb :99 & DISPLAY=:99 flatpak run dev.<owner>.StremioLANRemote`).
6. Wait for `localhost:7001` to bind (proves shell started and our LAN remote module is alive).
7. Wait for a "bootstrap loaded" log emitted by `bootstrap.js` (proves WebKitGTK injection still works).
8. Run a smoke-test sequence:
   - dispatch `Search("inception")` → poll `getState("search")` → assert results model populated
   - dispatch `Load(MetaDetails, ...)` for a known title → assert meta_details state
   - dispatch `Load(Player, ...)` with a known stream URL → assert player state entered (no real playback assertion)
9. On failure: upload Xvfb screen capture, Stremio logs, and rebase diff as workflow artifacts. Open or update an issue titled `Patcher broken on Stremio v5.x.y`.
10. On success: commit updated `last-tested-version.txt` so the next run skips early if upstream hasn't moved.

Two distinct failure signals — rebase conflict vs. smoke test failure — are surfaced separately in the issue body so the maintainer knows whether upstream's Rust shell drifted or whether stremio-web's WASM/action surface changed.

## Distribution

- GitHub repo: forked shell branch, Node addon source, CI workflow, README.
- GitHub Releases: one `.flatpak` per upstream Stremio release we've successfully built+tested.
- README documents: install Flatpak, run/enable addon, install addon URL on phone.

## Risks and mitigations

1. **Dispatch hook misses a future loader path.** Mitigation: hook both `WebAssembly.instantiate` and `WebAssembly.instantiateStreaming` from day one; add a `window.core` global probe as a third fallback if needed.
2. **Action enum drift between Stremio releases.** Mitigation: action shapes live in one addon-side file with version tags. Nightly CI detects drift the day it ships.
3. **Phone Stremio's player behavior with placeholder MP4.** Needs real-device validation. Fallbacks: return `application/x-empty` 200, or accept a brief "load failed" toast on the phone as a known v1 quirk.
4. **WASM hook race.** The hook must install before `stremio-core-web` instantiates. WebKitGTK's `UserScriptInjectionTime::Start` runs before page scripts, so this should be safe; smoke test verifies.
5. **Flatpak app ID collision.** Use a distinct ID (`dev.<owner>.StremioLANRemote`) so users can have both stock Stremio and our fork installed if they want.

## Unverified items to confirm during implementation

- Exact serde JSON wrapper shape for `Action` variants (tagged enum keys).
- Exact field structure of `PlayerSelected` and `MetaDetailsSelected` (read from `stremio-core/src/models/*.rs` at implementation time).
- Whether the WASM dispatch handle is reachable via a discoverable global in current stremio-web (would simplify the bootstrap if yes; the WASM hook is robust either way).
- WebKitGTK headless behavior on `ubuntu-latest` runners — falls back to self-hosted runner (or SteamDeck itself) if compositing requirements break the smoke test.
