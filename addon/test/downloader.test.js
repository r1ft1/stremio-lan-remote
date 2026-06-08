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
