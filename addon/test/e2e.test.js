import { describe, it, expect } from 'vitest';

const ADDON_URL = process.env.E2E_ADDON_URL;
const SHELL_URL = process.env.E2E_SHELL_URL;
const skip = !ADDON_URL || !SHELL_URL;

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
  const r = await fetch(`${SHELL_URL}/stop`, { method: 'POST' });
  if (!r.ok && r.status !== 202) throw new Error(`stop failed: ${r.status}`);
}

async function getState() {
  const r = await fetch(`${SHELL_URL}/state`);
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
