# Show Subscriptions / Headless Auto-Download Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Subscribe to a TV show from inside Stremio and have new 1080p episodes auto-download to the Steam Deck, working with the custom app closed.

**Architecture:** Three phases. (1) Run the Stremio streaming-server (`server.js`) as an always-on systemd user service so the torrent client `:11470` survives the app closing; the shell reuses it instead of spawning its own. (2) Move download execution and `.downloads.json` ownership into the always-on addon (Node). (3) Add a subscription store, an in-Stremio subscribe/unsubscribe action, and a 15-minute poller that finds newly-aired episodes (Cinemeta), picks the most-seeded 1080p release (Torrentio), and enqueues it.

**Tech Stack:** Node (ESM, `addon/`), Express 5, vitest + supertest, Node global `fetch`/`undici`, Rust (`shell/`), systemd user units.

**Spec:** `docs/superpowers/specs/2026-06-08-show-subscriptions-design.md`

**Key constants (settled here):**
- Downloads dir: `~/stremio-downloads` (matches shell `imp.rs` + launcher).
- Poll interval: 15 min (`POLL_INTERVAL_MS = 15 * 60 * 1000`).
- Min seeders: `MIN_SEEDERS = 3`.
- Retry window = episode aired within last 7 days (`RETRY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000`); episodes older than that simply drop out of the candidate set (no skip-state file needed).

---

## Phase 1 — Always-on streaming-server

### Task 1: systemd user service for the streaming-server

**Files:**
- Create: `packaging/stremio-lan-remote-server.service`
- Modify: `docs/install.md` (add enable steps)

- [ ] **Step 1: Create the service unit**

Create `packaging/stremio-lan-remote-server.service`:

```ini
[Unit]
Description=Stremio LAN Remote streaming-server
After=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/.local/share/stremio-lan-remote
ExecStart=/usr/bin/node %h/.local/share/stremio-lan-remote/server.js
Restart=on-failure
RestartSec=5s
Environment="NO_CORS=1"

[Install]
WantedBy=default.target
```

- [ ] **Step 2: Document install + linger in `docs/install.md`**

Add a section:

````markdown
## Always-on streaming-server (headless downloads)

Copy `shell/data/server.js` to `~/.local/share/stremio-lan-remote/server.js`, then:

```bash
mkdir -p ~/.config/systemd/user
cp packaging/stremio-lan-remote-server.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now stremio-lan-remote-server.service
loginctl enable-linger "$USER"   # keep services running while idle / across sleep
```

Verify it is listening with the app closed:

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:11470/  # expect 200
```
````

- [ ] **Step 3: Commit**

```bash
git add packaging/stremio-lan-remote-server.service docs/install.md
git commit -m "feat(ops): always-on streaming-server systemd user service"
```

### Task 2: Shell reuses an already-running streaming-server

**Files:**
- Modify: `shell/src/server.rs:25-47` (the launch path)

The shell currently always spawns `node server.js`. Change it to skip spawning (and skip the supervisor) when `:11470` is already serving.

- [ ] **Step 1: Read current launch logic**

Run: `sed -n '20,60p' shell/src/server.rs`
Expected: see `let server_path = env::var("SERVER_PATH")...`, the port-in-use `warn!`, `spawn_node`, and `thread::spawn(... supervise ...)`.

- [ ] **Step 2: Guard the spawn behind a liveness check**

In `shell/src/server.rs`, in the function that launches the server (around line 25), replace the body that unconditionally spawns with a check-first version. Insert at the top of the launch logic, before reading `SERVER_PATH`:

```rust
// If a shared streaming-server is already running (e.g. the
// stremio-lan-remote-server.service systemd unit), reuse it instead of
// spawning + supervising our own. Avoids a port conflict on 11470.
if Self::check_streaming_server(std::time::Duration::from_secs(1)).is_ok() {
    info!(target: "server", "streaming-server already running on port {STREAMING_SERVER_PORT}, reusing it");
    return Ok(());
}
```

(Place it so the early `return Ok(())` skips both `spawn_node` and the `supervise` thread. If `SERVER_PATH` is read before this point, move the check above that line so a missing `SERVER_PATH` no longer panics when a shared server is present.)

- [ ] **Step 3: Build the shell**

Run: `cd shell && cargo build --release 2>&1 | tail -5`
Expected: `Finished` (no errors). (Ask before running if builds are gated.)

- [ ] **Step 4: Manual verification on the Deck**

With `stremio-lan-remote-server.service` running, launch the app and confirm the shell log shows `reusing it` and playback still works:

Run: `grep "reusing it" /tmp/stremio-lan-remote-shell.log`
Expected: the reuse line present; no "port already in use" warning.

- [ ] **Step 5: Commit**

```bash
git add shell/src/server.rs
git commit -m "feat(shell): reuse an already-running streaming-server"
```

### Task 3: Launcher stops killing the shared server

**Files:**
- Modify: `scripts/launch-stremio.sh` (cleanup section + port-freeing loop)

- [ ] **Step 1: Remove the server.js kill + port-freeing**

In `scripts/launch-stremio.sh`, delete these lines from the cleanup section:

```bash
pkill -9 -f 'shell/data/server.js' 2>/dev/null || true
```

and remove the entire `for port in 11470 12470; do … done` block plus the `sleep 1` that follows it. Leave the `stremio-linux-shell` and `stremio-runtime` kills in place.

- [ ] **Step 2: Stop passing SERVER_PATH so the shell never spawns its own**

In the final `distrobox-enter … bash -c "…"` block, delete the line:

```bash
  SERVER_PATH='$SERVER_JS' \
```

(The shared systemd service now owns `server.js`.)

- [ ] **Step 3: Manual verification**

Run the launcher, then confirm only one server is listening:

Run: `ss -tlnpH 'sport = :11470' | wc -l`
Expected: `1`

- [ ] **Step 4: Commit**

```bash
git add scripts/launch-stremio.sh
git commit -m "feat(launcher): don't kill or spawn the streaming-server; use shared service"
```

---

## Phase 2 — Addon owns download execution + `.downloads.json`

### Task 4: Downloader state load/save

**Files:**
- Create: `addon/src/downloader.js`
- Test: `addon/test/downloader.test.js`

- [ ] **Step 1: Write the failing test**

Create `addon/test/downloader.test.js`:

```js
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDownloads, getDownloads, saveDownloads } from '../src/downloader.js';

async function tmp() { return mkdtemp(join(tmpdir(), 'dl-')); }

describe('downloader state', () => {
  let dir;
  beforeEach(async () => { dir = await tmp(); });

  it('returns [] when no persist file exists', async () => {
    const list = await initDownloads(dir);
    expect(list).toEqual([]);
    expect(getDownloads()).toEqual([]);
  });

  it('flips interrupted on load and persists', async () => {
    await writeFile(join(dir, '.downloads.json'), JSON.stringify([
      { filename: 'a.mkv', status: 'downloading', bytes: 5, total: 10 },
    ]));
    await initDownloads(dir);
    expect(getDownloads()[0].status).toBe('interrupted');
    const onDisk = JSON.parse(await readFile(join(dir, '.downloads.json'), 'utf8'));
    expect(onDisk[0].status).toBe('interrupted');
  });

  it('saveDownloads writes the given list', async () => {
    await initDownloads(dir);
    await saveDownloads(dir, [{ filename: 'b.mkv', status: 'done' }]);
    const onDisk = JSON.parse(await readFile(join(dir, '.downloads.json'), 'utf8'));
    expect(onDisk[0].filename).toBe('b.mkv');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd addon && npx vitest run test/downloader.test.js`
Expected: FAIL — `Cannot find module '../src/downloader.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `addon/src/downloader.js`:

```js
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const PERSIST_FILE = '.downloads.json';

let DIR = null;
let LIST = [];

export async function loadDownloads(dir) {
  try {
    const raw = await readFile(join(dir, PERSIST_FILE), 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    for (const e of parsed) if (e.status === 'downloading') e.status = 'interrupted';
    return parsed;
  } catch {
    return [];
  }
}

export async function saveDownloads(dir, list) {
  await writeFile(join(dir, PERSIST_FILE), JSON.stringify(list));
}

export async function initDownloads(dir) {
  DIR = dir;
  await mkdir(dir, { recursive: true });
  LIST = await loadDownloads(dir);
  await saveDownloads(DIR, LIST);
  return LIST;
}

export function getDownloads() {
  return LIST;
}

export function _setStateForTest(dir, list) {
  DIR = dir;
  LIST = list;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd addon && npx vitest run test/downloader.test.js`
Expected: PASS (3 passed).

- [ ] **Step 5: Commit**

```bash
git add addon/src/downloader.js addon/test/downloader.test.js
git commit -m "feat(addon): downloader state load/save"
```

### Task 5: Resumable download execution

**Files:**
- Modify: `addon/src/downloader.js`
- Test: `addon/test/downloader.test.js`

- [ ] **Step 1: Write the failing test (append to file)**

Add to `addon/test/downloader.test.js`:

```js
import { createServer } from 'node:http';
import { stat } from 'node:fs/promises';
import { startDownload, getDownloads, initDownloads } from '../src/downloader.js';

function rangeServer(buf) {
  return createServer((req, res) => {
    const range = req.headers.range;
    if (range) {
      const start = Number(/bytes=(\d+)-/.exec(range)[1]);
      res.statusCode = 206;
      res.setHeader('Content-Range', `bytes ${start}-${buf.length - 1}/${buf.length}`);
      res.setHeader('Content-Length', String(buf.length - start));
      res.end(buf.subarray(start));
    } else {
      res.statusCode = 200;
      res.setHeader('Content-Length', String(buf.length));
      res.end(buf);
    }
  });
}

function listen(server) {
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
}

async function waitDone(filename, timeoutMs = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const e = getDownloads().find((d) => d.filename === filename);
    if (e && e.status !== 'downloading') return e;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timed out waiting for download');
}

describe('downloader execution', () => {
  it('downloads a full file and marks done', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dl-'));
    await initDownloads(dir);
    const buf = Buffer.from('hello world '.repeat(1000));
    const server = rangeServer(buf);
    const port = await listen(server);
    const ok = startDownload({ url: `http://127.0.0.1:${port}/x`, filename: 'x.mkv', meta_id: 'tt1:1:2', dir });
    expect(ok).toBe(true);
    const e = await waitDone('x.mkv');
    expect(e.status).toBe('done');
    expect((await stat(join(dir, 'x.mkv'))).size).toBe(buf.length);
    expect(e.meta_id).toBe('tt1:1:2');
    server.close();
  });

  it('refuses a second concurrent download of the same filename', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dl-'));
    await initDownloads(dir);
    const buf = Buffer.from('a'.repeat(500000));
    const server = rangeServer(buf);
    const port = await listen(server);
    expect(startDownload({ url: `http://127.0.0.1:${port}/y`, filename: 'y.mkv', meta_id: '', dir })).toBe(true);
    expect(startDownload({ url: `http://127.0.0.1:${port}/y`, filename: 'y.mkv', meta_id: '', dir })).toBe(false);
    await waitDone('y.mkv');
    server.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd addon && npx vitest run test/downloader.test.js`
Expected: FAIL — `startDownload is not a function`.

- [ ] **Step 3: Implement `startDownload`**

Add to `addon/src/downloader.js`:

```js
import { createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';

const cancelled = new Set();

function sanitizeFilename(name) {
  return String(name).replace(/[^\w\-. ]+/g, '_').replace(/^\.+/, '').slice(0, 200);
}

function upsert(entry) {
  LIST = LIST.filter((e) => e.filename !== entry.filename);
  LIST.push(entry);
}

export function startDownload({ url, filename, meta_id = '', dir }) {
  const safe = sanitizeFilename(filename);
  if (!safe) return false;
  if (LIST.some((e) => e.filename === safe && e.status === 'downloading')) return false;

  const dest = join(dir, safe);
  const existing = LIST.find((e) => e.filename === safe);
  const finalMetaId = meta_id || existing?.meta_id || '';
  cancelled.delete(safe);

  (async () => {
    let resumeFrom = 0;
    try { resumeFrom = (await stat(dest)).size; } catch { resumeFrom = 0; }
    upsert({ filename: safe, path: dest, source_url: url, bytes: resumeFrom, total: 0, status: 'downloading', meta_id: finalMetaId });
    await saveDownloads(DIR, LIST);

    try {
      const headers = resumeFrom > 0 ? { Range: `bytes=${resumeFrom}-` } : {};
      const resp = await fetch(url, { headers });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const resumed = resp.status === 206;
      const bodyLen = Number(resp.headers.get('content-length') || 0);
      const total = resumed ? resumeFrom + bodyLen : bodyLen;

      const cur = LIST.find((e) => e.filename === safe);
      if (cur) { cur.total = total; if (!resumed) cur.bytes = 0; }
      await saveDownloads(DIR, LIST);

      const out = createWriteStream(dest, { flags: resumed ? 'a' : 'w' });
      let bytes = resumed ? resumeFrom : 0;
      let lastPersist = 0;
      for await (const chunk of Readable.fromWeb(resp.body)) {
        if (cancelled.has(safe)) { out.destroy(); throw new Error('cancelled'); }
        out.write(chunk);
        bytes += chunk.length;
        const e = LIST.find((x) => x.filename === safe);
        if (e) e.bytes = bytes;
        if (Date.now() - lastPersist > 1000) { lastPersist = Date.now(); await saveDownloads(DIR, LIST); }
      }
      await new Promise((r) => out.end(r));
      const done = LIST.find((e) => e.filename === safe);
      if (done) done.status = 'done';
    } catch (err) {
      const e = LIST.find((x) => x.filename === safe);
      if (e) e.status = err.message === 'cancelled' ? 'cancelled' : `error: ${err.message}`;
    }
    await saveDownloads(DIR, LIST);
  })();

  return true;
}

export function cancelDownload(filename) {
  const safe = sanitizeFilename(filename);
  cancelled.add(safe);
  const e = LIST.find((x) => x.filename === safe);
  if (e && e.status === 'downloading') e.status = 'cancelled';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd addon && npx vitest run test/downloader.test.js`
Expected: PASS (all downloader tests).

- [ ] **Step 5: Commit**

```bash
git add addon/src/downloader.js addon/test/downloader.test.js
git commit -m "feat(addon): resumable download execution"
```

### Task 6: Delete a downloaded file

**Files:**
- Modify: `addon/src/downloader.js`
- Test: `addon/test/downloader.test.js`

- [ ] **Step 1: Write the failing test (append)**

```js
import { deleteDownload } from '../src/downloader.js';
import { writeFile as wf } from 'node:fs/promises';

describe('downloader delete', () => {
  it('removes the entry and the file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dl-'));
    await initDownloads(dir);
    await wf(join(dir, 'z.mkv'), 'data');
    getDownloads().push({ filename: 'z.mkv', path: join(dir, 'z.mkv'), status: 'done' });
    await deleteDownload('z.mkv');
    expect(getDownloads().find((e) => e.filename === 'z.mkv')).toBeUndefined();
    await expect(stat(join(dir, 'z.mkv'))).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd addon && npx vitest run test/downloader.test.js`
Expected: FAIL — `deleteDownload is not a function`.

- [ ] **Step 3: Implement**

Add to `addon/src/downloader.js`:

```js
import { unlink } from 'node:fs/promises';

export async function deleteDownload(filename) {
  const safe = sanitizeFilename(filename);
  cancelled.add(safe);
  const e = LIST.find((x) => x.filename === safe);
  if (e?.path) { try { await unlink(e.path); } catch {} }
  LIST = LIST.filter((x) => x.filename !== safe);
  await saveDownloads(DIR, LIST);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd addon && npx vitest run test/downloader.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add addon/src/downloader.js addon/test/downloader.test.js
git commit -m "feat(addon): delete downloaded file"
```

### Task 7: Add downloadDir to config

**Files:**
- Modify: `addon/src/config.js`

- [ ] **Step 1: Add config fields**

Replace `addon/src/config.js` contents with:

```js
import { homedir } from 'node:os';
import { join } from 'node:path';

export const config = {
  bind: process.env.BIND || '0.0.0.0:7000',
  shellHost: process.env.SHELL_HOST || '127.0.0.1:7001',
  streamResolverUrl: process.env.STREAM_RESOLVER_URL || '',
  publicHost: process.env.PUBLIC_HOST || '127.0.0.1:7000',
  castResponseMode: process.env.CAST_RESPONSE_MODE || 'placeholder',
  downloadDir: process.env.DOWNLOAD_DIR || join(homedir(), 'stremio-downloads'),
  serverUrl: process.env.SERVER_URL || 'http://127.0.0.1:11470',
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS) || 15 * 60 * 1000,
  minSeeders: Number(process.env.MIN_SEEDERS) || 3,
  retryWindowMs: Number(process.env.RETRY_WINDOW_MS) || 7 * 24 * 60 * 60 * 1000,
};
```

- [ ] **Step 2: Verify existing tests still pass**

Run: `cd addon && npx vitest run`
Expected: PASS (no regressions).

- [ ] **Step 3: Commit**

```bash
git add addon/src/config.js
git commit -m "feat(addon): config for downloadDir, server, poller"
```

### Task 8: Route addon download endpoints to the local downloader

**Files:**
- Modify: `addon/src/server.js` (`/download_trigger_html`, `/download_trigger`, `/download`, `/downloads`, `/cancel_download`, `/delete_download`, `/resume_download`)
- Modify: `addon/src/index.js` (`fetchDownloads`)
- Test: `addon/test/server.test.js`

- [ ] **Step 1: Write the failing test (append to `addon/test/server.test.js`)**

```js
import { initDownloads, getDownloads, _setStateForTest } from '../src/downloader.js';

describe('addon-owned downloads', () => {
  it('/downloads returns the local downloader list', async () => {
    _setStateForTest('/tmp', [{ filename: 'a.mkv', status: 'done', meta_id: 'tt1:1:1' }]);
    const app = createServer({ fetch: vi.fn(), shellHost: '127.0.0.1:7001' });
    const res = await request(app).get('/downloads');
    expect(res.status).toBe(200);
    expect(res.body[0].filename).toBe('a.mkv');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd addon && npx vitest run test/server.test.js`
Expected: FAIL — `/downloads` currently proxies to the shell, so body is empty/502.

- [ ] **Step 3: Rewire server.js**

In `addon/src/server.js`:

1. Add imports at top:

```js
import { startDownload, cancelDownload, deleteDownload, getDownloads } from './downloader.js';
import { config } from './config.js';
```

2. Replace the `/downloads` handler body with:

```js
  app.get('/downloads', (_req, res) => {
    res.json(getDownloads());
  });
```

3. In `/download_trigger_html` and `/download_trigger`, replace the
   `await fetchFn(\`http://${shellHost}/download\`, {...})` block with:

```js
      startDownload({ url: sourceUrl, filename, meta_id, dir: config.downloadDir });
```

4. Replace `/download` (POST) handler body with:

```js
  app.post('/download', (req, res) => {
    const url = String(req.body?.url || '');
    const filename = String(req.body?.filename || '');
    const meta_id = String(req.body?.meta_id || '');
    if (!url || !filename) return res.status(400).end();
    const ok = startDownload({ url, filename, meta_id, dir: config.downloadDir });
    res.status(ok ? 202 : 409).end();
  });
```

5. Replace `/cancel_download` and `/delete_download` bodies to call the local
   downloader instead of forwarding:

```js
  app.get('/cancel_download', (req, res) => {
    const filename = String(req.query.filename || '');
    if (!filename) return res.status(400).send('missing filename');
    cancelDownload(filename);
    res.set('Content-Type', 'video/mp4');
    res.send(CONTROL_TINY);
  });

  app.get('/delete_download', async (req, res) => {
    const filename = String(req.query.filename || '');
    if (!filename) return res.status(400).send('missing filename');
    await deleteDownload(filename);
    res.set('Content-Type', 'video/mp4');
    res.send(CONTROL_TINY);
  });
```

6. In `/resume_download`, replace the resume `fetchFn(... /download ...)` call with:

```js
      startDownload({ url: entry.source_url, filename, meta_id: entry.meta_id || '', dir: config.downloadDir });
```

- [ ] **Step 4: Point `index.js` fetchDownloads at the local list**

In `addon/src/index.js`, replace the `fetchDownloads` function with:

```js
import { getDownloads } from './downloader.js';

async function fetchDownloads() {
  return getDownloads();
}
```

(Remove the old `fetch(\`http://${config.shellHost}/downloads\`)` implementation.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd addon && npx vitest run`
Expected: PASS (server + downloader + existing).

- [ ] **Step 6: Commit**

```bash
git add addon/src/server.js addon/src/index.js
git commit -m "feat(addon): own download execution + .downloads.json"
```

### Task 9: Initialize downloads on startup

**Files:**
- Modify: `addon/bin/start.js`

- [ ] **Step 1: Initialize before listening**

Replace `addon/bin/start.js` with:

```js
import { createServer } from '../src/server.js';
import { config } from '../src/config.js';
import { initDownloads } from '../src/downloader.js';

const [host, port] = config.bind.split(':');

await initDownloads(config.downloadDir);

createServer().listen(Number(port), host, () => {
  console.log(`addon listening on http://${host}:${port}`);
});
```

- [ ] **Step 2: Smoke test startup**

Run: `cd addon && DOWNLOAD_DIR=/tmp/dltest node bin/start.js &` then `sleep 1 && curl -s http://127.0.0.1:7000/downloads` then `kill %1`
Expected: `[]` and no crash.

- [ ] **Step 3: Commit**

```bash
git add addon/bin/start.js
git commit -m "feat(addon): init downloads on startup"
```

---

## Phase 3 — Subscriptions

### Task 10: Subscription store

**Files:**
- Create: `addon/src/subscriptions.js`
- Test: `addon/test/subscriptions.test.js`

- [ ] **Step 1: Write the failing test**

Create `addon/test/subscriptions.test.js`:

```js
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSubs, addSub, removeSub, isSubscribed } from '../src/subscriptions.js';

describe('subscriptions store', () => {
  let dir;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'sub-')); });

  it('starts empty', async () => {
    expect(await loadSubs(dir)).toEqual([]);
    expect(await isSubscribed(dir, 'tt1')).toBe(false);
  });

  it('adds idempotently with a timestamp', async () => {
    await addSub(dir, 'tt1', '2026-06-08T00:00:00Z');
    await addSub(dir, 'tt1', '2026-06-09T00:00:00Z');
    const subs = await loadSubs(dir);
    expect(subs).toHaveLength(1);
    expect(subs[0]).toEqual({ seriesId: 'tt1', subscribedAt: '2026-06-08T00:00:00Z' });
    expect(await isSubscribed(dir, 'tt1')).toBe(true);
  });

  it('removes', async () => {
    await addSub(dir, 'tt1', '2026-06-08T00:00:00Z');
    await removeSub(dir, 'tt1');
    expect(await isSubscribed(dir, 'tt1')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd addon && npx vitest run test/subscriptions.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `addon/src/subscriptions.js`:

```js
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const FILE = 'subscriptions.json';

export async function loadSubs(dir) {
  try {
    const parsed = JSON.parse(await readFile(join(dir, FILE), 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function save(dir, subs) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, FILE), JSON.stringify(subs));
}

export async function isSubscribed(dir, seriesId) {
  return (await loadSubs(dir)).some((s) => s.seriesId === seriesId);
}

export async function addSub(dir, seriesId, subscribedAt) {
  const subs = await loadSubs(dir);
  if (subs.some((s) => s.seriesId === seriesId)) return;
  subs.push({ seriesId, subscribedAt });
  await save(dir, subs);
}

export async function removeSub(dir, seriesId) {
  const subs = (await loadSubs(dir)).filter((s) => s.seriesId !== seriesId);
  await save(dir, subs);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd addon && npx vitest run test/subscriptions.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add addon/src/subscriptions.js addon/test/subscriptions.test.js
git commit -m "feat(addon): subscription store"
```

### Task 11: Release selection (most-seeded 1080p)

**Files:**
- Create: `addon/src/releaseSelect.js`
- Test: `addon/test/releaseSelect.test.js`

- [ ] **Step 1: Write the failing test**

Create `addon/test/releaseSelect.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { pickRelease } from '../src/releaseSelect.js';

const s = (name, title, infoHash = 'a'.repeat(40)) => ({ name, title, infoHash, fileIdx: 0 });

describe('pickRelease', () => {
  it('picks the most-seeded 1080p above the seeder threshold', () => {
    const streams = [
      s('Torrentio\n1080p', 'Show.S01E01.1080p.WEB\n👤 50'),
      s('Torrentio\n1080p', 'Show.S01E01.1080p.WEBRip\n👤 200'),
      s('Torrentio\n720p', 'Show.S01E01.720p.WEB\n👤 999'),
    ];
    const r = pickRelease(streams, { minSeeders: 3 });
    expect(r.title).toMatch(/👤 200/);
  });

  it('returns null when no 1080p meets the seeder threshold', () => {
    const streams = [s('1080p', 'X.1080p\n👤 1'), s('720p', 'X.720p\n👤 500')];
    expect(pickRelease(streams, { minSeeders: 3 })).toBeNull();
  });

  it('skips obviously foreign-only releases', () => {
    const streams = [
      s('1080p', 'X.S01E01.1080p.FRENCH\n👤 800'),
      s('1080p', 'X.S01E01.1080p.WEB-DL\n👤 100'),
    ];
    const r = pickRelease(streams, { minSeeders: 3 });
    expect(r.title).toMatch(/WEB-DL/);
  });

  it('keeps MULTi (has English) over a lower-seeded English-only', () => {
    const streams = [
      s('1080p', 'X.S01E01.1080p.MULTi\n👤 800'),
      s('1080p', 'X.S01E01.1080p.WEB-DL\n👤 100'),
    ];
    const r = pickRelease(streams, { minSeeders: 3 });
    expect(r.title).toMatch(/MULTi/);
  });

  it('ignores streams without an infoHash', () => {
    const streams = [{ name: '1080p', title: 'X.1080p\n👤 900', url: 'http://x' }];
    expect(pickRelease(streams, { minSeeders: 3 })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd addon && npx vitest run test/releaseSelect.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `addon/src/releaseSelect.js`:

```js
function seederCount(stream) {
  const text = `${stream.title || ''} ${stream.description || ''}`;
  const m = text.match(/👤\s*(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

function is1080p(stream) {
  const text = `${stream.name || ''} ${stream.title || ''}`;
  return /\b1080p\b/i.test(text);
}

// Conservative: only skip a release when it is tagged with a single foreign
// language AND shows no English/MULTi marker. Errs toward keeping a release.
function isForeignOnly(stream) {
  const text = `${stream.name || ''} ${stream.title || ''}`;
  const foreign = /\b(VOSTFR|TRUEFRENCH|FRENCH|GERMAN|ITA|ITALIAN|SPANISH|CASTELLANO|LATINO|HINDI|RUSSIAN|KOREAN|JAPANESE|POLISH|PL|NORDIC|DUBBED)\b/i.test(text);
  const english = /\b(ENG|ENGLISH|MULTI)\b/i.test(text);
  return foreign && !english;
}

export function pickRelease(streams, { minSeeders = 3 } = {}) {
  const candidates = (streams || [])
    .filter((s) => s.infoHash)
    .filter(is1080p)
    .filter((s) => !isForeignOnly(s))
    .filter((s) => seederCount(s) >= minSeeders)
    .sort((a, b) => seederCount(b) - seederCount(a));
  return candidates[0] || null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd addon && npx vitest run test/releaseSelect.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add addon/src/releaseSelect.js addon/test/releaseSelect.test.js
git commit -m "feat(addon): most-seeded 1080p release selection"
```

### Task 12: Subscribe/unsubscribe endpoints

**Files:**
- Modify: `addon/src/server.js`
- Test: `addon/test/server.test.js`

- [ ] **Step 1: Write the failing test (append)**

```js
import { loadSubs } from '../src/subscriptions.js';
import { config } from '../src/config.js';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('subscribe endpoints', () => {
  it('subscribe then unsubscribe updates the store', async () => {
    config.downloadDir = await mkdtemp(join(tmpdir(), 'subep-'));
    const app = createServer({ fetch: vi.fn(), shellHost: '127.0.0.1:7001' });
    const r1 = await request(app).get('/subscribe?id=tt0903747');
    expect(r1.status).toBe(200);
    expect((await loadSubs(config.downloadDir)).map((s) => s.seriesId)).toContain('tt0903747');
    await request(app).get('/unsubscribe?id=tt0903747');
    expect((await loadSubs(config.downloadDir))).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd addon && npx vitest run test/server.test.js`
Expected: FAIL — 404 on `/subscribe`.

- [ ] **Step 3: Implement endpoints**

In `addon/src/server.js`, add imports:

```js
import { addSub, removeSub } from './subscriptions.js';
```

Add handlers (near the other `app.get` routes):

```js
  function bounceHtml(msg) {
    return '<!doctype html><meta charset="utf-8"><title>Subscriptions</title>' +
      '<style>body{background:#0f0f12;color:#eaeaf2;font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;padding:0 20px;text-align:center}</style>' +
      `<div><p>${msg}</p></div><script>setTimeout(function(){location.href="stremio:///"},400)</script>`;
  }

  app.get('/subscribe', async (req, res) => {
    const id = String(req.query.id || '').split(':')[0];
    if (!id) return res.status(400).send('missing id');
    await addSub(config.downloadDir, id, new Date().toISOString());
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(bounceHtml('🔔 Subscribed — new 1080p episodes will auto-download.'));
  });

  app.get('/unsubscribe', async (req, res) => {
    const id = String(req.query.id || '').split(':')[0];
    if (!id) return res.status(400).send('missing id');
    await removeSub(config.downloadDir, id);
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(bounceHtml('🔕 Unsubscribed.'));
  });
```

Note: `new Date().toISOString()` is intentional production runtime code (not a test). Tests above don't assert on the exact timestamp.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd addon && npx vitest run test/server.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add addon/src/server.js
git commit -m "feat(addon): subscribe/unsubscribe endpoints"
```

### Task 13: Subscribe action in the stream list

**Files:**
- Modify: `addon/src/index.js` (`defineStreamHandler`)
- Test: `addon/test/stream.test.js`

- [ ] **Step 1: Write the failing test (append to `addon/test/stream.test.js`)**

```js
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { config } from '../src/config.js';
import { addonInterface } from '../src/index.js';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('subscribe action in stream list', () => {
  beforeEach(async () => {
    config.downloadDir = await mkdtemp(join(tmpdir(), 'streamsub-'));
    config.streamResolverUrl = '';
  });

  it('offers Subscribe on a series episode when not subscribed', async () => {
    const { streams } = await addonInterface.get('stream', 'series', 'tt0903747:1:1');
    expect(streams.some((s) => /Subscribe/i.test(s.name))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd addon && npx vitest run test/stream.test.js`
Expected: FAIL — no Subscribe entry.

- [ ] **Step 3: Implement**

In `addon/src/index.js`, add imports near the top:

```js
import { isSubscribed } from './subscriptions.js';
```

Add a helper above `builder.defineStreamHandler`:

```js
async function subscriptionEntry({ id, publicHost }) {
  const seriesId = String(id).split(':')[0];
  const subscribed = await isSubscribed(config.downloadDir, seriesId);
  return subscribed
    ? {
        name: '🔕 Unsubscribe',
        title: 'Stop auto-downloading new episodes',
        externalUrl: `${publicBase(publicHost)}/unsubscribe?id=${seriesId}`,
      }
    : {
        name: '🔔 Subscribe — auto-download new 1080p',
        title: 'Automatically download newly-aired episodes to the Deck',
        externalUrl: `${publicBase(publicHost)}/subscribe?id=${seriesId}`,
      };
}
```

In `defineStreamHandler`, in the branch that handles real `tt`/series ids (the
block after the `lan-dl:` early-return, where `extras` is built), add — for series
ids only (those containing `:`) — the subscription entry to the front of `extras`:

```js
  if (type === 'series' && id.includes(':')) {
    try {
      extras.unshift(await subscriptionEntry({ id, publicHost: config.publicHost }));
    } catch (e) {}
  }
```

(Place this immediately before the `if (!config.streamResolverUrl)` check so the
Subscribe entry shows even when no resolver is configured.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd addon && npx vitest run test/stream.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add addon/src/index.js
git commit -m "feat(addon): subscribe action in series stream list"
```

### Task 14: Poller — one pass

**Files:**
- Create: `addon/src/poller.js`
- Test: `addon/test/poller.test.js`

- [ ] **Step 1: Write the failing test**

Create `addon/test/poller.test.js`:

```js
import { describe, it, expect, vi } from 'vitest';
import { pollOnce } from '../src/poller.js';

const NOW = new Date('2026-06-08T12:00:00Z').getTime();

function deps(overrides = {}) {
  return {
    now: () => NOW,
    minSeeders: 3,
    retryWindowMs: 7 * 24 * 60 * 60 * 1000,
    loadSubs: async () => [{ seriesId: 'tt1', subscribedAt: '2026-06-01T00:00:00Z' }],
    cinemetaEpisodes: async () => [
      // aired 2 days ago, after subscribe → candidate
      { season: 1, episode: 5, released: '2026-06-06T00:00:00Z' },
      // aired before subscribe → ignored
      { season: 1, episode: 1, released: '2026-05-01T00:00:00Z' },
      // not aired yet → ignored
      { season: 1, episode: 6, released: '2026-06-20T00:00:00Z' },
    ],
    torrentioStreams: vi.fn(async () => [
      { name: '1080p', title: 'tt1.S01E05.1080p.WEB-DL\n👤 120', infoHash: 'a'.repeat(40), fileIdx: 0 },
    ]),
    getDownloads: () => [],
    startDownload: vi.fn(() => true),
    ...overrides,
  };
}

describe('pollOnce', () => {
  it('downloads an aired-after-subscribe episode within the window', async () => {
    const d = deps();
    await pollOnce(d);
    expect(d.torrentioStreams).toHaveBeenCalledWith('series', 'tt1:1:5');
    expect(d.startDownload).toHaveBeenCalledTimes(1);
    const arg = d.startDownload.mock.calls[0][0];
    expect(arg.meta_id).toBe('tt1:1:5');
    expect(arg.url).toBe('http://127.0.0.1:11470/' + 'a'.repeat(40) + '/0');
  });

  it('skips episodes already in downloads', async () => {
    const d = deps({ getDownloads: () => [{ meta_id: 'tt1:1:5', status: 'done' }] });
    await pollOnce(d);
    expect(d.startDownload).not.toHaveBeenCalled();
  });

  it('skips episodes aired longer ago than the retry window', async () => {
    const d = deps({
      cinemetaEpisodes: async () => [{ season: 1, episode: 5, released: '2026-05-25T00:00:00Z' }],
    });
    await pollOnce(d);
    expect(d.startDownload).not.toHaveBeenCalled();
  });

  it('does nothing when no release meets the seeder threshold', async () => {
    const d = deps({
      torrentioStreams: async () => [
        { name: '1080p', title: 'tt1.S01E05.1080p\n👤 1', infoHash: 'a'.repeat(40), fileIdx: 0 },
      ],
    });
    await pollOnce(d);
    expect(d.startDownload).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd addon && npx vitest run test/poller.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `addon/src/poller.js`:

```js
import { pickRelease } from './releaseSelect.js';
import { config } from './config.js';

function isHandled(downloads, metaId) {
  return downloads.some((d) => d.meta_id === metaId && !String(d.status).startsWith('error'));
}

export async function pollOnce(deps) {
  const now = deps.now();
  const subs = await deps.loadSubs();
  for (const sub of subs) {
    let episodes;
    try {
      episodes = await deps.cinemetaEpisodes(sub.seriesId);
    } catch {
      continue;
    }
    const subAt = new Date(sub.subscribedAt).getTime();
    const downloads = deps.getDownloads();
    for (const ep of episodes) {
      const released = new Date(ep.released).getTime();
      if (!(released > subAt)) continue;
      if (released > now) continue;
      if (now - released > deps.retryWindowMs) continue;
      const metaId = `${sub.seriesId}:${ep.season}:${ep.episode}`;
      if (isHandled(downloads, metaId)) continue;

      let streams;
      try {
        streams = await deps.torrentioStreams('series', `${sub.seriesId}:${ep.season}:${ep.episode}`);
      } catch {
        continue;
      }
      const release = pickRelease(streams, { minSeeders: deps.minSeeders });
      if (!release) continue;

      const url = `${config.serverUrl}/${release.infoHash}/${release.fileIdx ?? 0}`;
      const base = `${sub.seriesId}.S${String(ep.season).padStart(2, '0')}E${String(ep.episode).padStart(2, '0')}`;
      deps.startDownload({ url, filename: `${base}.mkv`, meta_id: metaId, dir: config.downloadDir });
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd addon && npx vitest run test/poller.test.js`
Expected: PASS (4 passed).

- [ ] **Step 5: Commit**

```bash
git add addon/src/poller.js addon/test/poller.test.js
git commit -m "feat(addon): subscription poller (one pass)"
```

### Task 15: Wire the poller into startup

**Files:**
- Modify: `addon/src/poller.js` (add `startPoller` + real deps wiring)
- Modify: `addon/bin/start.js`
- Test: `addon/test/poller.test.js`

- [ ] **Step 1: Write the failing test (append)**

```js
import { buildDeps } from '../src/poller.js';

describe('buildDeps', () => {
  it('wires cinemetaEpisodes to return {season,episode,released} objects', async () => {
    const fakeFetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ meta: { videos: [{ season: 1, number: 2, released: '2026-01-01' }] } }),
    }));
    const deps = buildDeps({ fetchFn: fakeFetch });
    const eps = await deps.cinemetaEpisodes('tt1');
    expect(eps[0]).toMatchObject({ season: 1, episode: 2, released: '2026-01-01' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd addon && npx vitest run test/poller.test.js`
Expected: FAIL — `buildDeps is not a function`.

- [ ] **Step 3: Implement `buildDeps` + `startPoller`**

Append to `addon/src/poller.js`:

```js
import { loadSubs } from './subscriptions.js';
import { getDownloads, startDownload } from './downloader.js';

export function buildDeps({ fetchFn = fetch } = {}) {
  return {
    now: () => Date.now(),
    minSeeders: config.minSeeders,
    retryWindowMs: config.retryWindowMs,
    loadSubs: () => loadSubs(config.downloadDir),
    getDownloads,
    startDownload,
    cinemetaEpisodes: async (seriesId) => {
      const r = await fetchFn(`https://v3-cinemeta.strem.io/meta/series/${seriesId}.json`);
      if (!r.ok) return [];
      const j = await r.json();
      return (j?.meta?.videos || []).map((v) => ({
        season: v.season,
        episode: v.number ?? v.episode,
        released: v.released,
      }));
    },
    torrentioStreams: async (type, id) => {
      if (!config.streamResolverUrl) return [];
      const r = await fetchFn(`${config.streamResolverUrl}/stream/${type}/${id}.json`);
      if (!r.ok) return [];
      const j = await r.json();
      return j?.streams || [];
    },
  };
}

let timer = null;

export function startPoller() {
  const deps = buildDeps();
  const tick = () => { pollOnce(deps).catch((e) => console.error('poll error', e)); };
  tick();
  timer = setInterval(tick, config.pollIntervalMs);
  return () => clearInterval(timer);
}
```

- [ ] **Step 4: Start the poller in `bin/start.js`**

Update `addon/bin/start.js` to call `startPoller()` after listening:

```js
import { createServer } from '../src/server.js';
import { config } from '../src/config.js';
import { initDownloads } from '../src/downloader.js';
import { startPoller } from '../src/poller.js';

const [host, port] = config.bind.split(':');

await initDownloads(config.downloadDir);

createServer().listen(Number(port), host, () => {
  console.log(`addon listening on http://${host}:${port}`);
  startPoller();
  console.log(`poller started (every ${config.pollIntervalMs / 60000} min)`);
});
```

- [ ] **Step 5: Run tests + smoke test**

Run: `cd addon && npx vitest run`
Expected: PASS (all suites).

Run: `cd addon && DOWNLOAD_DIR=/tmp/dltest STREAM_RESOLVER_URL= node bin/start.js &` then `sleep 2 && curl -s http://127.0.0.1:7000/downloads && kill %1`
Expected: `poller started` in output, `[]` from curl, no crash.

- [ ] **Step 6: Commit**

```bash
git add addon/src/poller.js addon/bin/start.js
git commit -m "feat(addon): start subscription poller on boot"
```

---

## Final verification

- [ ] **Full addon test suite**

Run: `cd addon && npx vitest run`
Expected: all suites PASS.

- [ ] **Shell builds**

Run: `cd shell && cargo build --release 2>&1 | tail -3`
Expected: `Finished`. (Ask before building if gated.)

- [ ] **End-to-end on the Deck (manual)**

1. `server.service` running; app closed.
2. Subscribe to a currently-airing show inside Stremio (🔔 entry appears).
3. Confirm the next aired episode appears in "Deck Downloads — Shows" within ~15 min, app still closed.
4. Re-open the show → entry now reads 🔕 Unsubscribe.
5. Confirm an idle poll (caught-up show) issues no Torrentio request (addon log quiet).

## Spec coverage check

- Headless services → Tasks 1–3, 9, 15. ✅
- In-Stremio subscribe action → Tasks 12, 13. ✅
- Most-seeded 1080p, foreign-only skip, ≥3 seeders → Task 11. ✅
- New-episodes-only + 7-day retry window → Task 14. ✅
- 15-min poll → Tasks 7 (config), 15. ✅
- Addon owns downloads + `.downloads.json` → Tasks 4–9. ✅
- Catalog visibility → reuses existing `defineCatalogHandler` (no change needed; fed by `getDownloads`). ✅
- Full speed while gaming → no throttling code added (by design). ✅
```
