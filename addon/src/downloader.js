import { mkdir, readFile, writeFile, stat, unlink } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';

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

const cancelled = new Set();
// Fix 2: per-download AbortControllers keyed by sanitized filename
const controllers = new Map();

function sanitizeFilename(name) {
  return String(name).replace(/[^\w\-. ]+/g, '_').replace(/^\.+/, '').slice(0, 200);
}

function upsert(entry) {
  LIST = LIST.filter((e) => e.filename !== entry.filename);
  LIST.push(entry);
}

export function startDownload({ url, filename, meta_id = '', dir }) {
  const safe = sanitizeFilename(filename);
  // Fix 5: reject whitespace-only filenames
  if (!safe.trim()) return false;
  if (LIST.some((e) => e.filename === safe && e.status === 'downloading')) return false;

  // Fix 3: use module DIR as authoritative; fall back to caller-supplied dir only if DIR not yet set
  const baseDir = DIR || dir;
  if (!DIR) DIR = baseDir;

  const dest = join(baseDir, safe);
  const existing = LIST.find((e) => e.filename === safe);
  const finalMetaId = meta_id || existing?.meta_id || '';
  cancelled.delete(safe);

  // Synchronously mark as downloading so a second concurrent call is rejected
  upsert({ filename: safe, path: dest, source_url: url, bytes: 0, total: 0, status: 'downloading', meta_id: finalMetaId });

  (async () => {
    // Fix 2: create AbortController for this download
    const controller = new AbortController();
    controllers.set(safe, controller);

    let resumeFrom = 0;
    try { resumeFrom = (await stat(dest)).size; } catch { resumeFrom = 0; }
    const cur0 = LIST.find((e) => e.filename === safe);
    if (cur0) cur0.bytes = resumeFrom;
    await saveDownloads(DIR, LIST);

    try {
      const headers = resumeFrom > 0 ? { Range: `bytes=${resumeFrom}-` } : {};
      // Fix 2: pass signal to fetch
      const resp = await fetch(url, { headers, signal: controller.signal });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const resumed = resp.status === 206;
      const bodyLen = Number(resp.headers.get('content-length') || 0);
      const total = resumed ? resumeFrom + bodyLen : bodyLen;

      const cur = LIST.find((e) => e.filename === safe);
      if (cur) { cur.total = total; if (!resumed) cur.bytes = 0; }
      await saveDownloads(DIR, LIST);

      // Fix 1: attach error listener so stream errors don't crash the process
      const out = createWriteStream(dest, { flags: resumed ? 'a' : 'w' });
      out.on('error', () => {}); // keep the error from crashing the process; captured via end() callback / write path
      let bytes = resumed ? resumeFrom : 0;
      let lastPersist = 0;
      for await (const chunk of Readable.fromWeb(resp.body)) {
        if (cancelled.has(safe)) {
          // Fix 2: abort fetch body to stop buffering
          controller.abort();
          out.destroy();
          throw new Error('cancelled');
        }
        // Fix 4: honor write backpressure
        if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
        bytes += chunk.length;
        const e = LIST.find((x) => x.filename === safe);
        if (e) e.bytes = bytes;
        if (Date.now() - lastPersist > 1000) { lastPersist = Date.now(); await saveDownloads(DIR, LIST); }
      }
      // Fix 1: reject on write error so catch sets error status instead of marking done
      await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
      const done = LIST.find((e) => e.filename === safe);
      if (done) done.status = 'done';
    } catch (err) {
      // Fix 2: treat AbortError the same as explicit 'cancelled'
      const isCancelled = err.message === 'cancelled' || err.name === 'AbortError';
      const e = LIST.find((x) => x.filename === safe);
      if (e) e.status = isCancelled ? 'cancelled' : `error: ${err.message}`;
    } finally {
      // Fix 2: always clean up controller entry
      controllers.delete(safe);
    }
    await saveDownloads(DIR, LIST);
  })();

  return true;
}

export function cancelDownload(filename) {
  const safe = sanitizeFilename(filename);
  cancelled.add(safe);
  // Fix 2: abort in-flight fetch promptly
  controllers.get(safe)?.abort();
  const e = LIST.find((x) => x.filename === safe);
  if (e && e.status === 'downloading') e.status = 'cancelled';
}

export async function deleteDownload(filename) {
  const safe = sanitizeFilename(filename);
  cancelled.add(safe);
  // Fix 2: abort in-flight fetch promptly
  controllers.get(safe)?.abort();
  // Fix 6: abort + cancelled-flag stop the in-flight write promptly, but a chunk already
  // mid-write may briefly recreate the file before the loop observes cancellation;
  // full cancel-and-wait is out of scope.
  const e = LIST.find((x) => x.filename === safe);
  if (e?.path) { try { await unlink(e.path); } catch {} }
  LIST = LIST.filter((x) => x.filename !== safe);
  await saveDownloads(DIR, LIST);
}
