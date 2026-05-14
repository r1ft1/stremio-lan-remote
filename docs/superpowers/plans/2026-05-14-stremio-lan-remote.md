# Stremio LAN Remote Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Phone (Stremio mobile) can drive a SteamDeck Stremio v5+ instance over LAN — search, navigate, play — with zero clicks on the Deck.

**Architecture:** Fork `stremio-linux-shell` and add a single `inject_script` plus a localhost-only LAN command server. A separate Node addon (Stremio SDK) runs on the Deck, exposes a "Cast to Deck" stream entry to the phone, and forwards play commands to the shell which dispatches them into `stremio-core-web`.

**Tech Stack:** Rust (gtk4, webkit6, axum, tokio, serde_json), JavaScript (vanilla), Node.js + stremio-addon-sdk, Flatpak + flatpak-builder, GitHub Actions, systemd user units.

---

## Reference

Spec: `docs/superpowers/specs/2026-05-14-stremio-lan-remote-design.md`. Read it before starting Task 1.

Upstream repos:
- `https://github.com/Stremio/stremio-linux-shell` (the shell we fork)
- `https://github.com/Stremio/stremio-core` (action enum at `src/runtime/msg/action.rs`, dispatch entry at `stremio-core-web/src/stremio_core_web.rs`)
- `https://github.com/Stremio/stremio-addon-sdk`

---

## Task 1: Project scaffold

**Files:**
- Create: `/Users/j/Documents/programming/stremio-lan-remote/README.md`
- Create: `/Users/j/Documents/programming/stremio-lan-remote/LICENSE`
- Create: `/Users/j/Documents/programming/stremio-lan-remote/.gitignore`

- [ ] **Step 1: Initialize git in the project root**

```bash
cd /Users/j/Documents/programming/stremio-lan-remote
git init
git branch -M main
```

- [ ] **Step 2: Write `.gitignore`**

```
node_modules/
dist/
target/
*.flatpak
.flatpak-builder/
build-dir/
*.log
.DS_Store
```

- [ ] **Step 3: Write `LICENSE`** (MIT)

```
MIT License

Copyright (c) 2026

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.
```

- [ ] **Step 4: Stub `README.md`**

```markdown
# Stremio LAN Remote

Control a desktop Stremio v5+ instance (SteamDeck-focused) from Stremio mobile on the same LAN.

See `docs/superpowers/specs/2026-05-14-stremio-lan-remote-design.md` for the design.

Install instructions: TBD (filled in during Task 20).
```

- [ ] **Step 5: Commit**

```bash
git add .
git commit -m "scaffold project"
```

---

## Task 2: bootstrap module — WASM hook with tests

The bootstrap exports an `installBootstrap(window)` function. The injected JS in the WebKitGTK shell is a 1-liner that calls it; tests import the function directly. No `new Function(...)` dynamic eval.

**Files:**
- Create: `bootstrap/package.json`
- Create: `bootstrap/src/installBootstrap.js`
- Create: `bootstrap/src/injected.js`
- Create: `bootstrap/test/installBootstrap.test.js`

- [ ] **Step 1: Initialize npm project**

```bash
mkdir -p bootstrap/src bootstrap/test
cd bootstrap
npm init -y
npm install --save-dev vitest
```

Edit `bootstrap/package.json`:

```json
{
  "name": "stremio-lan-remote-bootstrap",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "test": "vitest run"
  },
  "devDependencies": {
    "vitest": "^1.0.0"
  }
}
```

- [ ] **Step 2: Write the failing test**

`bootstrap/test/installBootstrap.test.js`:

```javascript
import { describe, it, expect, vi } from 'vitest';
import { installBootstrap } from '../src/installBootstrap.js';

function fakeWindow() {
  return {
    WebAssembly: {
      instantiate: async () => ({ instance: { exports: { dispatch: () => {}, getState: () => {} } } }),
      instantiateStreaming: async () => ({ instance: { exports: { dispatch: () => {}, getState: () => {} } } }),
    },
  };
}

describe('installBootstrap WASM hook', () => {
  it('captures dispatch from WebAssembly.instantiate', async () => {
    const win = fakeWindow();
    installBootstrap(win);
    await win.WebAssembly.instantiate({}, {});
    expect(win.__lanRemote.dispatch).toBeDefined();
  });

  it('captures dispatch from WebAssembly.instantiateStreaming', async () => {
    const win = fakeWindow();
    installBootstrap(win);
    await win.WebAssembly.instantiateStreaming({}, {});
    expect(win.__lanRemote.dispatch).toBeDefined();
  });

  it('ignores instances without dispatch export', async () => {
    const win = fakeWindow();
    win.WebAssembly.instantiate = async () => ({ instance: { exports: {} } });
    installBootstrap(win);
    await win.WebAssembly.instantiate({}, {});
    expect(win.__lanRemote.dispatch).toBeUndefined();
  });

  it('still works if window has no instantiateStreaming', async () => {
    const win = fakeWindow();
    delete win.WebAssembly.instantiateStreaming;
    installBootstrap(win);
    await win.WebAssembly.instantiate({}, {});
    expect(win.__lanRemote.dispatch).toBeDefined();
  });
});
```

- [ ] **Step 3: Run the test, verify failure**

```bash
cd bootstrap && npx vitest run
```

Expected: FAIL (module not found).

- [ ] **Step 4: Write `bootstrap/src/installBootstrap.js`**

```javascript
export function installBootstrap(window) {
  const WA = window.WebAssembly;
  const origInstantiate = WA.instantiate;
  const origInstantiateStreaming = WA.instantiateStreaming;

  window.__lanRemote = window.__lanRemote || {};

  function capture(result) {
    const instance = result && (result.instance || result);
    if (instance && instance.exports && typeof instance.exports.dispatch === 'function') {
      window.__lanRemote.dispatch = instance.exports.dispatch;
      window.__lanRemote.getState = instance.exports.getState;
    }
  }

  WA.instantiate = async function (...args) {
    const result = await origInstantiate.apply(this, args);
    capture(result);
    return result;
  };

  if (typeof origInstantiateStreaming === 'function') {
    WA.instantiateStreaming = async function (...args) {
      const result = await origInstantiateStreaming.apply(this, args);
      capture(result);
      return result;
    };
  }
}
```

- [ ] **Step 5: Run tests, verify pass**

```bash
npx vitest run
```

Expected: 4 tests pass.

- [ ] **Step 6: Commit**

```bash
cd .. && git add bootstrap/
git commit -m "bootstrap: capture stremio-core-web dispatch via WASM instantiate hook"
```

---

## Task 3: bootstrap — cmd dispatcher

**Files:**
- Modify: `bootstrap/src/installBootstrap.js`
- Modify: `bootstrap/test/installBootstrap.test.js`

- [ ] **Step 1: Add failing test**

Append to `bootstrap/test/installBootstrap.test.js`:

```javascript
describe('cmd dispatcher', () => {
  it('forwards parsed action to captured dispatch', async () => {
    const win = fakeWindow();
    const dispatch = vi.fn();
    win.WebAssembly.instantiate = async () => ({ instance: { exports: { dispatch, getState: () => {} } } });
    installBootstrap(win);
    await win.WebAssembly.instantiate({}, {});

    win.__lanRemote.cmd(JSON.stringify({
      action: { Search: { search_query: 'foo', max_results: 10 } },
      field: '',
      locationHash: '#/search',
    }));

    expect(dispatch).toHaveBeenCalledWith(
      { Search: { search_query: 'foo', max_results: 10 } },
      '',
      '#/search',
    );
  });

  it('throws if cmd is called before dispatch is captured', () => {
    const win = fakeWindow();
    installBootstrap(win);
    expect(() => win.__lanRemote.cmd('{"action":{}}')).toThrow();
  });
});
```

- [ ] **Step 2: Run tests, verify failure**

```bash
cd bootstrap && npx vitest run
```

- [ ] **Step 3: Implement `cmd`**

In `bootstrap/src/installBootstrap.js`, before the function's closing brace:

```javascript
  window.__lanRemote.cmd = function (json) {
    if (!window.__lanRemote.dispatch) {
      throw new Error('lan-remote: dispatch not captured yet');
    }
    const { action, field, locationHash } = JSON.parse(json);
    return window.__lanRemote.dispatch(action, field || '', locationHash || '');
  };
```

- [ ] **Step 4: Run tests, verify pass**

```bash
npx vitest run
```

- [ ] **Step 5: Commit**

```bash
cd .. && git add bootstrap/
git commit -m "bootstrap: cmd dispatcher routes JSON to captured dispatch"
```

---

## Task 4: Build the injected bundle

The shell needs a single self-contained `.js` file to `include_str!`. We bundle `installBootstrap.js` + a 1-line invocation into `dist/injected.js`.

**Files:**
- Create: `bootstrap/src/entry.js`
- Create: `bootstrap/build.js`
- Modify: `bootstrap/package.json`

- [ ] **Step 1: Write the entry**

`bootstrap/src/entry.js`:

```javascript
import { installBootstrap } from './installBootstrap.js';
installBootstrap(globalThis);
console.log('LANREMOTE_BOOT', new Date().toISOString());
```

The `LANREMOTE_BOOT` log line is permanent — the smoke test depends on it (Task 18).

- [ ] **Step 2: Add esbuild for bundling**

```bash
cd bootstrap
npm install --save-dev esbuild
```

- [ ] **Step 3: Write the build script**

`bootstrap/build.js`:

```javascript
import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';

await mkdir('dist', { recursive: true });
await build({
  entryPoints: ['src/entry.js'],
  bundle: true,
  format: 'iife',
  target: 'es2020',
  outfile: 'dist/injected.js',
  minify: false,
});
console.log('built dist/injected.js');
```

- [ ] **Step 4: Wire build into package.json**

```json
{
  "scripts": {
    "test": "vitest run",
    "build": "node build.js"
  }
}
```

- [ ] **Step 5: Run build, verify output**

```bash
node build.js
test -f dist/injected.js && echo OK
```

- [ ] **Step 6: Commit**

```bash
cd .. && git add bootstrap/
git commit -m "bootstrap: bundle entry into dist/injected.js"
```

---

## Task 5: Fork stremio-linux-shell and reproduce upstream build

**Files:**
- Create: `shell/` (subtree)

- [ ] **Step 1: Add upstream as a subtree**

```bash
cd /Users/j/Documents/programming/stremio-lan-remote
git remote add stremio-upstream https://github.com/Stremio/stremio-linux-shell.git
git fetch stremio-upstream
git subtree add --prefix=shell stremio-upstream main --squash
```

- [ ] **Step 2: Install build dependencies on a Linux dev box**

```bash
sudo apt update
sudo apt install -y \
  build-essential pkg-config \
  libgtk-4-dev libwebkitgtk-6.0-dev libmpv-dev \
  flatpak flatpak-builder \
  cargo rustc
flatpak remote-add --user --if-not-exists flathub https://flathub.org/repo/flathub.flatpakrepo
flatpak install --user -y flathub org.gnome.Platform//50 org.gnome.Sdk//50
```

(On macOS dev: skip — Flatpak is Linux-only. Use a Linux VM or CI for shell work.)

- [ ] **Step 3: Locate the upstream Flatpak manifest**

```bash
ls shell/flatpak/
```

Note the actual filename — likely `com.stremio.Stremio.json` or similar. Call it `UPSTREAM_MANIFEST` for the rest of the task.

- [ ] **Step 4: Verify upstream Flatpak builds clean**

```bash
cd shell
flatpak-builder --user --install --force-clean build-dir flatpak/<UPSTREAM_MANIFEST>
```

Expected: completes with no errors. `flatpak run com.stremio.Stremio` opens upstream Stremio.

The subtree-add already created a commit. Nothing to commit here.

---

## Task 6: Inject the bundled bootstrap at document-start

**Files:**
- Copy: `bootstrap/dist/injected.js` → `shell/src/injected.js`
- Modify: the WebKitGTK webview setup file in `shell/src/`

- [ ] **Step 1: Build the bootstrap and copy into shell**

```bash
cd bootstrap && node build.js
cp dist/injected.js ../shell/src/injected.js
```

- [ ] **Step 2: Find the WebKitGTK setup site**

```bash
cd /Users/j/Documents/programming/stremio-lan-remote
grep -rn "register_script_message_handler\|UserContentManager" shell/src/
```

Note the file path and line. Call it `WEBVIEW_FILE`.

- [ ] **Step 3: Patch `WEBVIEW_FILE` to add the user script**

Inside the function that builds the `UserContentManager`, after the existing handler registrations, insert:

```rust
let user_script = webkit::UserScript::new(
    include_str!("../../src/injected.js"),
    webkit::UserContentInjectedFrames::TopFrame,
    webkit::UserScriptInjectionTime::Start,
    &[],
    &[],
);
content_manager.add_script(&user_script);
```

Adjust the `include_str!` path so it resolves to `shell/src/injected.js` from wherever `WEBVIEW_FILE` lives. (If `WEBVIEW_FILE` is `shell/src/app/webview/imp.rs`, the path is `"../../injected.js"`.)

Keep the patch comment-free for clean rebases (per the design doc).

- [ ] **Step 4: Rebuild the Flatpak**

```bash
cd shell
flatpak-builder --user --install --force-clean build-dir flatpak/<UPSTREAM_MANIFEST>
```

- [ ] **Step 5: Smoke check — does Stremio launch and log the boot marker?**

```bash
flatpak run com.stremio.Stremio 2>&1 | tee /tmp/stremio.log &
sleep 5
grep LANREMOTE_BOOT /tmp/stremio.log
kill %1
```

Expected: a `LANREMOTE_BOOT ...` line appears in the log.

- [ ] **Step 6: Commit**

```bash
cd ..
git add shell/src/injected.js shell/src/
git commit -m "shell: inject lan-remote bootstrap at document-start"
```

---

## Task 7: Action shape discovery via temporary logging

Purpose: capture the real serde JSON shapes for `Search`, `Load(MetaDetails)`, and `Load(Player)` from a running Stremio v5. The shapes are then locked into the addon's `dispatchEncoder` and the CI smoke test fixtures.

**Files:**
- Modify: `bootstrap/src/installBootstrap.js` (temporary)
- Create: `docs/action-shapes.md`

- [ ] **Step 1: Wrap dispatch with a logger (temporary)**

Edit `installBootstrap.js`'s `capture` function:

```javascript
function capture(result) {
  const instance = result && (result.instance || result);
  if (instance && instance.exports && typeof instance.exports.dispatch === 'function') {
    const realDispatch = instance.exports.dispatch;
    window.__lanRemote.dispatch = function (action, field, locationHash) {
      console.log('LANREMOTE_DISPATCH', JSON.stringify({ action, field, locationHash }));
      return realDispatch.call(this, action, field, locationHash);
    };
    window.__lanRemote.getState = instance.exports.getState;
  }
}
```

- [ ] **Step 2: Rebuild bundle, copy into shell, rebuild Flatpak**

```bash
cd bootstrap && node build.js
cp dist/injected.js ../shell/src/injected.js
cd ../shell
flatpak-builder --user --install --force-clean build-dir flatpak/<UPSTREAM_MANIFEST>
flatpak run com.stremio.Stremio 2>&1 | tee /tmp/dispatch.log
```

- [ ] **Step 3: Exercise the three flows manually**

In the running Stremio window:
1. Type a query in search. Note `LANREMOTE_DISPATCH` log lines.
2. Click into a search result (meta details). Note dispatches.
3. Click an episode, click a stream, watch playback start. Note dispatches.

- [ ] **Step 4: Document captured shapes**

Create `docs/action-shapes.md`. For each flow, paste the exact JSON from the log. Example skeleton:

```markdown
# Action Shapes

Captured from Stremio v5.x.y on 2026-MM-DD.

## Search

Triggered by typing in the search bar.

```json
<paste real log line here>
```

## Load(MetaDetails)

Triggered by clicking a result.

```json
<paste real log line here>
```

## Load(Player)

Triggered by clicking a stream.

```json
<paste real log line here>
```
```

- [ ] **Step 5: Revert temporary logging**

```bash
cd /Users/j/Documents/programming/stremio-lan-remote
git checkout bootstrap/src/installBootstrap.js
cd bootstrap && node build.js
cp dist/injected.js ../shell/src/injected.js
```

- [ ] **Step 6: Commit captured shapes**

```bash
cd ..
git add docs/action-shapes.md shell/src/injected.js
git commit -m "docs: capture stremio-core-web action JSON shapes"
```

---

## Task 8: lan_remote module — axum server

**Files:**
- Create: `shell/src/lan_remote.rs`
- Modify: `shell/Cargo.toml`
- Create or modify: `shell/src/lib.rs`
- Modify: `shell/src/main.rs`
- Create: `shell/tests/lan_remote.rs`

- [ ] **Step 1: Add dependencies**

In `shell/Cargo.toml` under `[dependencies]`:

```toml
axum = "0.7"
tokio = { version = "1", features = ["rt-multi-thread", "macros", "sync"] }
serde_json = "1"
```

Under `[dev-dependencies]`:

```toml
reqwest = { version = "0.12", features = ["json"] }
```

- [ ] **Step 2: Write the module**

`shell/src/lan_remote.rs`:

```rust
use axum::{extract::State, http::StatusCode, routing::post, Json, Router};
use serde_json::Value;
use std::net::SocketAddr;
use tokio::sync::mpsc::Sender;

#[derive(Clone)]
pub struct AppState {
    pub tx: Sender<String>,
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/dispatch", post(dispatch))
        .with_state(state)
}

async fn dispatch(State(state): State<AppState>, Json(body): Json<Value>) -> StatusCode {
    match state.tx.send(body.to_string()).await {
        Ok(_) => StatusCode::ACCEPTED,
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

pub async fn serve(addr: SocketAddr, tx: Sender<String>) -> std::io::Result<()> {
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, router(AppState { tx })).await
}
```

- [ ] **Step 3: Expose the module via lib.rs**

If `shell/src/lib.rs` doesn't exist, create it. If it does, add the module:

```rust
pub mod lan_remote;
```

In `shell/src/main.rs`, ensure the crate name matches (look at `Cargo.toml` `[package] name`) and use:

```rust
use <crate_name>::lan_remote;
```

- [ ] **Step 4: Write integration test**

`shell/tests/lan_remote.rs`:

```rust
use tokio::sync::mpsc;

#[tokio::test]
async fn dispatch_forwards_json_to_channel() {
    let (tx, mut rx) = mpsc::channel::<String>(8);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let bound = listener.local_addr().unwrap();
    let app = stremio_linux_shell::lan_remote::router(
        stremio_linux_shell::lan_remote::AppState { tx },
    );
    tokio::spawn(async move {
        axum::serve(listener, app).await.ok();
    });

    let body = serde_json::json!({ "action": { "Search": { "search_query": "x" } } });
    let res = reqwest::Client::new()
        .post(format!("http://{}/dispatch", bound))
        .json(&body)
        .send().await.unwrap();
    assert_eq!(res.status(), 202);

    let got = rx.recv().await.unwrap();
    assert!(got.contains("Search"));
}
```

Replace `stremio_linux_shell` with the actual crate name from `shell/Cargo.toml`.

- [ ] **Step 5: Run the test**

```bash
cd shell
cargo test --test lan_remote
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd ..
git add shell/
git commit -m "shell: lan_remote module with /dispatch endpoint"
```

---

## Task 9: Wire lan_remote to webview.evaluate_javascript

**Files:**
- Modify: the file that builds the app/runtime + webview (likely `shell/src/main.rs` or `shell/src/app/mod.rs`)

- [ ] **Step 1: Spawn the server and pipe to the webview**

After the webview is constructed:

```rust
use tokio::sync::mpsc;
use <crate_name>::lan_remote;

let (tx, mut rx) = mpsc::channel::<String>(64);

let rt = tokio::runtime::Builder::new_multi_thread()
    .enable_all()
    .build()
    .expect("tokio runtime");

let addr = "127.0.0.1:7001".parse().unwrap();
rt.spawn(async move {
    if let Err(e) = lan_remote::serve(addr, tx).await {
        eprintln!("lan_remote server error: {e}");
    }
});

let webview_clone = webview.clone();
glib::MainContext::default().spawn_local(async move {
    while let Some(json) = rx.recv().await {
        let escaped = json.replace('\\', "\\\\").replace('`', "\\`");
        let script = format!("window.__lanRemote && window.__lanRemote.cmd(`{}`);", escaped);
        webview_clone.evaluate_javascript(&script, None, None, None::<&gio::Cancellable>, |_| {});
    }
});
```

Adjust types to match the actual webview wrapper used in upstream. The runtime must outlive the spawned task — bind `rt` to a long-lived field on whatever struct owns the webview.

- [ ] **Step 2: Rebuild Flatpak**

```bash
cd shell
flatpak-builder --user --install --force-clean build-dir flatpak/<UPSTREAM_MANIFEST>
```

- [ ] **Step 3: Manual end-to-end check**

```bash
flatpak run com.stremio.Stremio &
sleep 5
curl -X POST http://127.0.0.1:7001/dispatch \
  -H 'Content-Type: application/json' \
  -d "$(cat << 'JSON'
{"action": <copy a Search action from docs/action-shapes.md>, "field": "", "locationHash": "#/search?search=inception"}
JSON
)"
```

Expected: HTTP 202 from curl, Stremio window navigates to search results.

- [ ] **Step 4: Commit**

```bash
cd ..
git add shell/
git commit -m "shell: wire lan_remote dispatch into webview.evaluate_javascript"
```

---

## Task 10: Rename Flatpak app ID

**Files:**
- Rename: `shell/flatpak/<UPSTREAM_MANIFEST>` → `dev.stremiolanremote.Stremio.json`
- Update matching desktop/icon basenames

- [ ] **Step 1: Rename manifest**

```bash
cd shell/flatpak
git mv <UPSTREAM_MANIFEST> dev.stremiolanremote.Stremio.json
```

Edit it: change every occurrence of `com.stremio.Stremio` to `dev.stremiolanremote.Stremio` inside the JSON.

- [ ] **Step 2: Rename data files**

```bash
cd ../data 2>/dev/null && for f in com.stremio.Stremio.*; do
  new=${f/com.stremio.Stremio/dev.stremiolanremote.Stremio}
  git mv "$f" "$new"
done || echo "no data dir to rename"
```

Edit each renamed file's contents to use the new ID (look for `Icon=`, `Exec=`, etc.).

- [ ] **Step 3: Rebuild and verify**

```bash
cd /Users/j/Documents/programming/stremio-lan-remote/shell
flatpak-builder --user --install --force-clean build-dir flatpak/dev.stremiolanremote.Stremio.json
flatpak run dev.stremiolanremote.Stremio
```

Expected: launches under new ID.

- [ ] **Step 4: Commit**

```bash
cd ..
git add shell/
git commit -m "shell: rename Flatpak app ID to dev.stremiolanremote.Stremio"
```

---

## Task 11: Addon scaffold

**Files:**
- Create: `addon/package.json`
- Create: `addon/src/index.js`
- Create: `addon/src/config.js`
- Create: `addon/test/manifest.test.js`

- [ ] **Step 1: Initialize npm project**

```bash
mkdir -p addon/src addon/test addon/bin addon/assets
cd addon
npm init -y
npm install stremio-addon-sdk express
npm install --save-dev vitest supertest
```

- [ ] **Step 2: Set ESM and scripts in `addon/package.json`**

```json
{
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "start": "node bin/start.js"
  }
}
```

- [ ] **Step 3: Write `addon/src/config.js`**

```javascript
export const config = {
  bind: process.env.BIND || '0.0.0.0:7000',
  shellHost: process.env.SHELL_HOST || '127.0.0.1:7001',
  streamResolverUrl: process.env.STREAM_RESOLVER_URL || '',
  publicHost: process.env.PUBLIC_HOST || '127.0.0.1:7000',
};
```

- [ ] **Step 4: Write `addon/src/index.js`**

```javascript
import { addonBuilder } from 'stremio-addon-sdk';
import { config } from './config.js';

export const manifest = {
  id: 'dev.stremiolanremote.addon',
  version: '0.1.0',
  name: 'LAN Remote',
  description: 'Cast playback to a Stremio LAN Remote desktop',
  resources: ['stream'],
  types: ['movie', 'series'],
  catalogs: [],
  idPrefixes: ['tt'],
};

const builder = new addonBuilder(manifest);
builder.defineStreamHandler(async () => ({ streams: [] }));
export const addonInterface = builder.getInterface();
```

- [ ] **Step 5: Write a manifest test**

`addon/test/manifest.test.js`:

```javascript
import { describe, it, expect } from 'vitest';
import { manifest } from '../src/index.js';

describe('manifest', () => {
  it('declares stream resource for movie and series', () => {
    expect(manifest.resources).toContain('stream');
    expect(manifest.types).toEqual(expect.arrayContaining(['movie', 'series']));
  });
});
```

- [ ] **Step 6: Run tests**

```bash
npx vitest run
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
cd .. && git add addon/
git commit -m "addon: scaffold with manifest"
```

---

## Task 12: Addon — stream endpoint emits "Cast to Deck"

**Files:**
- Modify: `addon/src/index.js`
- Create: `addon/src/castUrl.js`
- Create: `addon/test/castUrl.test.js`
- Create: `addon/test/stream.test.js`

- [ ] **Step 1: Write the castUrl tests**

`addon/test/castUrl.test.js`:

```javascript
import { describe, it, expect } from 'vitest';
import { castUrl } from '../src/castUrl.js';

describe('castUrl', () => {
  it('produces a movie URL with id', () => {
    expect(castUrl({ type: 'movie', id: 'tt0111161', publicHost: '192.168.1.10:7000' }))
      .toBe('http://192.168.1.10:7000/cast?id=tt0111161');
  });
  it('produces a series URL with id, season, episode', () => {
    expect(castUrl({ type: 'series', id: 'tt0903747:2:3', publicHost: '192.168.1.10:7000' }))
      .toBe('http://192.168.1.10:7000/cast?id=tt0903747&season=2&episode=3');
  });
});
```

- [ ] **Step 2: Implement `castUrl.js`**

```javascript
export function castUrl({ type, id, publicHost }) {
  if (type === 'series') {
    const [imdb, season, episode] = id.split(':');
    return `http://${publicHost}/cast?id=${imdb}&season=${season}&episode=${episode}`;
  }
  return `http://${publicHost}/cast?id=${id}`;
}
```

- [ ] **Step 3: Run castUrl tests**

```bash
cd addon && npx vitest run castUrl
```

Expected: PASS.

- [ ] **Step 4: Write the stream-handler test**

`addon/test/stream.test.js`:

```javascript
import { describe, it, expect } from 'vitest';
import { addonInterface } from '../src/index.js';

describe('stream handler', () => {
  it('returns a single Cast to Deck stream for movie', async () => {
    const res = await addonInterface.get('stream', 'movie', 'tt0111161');
    expect(res.streams).toHaveLength(1);
    expect(res.streams[0].name).toMatch(/Cast to Deck/);
    const url = res.streams[0].externalUrl || res.streams[0].url;
    expect(url).toMatch(/\/cast\?id=tt0111161/);
  });

  it('passes season/episode for series', async () => {
    const res = await addonInterface.get('stream', 'series', 'tt0903747:2:3');
    const url = res.streams[0].externalUrl || res.streams[0].url;
    expect(url).toMatch(/season=2/);
    expect(url).toMatch(/episode=3/);
  });
});
```

- [ ] **Step 5: Run, verify failure**

```bash
npx vitest run stream
```

Expected: FAIL (empty streams).

- [ ] **Step 6: Implement stream handler**

Edit `addon/src/index.js`. Replace the placeholder `defineStreamHandler` with:

```javascript
import { castUrl } from './castUrl.js';

builder.defineStreamHandler(async ({ type, id }) => ({
  streams: [
    {
      name: '📺 Cast to Deck',
      title: 'Play on the Deck',
      externalUrl: castUrl({ type, id, publicHost: config.publicHost }),
    },
  ],
}));
```

- [ ] **Step 7: Run tests, verify pass**

```bash
npx vitest run
```

- [ ] **Step 8: Commit**

```bash
cd .. && git add addon/
git commit -m "addon: emit Cast to Deck stream entry"
```

---

## Task 13: Addon — stream resolver

**Files:**
- Create: `addon/src/resolver.js`
- Create: `addon/test/resolver.test.js`

- [ ] **Step 1: Write failing test**

`addon/test/resolver.test.js`:

```javascript
import { describe, it, expect, vi } from 'vitest';
import { resolveBestStream } from '../src/resolver.js';

describe('resolveBestStream', () => {
  it('returns the first stream from upstream', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      json: async () => ({ streams: [
        { name: 'X', title: '1080p', url: 'http://stream' },
        { name: 'X', title: '720p', url: 'http://stream2' },
      ]}),
    }));
    const result = await resolveBestStream({ type: 'movie', id: 'tt0', upstreamUrl: 'http://up', fetch: fetchFn });
    expect(result.url).toBe('http://stream');
    expect(fetchFn).toHaveBeenCalledWith('http://up/stream/movie/tt0.json');
  });

  it('throws when upstream returns no streams', async () => {
    const fetchFn = vi.fn(async () => ({ ok: true, json: async () => ({ streams: [] }) }));
    await expect(resolveBestStream({ type: 'movie', id: 'tt0', upstreamUrl: 'http://x', fetch: fetchFn }))
      .rejects.toThrow();
  });

  it('throws when upstream is unreachable', async () => {
    const fetchFn = vi.fn(async () => ({ ok: false, status: 500 }));
    await expect(resolveBestStream({ type: 'movie', id: 'tt0', upstreamUrl: 'http://x', fetch: fetchFn }))
      .rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run, verify failure**

```bash
cd addon && npx vitest run resolver
```

- [ ] **Step 3: Implement resolver**

`addon/src/resolver.js`:

```javascript
export async function resolveBestStream({ type, id, upstreamUrl, fetch: fetchFn = fetch }) {
  const url = `${upstreamUrl}/stream/${type}/${id}.json`;
  const res = await fetchFn(url);
  if (!res.ok) {
    throw new Error(`upstream ${url} returned ${res.status}`);
  }
  const data = await res.json();
  if (!data.streams || data.streams.length === 0) {
    throw new Error(`no streams available for ${type}/${id}`);
  }
  return data.streams[0];
}
```

- [ ] **Step 4: Run, verify pass**

```bash
npx vitest run
```

- [ ] **Step 5: Commit**

```bash
cd .. && git add addon/
git commit -m "addon: stream resolver against upstream"
```

---

## Task 14: Addon — dispatchEncoder (action JSON)

**Files:**
- Create: `addon/src/dispatchEncoder.js`
- Create: `addon/test/dispatchEncoder.test.js`

The exact shape of the action JSON came from Task 7's `docs/action-shapes.md`. The test below is a template — replace the encoded structure with what you captured before this task completes.

- [ ] **Step 1: Write the test using the captured shape**

`addon/test/dispatchEncoder.test.js`:

```javascript
import { describe, it, expect } from 'vitest';
import { encodePlayerLoad } from '../src/dispatchEncoder.js';

describe('encodePlayerLoad', () => {
  it('matches the captured shape from docs/action-shapes.md for series episode play', () => {
    const out = encodePlayerLoad({
      stream: { url: 'http://localhost:11470/stream/abc' },
      metaId: 'tt0903747',
      videoId: 'tt0903747:2:3',
      type: 'series',
    });
    // Replace the assertion below with the exact captured structure.
    expect(out).toEqual({
      action: { Load: { Player: { /* fields per docs/action-shapes.md */ } } },
      field: '',
      locationHash: '#/player',
    });
  });
});
```

- [ ] **Step 2: Implement `dispatchEncoder.js`**

`addon/src/dispatchEncoder.js`:

```javascript
export function encodePlayerLoad({ stream, metaId, videoId, type }) {
  return {
    action: {
      Load: {
        Player: {
          stream: { url: stream.url, source: stream.source || { url: stream.url } },
          meta_request: { path: { resource: 'meta', type: type, id: metaId, extra: [] } },
          subtitles_path: null,
          video_params: null,
          video_id: videoId,
        },
      },
    },
    field: '',
    locationHash: '#/player',
  };
}
```

**Critical:** before claiming this task done, edit the structure above to match `docs/action-shapes.md` exactly. The test assertion and the implementation must both reflect the captured shape.

- [ ] **Step 3: Run tests, verify pass**

```bash
cd addon && npx vitest run dispatchEncoder
```

- [ ] **Step 4: Commit**

```bash
cd .. && git add addon/
git commit -m "addon: dispatchEncoder matching captured action shape"
```

---

## Task 15: Placeholder MP4 asset

**Files:**
- Create: `addon/assets/casting.mp4`

- [ ] **Step 1: Generate a 1-second silent black MP4**

```bash
cd addon/assets
ffmpeg -f lavfi -i color=c=black:s=320x240:d=1 -c:v libx264 -pix_fmt yuv420p -movflags +faststart casting.mp4
```

If `ffmpeg` isn't installed: `sudo apt install ffmpeg`.

- [ ] **Step 2: Verify**

```bash
ls -la casting.mp4
ffprobe casting.mp4 2>&1 | grep Duration
```

Expected: < 50KB, 1.0 second duration.

- [ ] **Step 3: Commit**

```bash
cd ../..
git add addon/assets/casting.mp4
git commit -m "addon: placeholder casting.mp4"
```

---

## Task 16: Addon — /cast endpoint + Express server

**Files:**
- Create: `addon/src/server.js`
- Create: `addon/test/server.test.js`
- Create: `addon/bin/start.js`

- [ ] **Step 1: Write the failing server test**

`addon/test/server.test.js`:

```javascript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createServer } from '../src/server.js';
import request from 'supertest';

describe('cast endpoint', () => {
  let app, shellPosts, resolver;

  beforeEach(() => {
    shellPosts = [];
    resolver = vi.fn(async () => ({ url: 'http://stream', source: { url: 'http://stream' } }));
    const fetchFn = vi.fn(async (url, opts) => {
      shellPosts.push({ url, body: JSON.parse(opts.body) });
      return { ok: true, status: 202 };
    });
    app = createServer({ resolver, fetch: fetchFn, shellHost: '127.0.0.1:7001' });
  });

  it('returns placeholder MP4 and posts dispatch for series', async () => {
    const res = await request(app).get('/cast?id=tt0903747&season=2&episode=3');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/video\/mp4/);
    expect(shellPosts).toHaveLength(1);
    expect(shellPosts[0].url).toBe('http://127.0.0.1:7001/dispatch');
    expect(shellPosts[0].body.action.Load.Player).toBeDefined();
  });

  it('returns 502 if resolver fails', async () => {
    resolver.mockRejectedValueOnce(new Error('no streams'));
    const res = await request(app).get('/cast?id=tt0');
    expect(res.status).toBe(502);
  });

  it('returns 502 if shell dispatch fails', async () => {
    const fetchFn = vi.fn(async () => ({ ok: false, status: 500 }));
    app = createServer({ resolver, fetch: fetchFn, shellHost: '127.0.0.1:7001' });
    const res = await request(app).get('/cast?id=tt0');
    expect(res.status).toBe(502);
  });
});
```

- [ ] **Step 2: Run, verify failure**

```bash
cd addon && npx vitest run server
```

- [ ] **Step 3: Implement the server**

`addon/src/server.js`:

```javascript
import express from 'express';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { getRouter } from 'stremio-addon-sdk';
import { addonInterface } from './index.js';
import { encodePlayerLoad } from './dispatchEncoder.js';
import { resolveBestStream } from './resolver.js';
import { config } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLACEHOLDER = readFileSync(resolve(__dirname, '../assets/casting.mp4'));

export function createServer({
  resolver = ({ type, id }) =>
    resolveBestStream({ type, id, upstreamUrl: config.streamResolverUrl }),
  fetch: fetchFn = fetch,
  shellHost = config.shellHost,
} = {}) {
  const app = express();
  app.use(getRouter(addonInterface));

  app.get('/cast', async (req, res) => {
    try {
      const { id, season, episode } = req.query;
      const isSeries = season != null;
      const type = isSeries ? 'series' : 'movie';
      const videoId = isSeries ? `${id}:${season}:${episode}` : id;

      const stream = await resolver({ type, id: videoId });
      const action = encodePlayerLoad({ stream, metaId: id, videoId, type });

      const dispatchRes = await fetchFn(`http://${shellHost}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(action),
      });
      if (!dispatchRes.ok) {
        return res.status(502).send('shell dispatch failed');
      }

      res.set('Content-Type', 'video/mp4');
      res.send(PLACEHOLDER);
    } catch (e) {
      res.status(502).send(e.message);
    }
  });

  return app;
}
```

If `getRouter` isn't a named export of `stremio-addon-sdk`, use `import sdk from 'stremio-addon-sdk'` and `sdk.getRouter`. Confirm against the SDK's docs.

- [ ] **Step 4: Run server tests, verify pass**

```bash
npx vitest run
```

- [ ] **Step 5: Write the entry point**

`addon/bin/start.js`:

```javascript
import { createServer } from '../src/server.js';
import { config } from '../src/config.js';

const [host, port] = config.bind.split(':');
createServer().listen(Number(port), host, () => {
  console.log(`addon listening on http://${host}:${port}`);
});
```

- [ ] **Step 6: Smoke test manually**

```bash
cd addon
STREAM_RESOLVER_URL=https://torrentio.strem.fun PUBLIC_HOST=127.0.0.1:7000 npm start &
sleep 2
curl http://127.0.0.1:7000/manifest.json | head
curl 'http://127.0.0.1:7000/stream/movie/tt0111161.json'
kill %1
```

Expected: manifest JSON; stream JSON containing one "Cast to Deck" entry.

- [ ] **Step 7: Commit**

```bash
cd ..
git add addon/
git commit -m "addon: /cast endpoint and Express server"
```

---

## Task 17: Systemd user unit and install script

**Files:**
- Create: `packaging/stremio-lan-remote-addon.service`
- Create: `packaging/install-addon.sh`

- [ ] **Step 1: Write the systemd unit**

`packaging/stremio-lan-remote-addon.service`:

```ini
[Unit]
Description=Stremio LAN Remote Addon
After=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/.local/share/stremio-lan-remote/addon
ExecStart=/usr/bin/node bin/start.js
Restart=on-failure
RestartSec=5s
Environment="STREAM_RESOLVER_URL=https://torrentio.strem.fun"
Environment="SHELL_HOST=127.0.0.1:7001"
Environment="BIND=0.0.0.0:7000"

[Install]
WantedBy=default.target
```

- [ ] **Step 2: Write the install script**

`packaging/install-addon.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

DEST="${HOME}/.local/share/stremio-lan-remote/addon"
UNIT_DEST="${HOME}/.config/systemd/user/stremio-lan-remote-addon.service"

mkdir -p "$DEST"
cp -r addon/. "$DEST/"

LAN_IP=$(hostname -I | awk '{print $1}')
sed -i "s/__PUBLIC_HOST__/${LAN_IP}:7000/" "${DEST}/.env" 2>/dev/null || true

cd "$DEST"
npm ci --omit=dev

mkdir -p "$(dirname "$UNIT_DEST")"
sed "s/__PUBLIC_HOST__/${LAN_IP}:7000/" \
  "$(dirname "$0")/stremio-lan-remote-addon.service" > "$UNIT_DEST"

# Inject PUBLIC_HOST as an extra Environment line
sed -i "/^Environment=\"BIND=/a Environment=\"PUBLIC_HOST=${LAN_IP}:7000\"" "$UNIT_DEST"

systemctl --user daemon-reload
systemctl --user enable --now stremio-lan-remote-addon.service

echo "Addon installed. On your phone, install:"
echo "  http://${LAN_IP}:7000/manifest.json"
```

```bash
chmod +x packaging/install-addon.sh
```

- [ ] **Step 3: Smoke test the install**

```bash
./packaging/install-addon.sh
systemctl --user status stremio-lan-remote-addon
curl http://127.0.0.1:7000/manifest.json
```

Expected: service active, manifest reachable.

- [ ] **Step 4: Commit**

```bash
git add packaging/
git commit -m "packaging: systemd user unit and install script"
```

---

## Task 18: End-to-end manual test

This is a checkpoint task — no commits.

- [ ] **Step 1: Confirm both pieces are running**

```bash
flatpak run dev.stremiolanremote.Stremio &
systemctl --user status stremio-lan-remote-addon
```

- [ ] **Step 2: Note the LAN IP**

```bash
hostname -I | awk '{print $1}'
```

- [ ] **Step 3: On a phone (or another computer)**

In Stremio: Settings → Addons → Install from URL: `http://<LAN-IP>:7000/manifest.json`.

- [ ] **Step 4: Navigate to a known title**

Find a movie via Cinemeta. Stream list should show "📺 Cast to Deck". Tap it.

- [ ] **Step 5: Verify on the Deck**

Deck's Stremio window should transition to the player and start playing. Phone shows a 1-second placeholder then stops.

If anything fails, capture logs:

```bash
journalctl --user -u stremio-lan-remote-addon -n 100
flatpak run dev.stremiolanremote.Stremio 2>&1 | head -100
```

---

## Task 19: CI — nightly upstream rebase

**Files:**
- Create: `.github/workflows/upstream-rebase.yml`
- Create: `.github/scripts/rebase-and-report.sh`
- Create: `.ci/last-tested-upstream-sha` (empty file)

- [ ] **Step 1: Create the marker file**

```bash
mkdir -p .ci
touch .ci/last-tested-upstream-sha
```

- [ ] **Step 2: Write the workflow**

`.github/workflows/upstream-rebase.yml`:

```yaml
name: Upstream rebase

on:
  schedule:
    - cron: '0 4 * * *'
  workflow_dispatch:

jobs:
  rebase:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      issues: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - name: Configure git
        run: |
          git config user.name 'lan-remote-bot'
          git config user.email 'bot@local'
      - name: Run rebase script
        run: ./.github/scripts/rebase-and-report.sh
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

- [ ] **Step 3: Write the rebase script**

`.github/scripts/rebase-and-report.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

UPSTREAM=https://github.com/Stremio/stremio-linux-shell.git
PREFIX=shell

git remote add upstream "$UPSTREAM" 2>/dev/null || true
git fetch upstream main

LAST_SHA=$(cat .ci/last-tested-upstream-sha 2>/dev/null || echo '')
NEW_SHA=$(git rev-parse upstream/main)

if [[ "$LAST_SHA" == "$NEW_SHA" ]]; then
  echo "upstream unchanged ($NEW_SHA)"
  exit 0
fi

if ! git subtree pull --prefix=$PREFIX upstream main --squash -m "subtree: rebase shell on upstream/main"; then
  TITLE="Upstream rebase conflict on $NEW_SHA"
  BODY=$(printf 'Failed to subtree-pull upstream/main.\n\nUpstream HEAD: %s\nPrevious tested: %s\n' "$NEW_SHA" "$LAST_SHA")
  EXISTING=$(gh issue list --search "$TITLE in:title" --state open --json number --jq '.[0].number' 2>/dev/null || echo '')
  if [[ -z "$EXISTING" ]]; then
    gh issue create --title "$TITLE" --body "$BODY"
  fi
  exit 1
fi

echo "$NEW_SHA" > .ci/last-tested-upstream-sha
git add .ci/last-tested-upstream-sha
git commit -m "ci: bump last-tested-upstream-sha to $NEW_SHA" || true
git push origin HEAD:main
```

```bash
chmod +x .github/scripts/rebase-and-report.sh
```

- [ ] **Step 4: Commit**

```bash
git add .github/ .ci/
git commit -m "ci: nightly upstream rebase workflow"
```

---

## Task 20: CI — Flatpak build + smoke test

**Files:**
- Create: `.github/workflows/smoke-test.yml`
- Create: `.github/scripts/smoke-test.sh`
- Create: `.github/scripts/dispatch-tests.json`

- [ ] **Step 1: Write the workflow**

`.github/workflows/smoke-test.yml`:

```yaml
name: Smoke test

on:
  push:
    branches: [main]
  schedule:
    - cron: '30 4 * * *'
  workflow_dispatch:

jobs:
  smoke:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      issues: write
    steps:
      - uses: actions/checkout@v4

      - name: Install deps
        run: |
          sudo apt update
          sudo apt install -y flatpak flatpak-builder xvfb dbus-x11 curl jq netcat-openbsd
          sudo flatpak remote-add --if-not-exists flathub https://flathub.org/repo/flathub.flatpakrepo
          sudo flatpak install -y flathub org.gnome.Platform//50 org.gnome.Sdk//50

      - name: Build bootstrap bundle
        run: |
          cd bootstrap
          npm ci
          npm test
          npm run build
          cp dist/injected.js ../shell/src/injected.js

      - name: Build Flatpak
        run: |
          cd shell
          flatpak-builder --user --install --force-clean build-dir flatpak/dev.stremiolanremote.Stremio.json

      - name: Smoke test
        run: ./.github/scripts/smoke-test.sh

      - name: Upload logs on failure
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: smoke-logs
          path: |
            /tmp/stremio.log
            /tmp/smoke.log

      - name: Open issue on failure
        if: failure()
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          UPSTREAM_SHA=$(cat .ci/last-tested-upstream-sha 2>/dev/null || echo unknown)
          TITLE="Smoke test failed on upstream $UPSTREAM_SHA"
          EXISTING=$(gh issue list --search "$TITLE in:title" --state open --json number --jq '.[0].number' 2>/dev/null || echo '')
          if [[ -z "$EXISTING" ]]; then
            gh issue create --title "$TITLE" --body "See workflow artifacts for logs."
          fi
```

- [ ] **Step 2: Write the smoke-test script**

`.github/scripts/smoke-test.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

Xvfb :99 -screen 0 1280x720x24 &
XVFB_PID=$!
export DISPLAY=:99
sleep 2

flatpak run dev.stremiolanremote.Stremio > /tmp/stremio.log 2>&1 &
APP_PID=$!

cleanup() { kill $APP_PID $XVFB_PID 2>/dev/null || true; }
trap cleanup EXIT

# Wait up to 30s for lan-remote port
for _ in $(seq 1 30); do
  nc -z 127.0.0.1 7001 && break || sleep 1
done
nc -z 127.0.0.1 7001 || { echo "lan_remote did not bind"; exit 1; }

# Wait up to 60s for bootstrap log
for _ in $(seq 1 60); do
  grep -q LANREMOTE_BOOT /tmp/stremio.log && break || sleep 1
done
grep -q LANREMOTE_BOOT /tmp/stremio.log || { echo "bootstrap did not log boot marker"; exit 1; }

# Run dispatch tests
jq -c '.[]' .github/scripts/dispatch-tests.json | while read -r line; do
  echo "dispatching: $line"
  curl -fsS -X POST -H 'Content-Type: application/json' --data "$line" http://127.0.0.1:7001/dispatch
  sleep 2
done

echo "smoke test passed"
```

```bash
chmod +x .github/scripts/smoke-test.sh
```

- [ ] **Step 3: Write the dispatch fixtures**

`.github/scripts/dispatch-tests.json`: an array of dispatch bodies, copied from `docs/action-shapes.md`. Example skeleton (replace with real captured shapes):

```json
[
  {"action": {"Search": {"search_query": "inception", "max_results": 10}}, "field": "", "locationHash": "#/search?search=inception"}
]
```

- [ ] **Step 4: Commit**

```bash
git add .github/
git commit -m "ci: flatpak build + smoke test workflow"
```

---

## Task 21: Release workflow

**Files:**
- Create: `.github/workflows/release.yml`

- [ ] **Step 1: Write the workflow**

`.github/workflows/release.yml`:

```yaml
name: Release

on:
  workflow_dispatch:
    inputs:
      version:
        description: 'Release version (e.g. 0.1.0)'
        required: true

jobs:
  release:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v4

      - name: Install deps
        run: |
          sudo apt update
          sudo apt install -y flatpak flatpak-builder nodejs npm
          sudo flatpak remote-add --if-not-exists flathub https://flathub.org/repo/flathub.flatpakrepo
          sudo flatpak install -y flathub org.gnome.Platform//50 org.gnome.Sdk//50

      - name: Build bootstrap
        run: |
          cd bootstrap && npm ci && npm run build && cp dist/injected.js ../shell/src/injected.js

      - name: Build Flatpak bundle
        run: |
          cd shell
          flatpak-builder --repo=repo --force-clean build-dir flatpak/dev.stremiolanremote.Stremio.json
          flatpak build-bundle repo ../stremio-lan-remote-${{ inputs.version }}.flatpak dev.stremiolanremote.Stremio

      - name: Package addon
        run: tar czf addon-${{ inputs.version }}.tar.gz addon packaging

      - name: Create GitHub release
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          gh release create v${{ inputs.version }} \
            stremio-lan-remote-${{ inputs.version }}.flatpak \
            addon-${{ inputs.version }}.tar.gz \
            --title "v${{ inputs.version }}" --generate-notes
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci: release workflow"
```

---

## Task 22: README and install docs

**Files:**
- Modify: `README.md`
- Create: `docs/install.md`

- [ ] **Step 1: Flesh out `README.md`**

```markdown
# Stremio LAN Remote

Control a desktop Stremio v5+ instance from Stremio mobile on the same LAN. Built for SteamDeck.

## What it does

Phone user opens a movie or episode in Stremio mobile, taps the "📺 Cast to Deck" stream entry, and the Deck's Stremio app starts playing — no clicks on the Deck.

## Architecture

See [the design doc](docs/superpowers/specs/2026-05-14-stremio-lan-remote-design.md).

## Install

See [docs/install.md](docs/install.md).

## Status

Tracks upstream Stremio releases via [nightly CI](.github/workflows/upstream-rebase.yml). See open issues for known breakage on the latest upstream commit.

## License

MIT.
```

- [ ] **Step 2: Write `docs/install.md`**

```markdown
# Install

## SteamDeck (Desktop Mode)

1. Download the latest `stremio-lan-remote-*.flatpak` and `addon-*.tar.gz` from [Releases](../../releases).
2. Install the Flatpak:
   ```bash
   flatpak install --user stremio-lan-remote-*.flatpak
   ```
3. Install the addon:
   ```bash
   tar xzf addon-*.tar.gz
   ./packaging/install-addon.sh
   ```
4. The install script prints the URL to use on your phone. Open Stremio mobile and add it as a custom addon.

## Updating

After Stremio releases a new version and a new build is shipped:
```bash
flatpak install --user --reinstall stremio-lan-remote-*.flatpak
./packaging/install-addon.sh
```

## Uninstall

```bash
systemctl --user disable --now stremio-lan-remote-addon.service
rm -rf ~/.local/share/stremio-lan-remote ~/.config/systemd/user/stremio-lan-remote-addon.service
flatpak uninstall --user dev.stremiolanremote.Stremio
```
```

- [ ] **Step 3: Commit**

```bash
git add README.md docs/install.md
git commit -m "docs: README and install instructions"
```

---

## Final verification

- [ ] All tests pass:
  ```bash
  cd bootstrap && npx vitest run && cd ../addon && npx vitest run && cd ../shell && cargo test
  ```
- [ ] Flatpak builds:
  ```bash
  cd shell && flatpak-builder --user --install --force-clean build-dir flatpak/dev.stremiolanremote.Stremio.json
  ```
- [ ] End-to-end manual test from Task 18 passes
- [ ] Push to GitHub origin
- [ ] Trigger the release workflow to ship v0.1.0
