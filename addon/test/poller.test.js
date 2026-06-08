import { describe, it, expect, vi } from 'vitest';
import { pollOnce, buildDeps } from '../src/poller.js';

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

  it('retries an interrupted episode (calls startDownload)', async () => {
    const d = deps({ getDownloads: () => [{ meta_id: 'tt1:1:5', status: 'interrupted' }] });
    await pollOnce(d);
    expect(d.startDownload).toHaveBeenCalledTimes(1);
  });

  it('skips a cancelled episode (does not call startDownload)', async () => {
    const d = deps({ getDownloads: () => [{ meta_id: 'tt1:1:5', status: 'cancelled' }] });
    await pollOnce(d);
    expect(d.startDownload).not.toHaveBeenCalled();
  });
});

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
