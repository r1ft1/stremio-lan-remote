import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { initDownloads, getDownloads, saveDownloads, startDownload, deleteDownload, cancelDownload } from '../src/downloader.js';

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

describe('downloader delete', () => {
  it('removes the entry and the file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dl-'));
    await initDownloads(dir);
    await writeFile(join(dir, 'z.mkv'), 'data');
    getDownloads().push({ filename: 'z.mkv', path: join(dir, 'z.mkv'), status: 'done' });
    await deleteDownload('z.mkv');
    expect(getDownloads().find((e) => e.filename === 'z.mkv')).toBeUndefined();
    await expect(stat(join(dir, 'z.mkv'))).rejects.toThrow();
  });
});

describe('downloader robustness', () => {
  it('resume via 206: appends partial download to produce full file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dl-'));
    await initDownloads(dir);
    const buf = Buffer.alloc(500, 0x61); // 500 bytes of 'a'
    const partial = buf.subarray(0, 100);
    const filename = 'resume.mkv';
    const dest = join(dir, filename);

    // Pre-write 100 bytes so stat will find resumeFrom = 100
    await writeFile(dest, partial);
    // Seed the LIST entry so downloader sees it as known
    getDownloads().push({ filename, path: dest, source_url: '', bytes: 100, total: 500, status: 'interrupted', meta_id: '' });

    const server = rangeServer(buf);
    const port = await listen(server);
    const ok = startDownload({ url: `http://127.0.0.1:${port}/resume`, filename, meta_id: '', dir });
    expect(ok).toBe(true);
    const e = await waitDone(filename);
    expect(e.status).toBe('done');
    const finalBuf = await readFile(dest);
    expect(finalBuf.length).toBe(buf.length);
    expect(finalBuf.equals(buf)).toBe(true);
    server.close();
  });

  it('error status on non-ok HTTP: sets error: HTTP 404', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dl-'));
    await initDownloads(dir);
    const server404 = createServer((_req, res) => { res.statusCode = 404; res.end('Not Found'); });
    const port = await listen(server404);
    const filename = 'notfound.mkv';
    const ok = startDownload({ url: `http://127.0.0.1:${port}/nope`, filename, meta_id: '', dir });
    expect(ok).toBe(true);
    const e = await waitDone(filename);
    expect(e.status).toMatch(/^error: HTTP 404/);
    server404.close();
  });

  it('cancel sets cancelled: cancelDownload stops an in-flight download', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dl-'));
    await initDownloads(dir);

    // Slow server: writes body in small chunks with delays so the download stays in-flight
    const chunkSize = 1024;
    const totalChunks = 50;
    const slowServer = createServer((_req, res) => {
      res.statusCode = 200;
      res.setHeader('Content-Length', String(chunkSize * totalChunks));
      let i = 0;
      function sendChunk() {
        if (i >= totalChunks) { res.end(); return; }
        res.write(Buffer.alloc(chunkSize, 0x62));
        i++;
        setTimeout(sendChunk, 20);
      }
      sendChunk();
    });
    const port = await listen(slowServer);
    const filename = 'slow.mkv';
    const ok = startDownload({ url: `http://127.0.0.1:${port}/slow`, filename, meta_id: '', dir });
    expect(ok).toBe(true);

    // Give the download a moment to start receiving
    await new Promise((r) => setTimeout(r, 30));
    cancelDownload(filename);

    const e = await waitDone(filename, 5000);
    expect(e.status).toBe('cancelled');
    slowServer.close();
  });
});
