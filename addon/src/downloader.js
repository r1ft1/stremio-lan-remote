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

  // Synchronously mark as downloading so a second concurrent call is rejected
  upsert({ filename: safe, path: dest, source_url: url, bytes: 0, total: 0, status: 'downloading', meta_id: finalMetaId });

  (async () => {
    let resumeFrom = 0;
    try { resumeFrom = (await stat(dest)).size; } catch { resumeFrom = 0; }
    const cur0 = LIST.find((e) => e.filename === safe);
    if (cur0) cur0.bytes = resumeFrom;
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

export async function deleteDownload(filename) {
  const safe = sanitizeFilename(filename);
  cancelled.add(safe);
  const e = LIST.find((x) => x.filename === safe);
  if (e?.path) { try { await unlink(e.path); } catch {} }
  LIST = LIST.filter((x) => x.filename !== safe);
  await saveDownloads(DIR, LIST);
}
