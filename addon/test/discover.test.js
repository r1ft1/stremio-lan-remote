import { describe, it, expect } from 'vitest';
import { cinemetaSearch, cinemetaPopular, cinemetaEpisodes } from '../src/discover.js';

const ok = (json) => ({ ok: true, json: async () => json });
const fail = () => ({ ok: false, status: 500, json: async () => ({}) });

describe('cinemetaSearch', () => {
  it('merges + normalizes movie and series results', async () => {
    const fetchFn = async (url) =>
      url.includes('/movie/')
        ? ok({ metas: [{ id: 'tt1', type: 'movie', name: 'Movie One', poster: 'p1', releaseInfo: '2013' }] })
        : ok({ metas: [{ id: 'tt2', type: 'series', name: 'Series Two', poster: 'p2', releaseInfo: '2020' }] });
    const res = await cinemetaSearch('two', { fetch: fetchFn });
    expect(res).toEqual([
      { id: 'tt1', type: 'movie', name: 'Movie One', poster: 'p1', year: '2013' },
      { id: 'tt2', type: 'series', name: 'Series Two', poster: 'p2', year: '2020' },
    ]);
  });

  it('returns [] for an empty query without fetching', async () => {
    let called = false;
    const fetchFn = async () => { called = true; return ok({ metas: [] }); };
    expect(await cinemetaSearch('   ', { fetch: fetchFn })).toEqual([]);
    expect(called).toBe(false);
  });

  it('tolerates a per-type failure', async () => {
    const fetchFn = async (url) =>
      url.includes('/movie/') ? fail() : ok({ metas: [{ id: 'tt2', type: 'series', name: 'S' }] });
    const res = await cinemetaSearch('x', { fetch: fetchFn });
    expect(res).toEqual([{ id: 'tt2', type: 'series', name: 'S', poster: null, year: null }]);
  });
});

describe('cinemetaPopular', () => {
  it('normalizes the catalog', async () => {
    const fetchFn = async () => ok({ metas: [{ id: 'tt9', name: 'Pop', poster: 'pp', releaseInfo: '2021' }] });
    expect(await cinemetaPopular('movie', { fetch: fetchFn })).toEqual([
      { id: 'tt9', type: 'movie', name: 'Pop', poster: 'pp', year: '2021' },
    ]);
  });
  it('returns [] on error', async () => {
    expect(await cinemetaPopular('series', { fetch: fail })).toEqual([]);
  });
});

describe('cinemetaEpisodes', () => {
  it('normalizes, drops season 0, sorts by season then episode', async () => {
    const fetchFn = async () =>
      ok({ meta: { videos: [
        { id: 'tt:2:1', season: 2, episode: 1, name: 'S2E1' },
        { id: 'tt:1:2', season: 1, number: 2, name: 'S1E2' },
        { id: 'tt:0:1', season: 0, episode: 1, name: 'Special' },
        { id: 'tt:1:1', season: 1, episode: 1, name: 'S1E1', released: '2020-01-01', thumbnail: 'th' },
      ] } });
    const eps = await cinemetaEpisodes('tt', { fetch: fetchFn });
    expect(eps.map((e) => `${e.season}x${e.episode}`)).toEqual(['1x1', '1x2', '2x1']);
    expect(eps[0]).toEqual({ id: 'tt:1:1', season: 1, episode: 1, name: 'S1E1', released: '2020-01-01', thumbnail: 'th' });
  });
  it('throws on fetch failure', async () => {
    await expect(cinemetaEpisodes('tt', { fetch: fail })).rejects.toThrow(/cinemeta 500/);
  });
});
