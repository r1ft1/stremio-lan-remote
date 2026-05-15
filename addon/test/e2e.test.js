import { describe, it, expect } from 'vitest';

const ADDON_URL = (process.env.E2E_ADDON_URL || '').replace(/\/+$/, '');
const skip = !ADDON_URL;

const MOVIES = [
  ['tt0111161', 'Shawshank Redemption'],
  ['tt1375666', 'Inception'],
  ['tt0118715', 'The Big Lebowski'],
];

async function getStream(imdbId) {
  const r = await fetch(`https://torrentio.strem.fun/stream/movie/${imdbId}.json`);
  if (!r.ok) throw new Error(`Torrentio fetch failed for ${imdbId}: ${r.status}`);
  const d = await r.json();
  const pick = d.streams.find((s) => /1080|720/i.test(s.name || '')) || d.streams[0];
  if (!pick) throw new Error(`No streams for ${imdbId}`);
  return { name: pick.name, infoHash: pick.infoHash, fileIdx: pick.fileIdx || 0 };
}

function encodeStreamToken(stream) {
  return Buffer.from(JSON.stringify(stream)).toString('base64url');
}

async function cast(id, stream) {
  const url = `${ADDON_URL}/cast?id=${id}&stream=${encodeStreamToken(stream)}`;
  const r = await fetch(url);
  if (r.status !== 200) throw new Error(`cast failed: ${r.status}`);
}

async function stop() {
  const r = await fetch(`${ADDON_URL}/control?action=stop`, { method: 'POST' });
  if (!r.ok && r.status !== 202) throw new Error(`stop failed: ${r.status}`);
}

async function getState() {
  const r = await fetch(`${ADDON_URL}/state`);
  if (!r.ok) throw new Error(`state failed: ${r.status}`);
  return r.json();
}

async function waitFor(predicate, label, timeoutMs = 60000) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeoutMs) {
    last = await getState();
    if (predicate(last)) return last;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Timeout waiting for ${label}; last state direct_mode=${last?.direct_mode} time_pos=${last?.time_pos}`);
}

function videoTrackSelected(state) {
  if (!state.direct_mode) return false;
  const list = Array.isArray(state.track_list) ? state.track_list : [];
  return list.some((t) => t.type === 'video' && t.selected === true);
}

async function fetchDownloads() {
  const r = await fetch(`${ADDON_URL}/downloads`);
  if (!r.ok) throw new Error(`/downloads failed: ${r.status}`);
  return r.json();
}

async function waitForDownload(filename, predicate, label, timeoutMs = 60000) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeoutMs) {
    const list = await fetchDownloads();
    last = list.find((d) => d.filename === filename);
    if (last && predicate(last)) return last;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Timeout waiting for ${label}; last entry status=${last?.status} bytes=${last?.bytes}`);
}

describe.skipIf(skip)('download → play local file (E2E, requires SteamDeck)', () => {
  const FILENAME = 'e2e-fixture.mp4';

  it('downloads a short MP4 then plays it from local disk via the catalog', async () => {
    await stop();
    await new Promise((r) => setTimeout(r, 1000));

    const fixtureUrl = `${ADDON_URL.replace(/\/+$/, '')}/test_fixture.mp4`;
    const dlResp = await fetch(`${ADDON_URL}/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: fixtureUrl, filename: FILENAME }),
    });
    expect(dlResp.status, 'addon /download response').toBe(200);

    const done = await waitForDownload(FILENAME, (d) => d.status === 'done', 'fixture download complete', 30000);
    expect(done.bytes, 'bytes downloaded').toBeGreaterThan(0);
    expect(done.path, 'absolute path returned').toContain(FILENAME);

    const catalog = await fetch(`${ADDON_URL}/catalog/movie/lan-remote-downloads.json`).then((r) => r.json());
    const metaEntry = catalog.metas.find((m) => m.id === `lan-dl:${encodeURIComponent(FILENAME)}`);
    expect(metaEntry, 'fixture appears in Deck Downloads catalog').toBeDefined();
    expect(metaEntry.name, 'catalog entry name has no [Downloading] suffix once done').not.toMatch(/\[Downloading/);

    const streamRes = await fetch(
      `${ADDON_URL}/stream/movie/${encodeURIComponent('lan-dl:' + FILENAME)}.json`
    ).then((r) => r.json());
    const castEntry = streamRes.streams.find((s) => s.name.startsWith('📺'));
    const deleteEntry = streamRes.streams.find((s) => s.name.startsWith('🗑'));
    expect(castEntry, 'Cast entry returned for downloaded file').toBeDefined();
    expect(deleteEntry, 'Delete entry returned for downloaded file').toBeDefined();
    expect(castEntry.externalUrl, 'Cast entry hits /cast_local').toContain('/cast_local');
    expect(deleteEntry.url, 'Delete entry hits /delete_download').toContain('/delete_download');

    const castResp = await fetch(castEntry.externalUrl);
    expect(castResp.status, 'cast_local returns 200 HTML').toBe(200);
    const html = await castResp.text();
    expect(html, 'controller HTML returned').toContain('Casting to Deck');

    const playing = await waitFor(
      (s) => s.direct_mode === true && Number(s.time_pos || 0) >= 0 && Number(s.duration || 0) > 0,
      'local-file playback reached direct_mode + has duration',
      30000
    );
    expect(playing.duration, 'duration loaded from local file').toBeGreaterThan(0);

    await stop();
  }, 4 * 60 * 1000);
});

describe.skipIf(skip)('cast → stop → cast across different movies (E2E, requires SteamDeck)', () => {
  it('plays three different movies in sequence with a stop between each', async () => {
    await stop();
    await new Promise((r) => setTimeout(r, 2000));

    for (const [imdbId, label] of MOVIES) {
      const stream = await getStream(imdbId);
      await cast(imdbId, stream);

      const ready = await waitFor(videoTrackSelected, `${label} video selected`, 60000);
      const vid = ready.track_list.find((t) => t.type === 'video' && t.selected === true);
      expect(vid['demux-w'], `${label} video width`).toBeGreaterThan(0);
      expect(vid['demux-h'], `${label} video height`).toBeGreaterThan(0);
      expect(ready.duration, `${label} duration loaded`).toBeGreaterThan(0);

      await stop();
      await waitFor((s) => s.direct_mode === false, `direct_mode reset after ${label}`, 5000);
      await new Promise((r) => setTimeout(r, 1500));
    }
  }, 6 * 60 * 1000);

  it('switches between three different movies WITHOUT stop, video updates each time', async () => {
    await stop();
    await new Promise((r) => setTimeout(r, 2000));

    let prevDuration = null;
    for (const [imdbId, label] of MOVIES) {
      const stream = await getStream(imdbId);
      await cast(imdbId, stream);

      const expectsNewDuration = (s) => {
        if (!videoTrackSelected(s)) return false;
        if (prevDuration == null) return true;
        return Math.abs(s.duration - prevDuration) > 1;
      };

      const ready = await waitFor(expectsNewDuration, `${label} video loaded with new duration`, 60000);
      const vid = ready.track_list.find((t) => t.type === 'video' && t.selected === true);
      expect(vid['demux-w'], `${label} video width`).toBeGreaterThan(0);
      expect(vid['demux-h'], `${label} video height`).toBeGreaterThan(0);
      expect(ready.duration, `${label} new duration`).toBeGreaterThan(0);
      prevDuration = ready.duration;
    }

    await stop();
  }, 6 * 60 * 1000);
});
