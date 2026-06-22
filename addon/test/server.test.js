import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createServer } from '../src/server.js';
import { NoSubtitlesError } from '../src/subtitleFetch.js';
import request from 'supertest';

describe('cast endpoint', () => {
  let app, shellPosts, resolver;

  beforeEach(() => {
    shellPosts = [];
    resolver = vi.fn(async () => ({ url: 'http://stream', name: 'X', description: 'd' }));
    const fetchFn = vi.fn(async (url, opts) => {
      shellPosts.push({ url, body: JSON.parse(opts.body) });
      return { ok: true, status: 202 };
    });
    app = createServer({ resolver, fetch: fetchFn, shellHost: '127.0.0.1:7001' });
  });

  it('posts Load(Player) and play_url for series', async () => {
    const res = await request(app).get('/cast?id=tt0903747&season=2&episode=3');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(shellPosts.length).toBeGreaterThanOrEqual(1);
    const dispatch = shellPosts.find((p) => p.url.endsWith('/dispatch'));
    expect(dispatch).toBeDefined();
    expect(dispatch.body.action.action).toBe('Load');
    expect(dispatch.body.action.args.model).toBe('Player');
    expect(dispatch.body.locationHash).toMatch(/^#\/player\//);
  });

  it('posts Load(Player) for movie', async () => {
    const res = await request(app).get('/cast?id=tt0111161');
    expect(res.status).toBe(200);
    const dispatch = shellPosts.find((p) => p.url.endsWith('/dispatch'));
    expect(dispatch.body.action.action).toBe('Load');
    expect(dispatch.body.locationHash).toMatch(/^#\/player\//);
  });

  it('posts streaming server URL to /play_url when stream has infoHash', async () => {
    const stream = { infoHash: 'a'.repeat(40), fileIdx: 5, name: 'X' };
    const token = Buffer.from(JSON.stringify(stream), 'utf8').toString('base64url');
    await request(app).get(`/cast?id=tt0111161&stream=${token}`);
    const playUrl = shellPosts.find((p) => p.url.endsWith('/play_url'));
    expect(playUrl).toBeDefined();
    expect(playUrl.body.url).toBe('http://127.0.0.1:11470/' + 'a'.repeat(40) + '/5');
  });

  it('returns placeholder MP4 when ?placeholder=1 is set', async () => {
    const res = await request(app).get('/cast?id=tt0111161&placeholder=1');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/video\/mp4/);
  });

  it('rejects invalid infoHash with 400 and does not touch the shell', async () => {
    const stream = { infoHash: 'aaa', fileIdx: 0, name: 'Bogus' };
    const token = Buffer.from(JSON.stringify(stream), 'utf8').toString('base64url');
    const res = await request(app).get(`/cast?id=tt0111161&stream=${token}`);
    expect(res.status).toBe(400);
    expect(shellPosts.length).toBe(0);
  });

  it('dry_run=1 returns controller HTML without dispatching to the shell', async () => {
    const stream = { infoHash: 'c'.repeat(40), fileIdx: 0, name: 'X' };
    const token = Buffer.from(JSON.stringify(stream), 'utf8').toString('base64url');
    const res = await request(app).get(`/cast?id=tt0111161&dry_run=1&stream=${token}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(shellPosts.length).toBe(0);
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

  it('uses pre-encoded stream token when provided (no resolver call)', async () => {
    const stream = { infoHash: 'b'.repeat(40), fileIdx: 5, name: 'Picked stream', announce: [] };
    const token = Buffer.from(JSON.stringify(stream), 'utf8').toString('base64url');
    const res = await request(app).get(`/cast?id=tt0111161&stream=${token}`);
    expect(res.status).toBe(200);
    expect(resolver).not.toHaveBeenCalled();
    const dispatch = shellPosts.find((p) => p.url.endsWith('/dispatch'));
    expect(dispatch.body.locationHash).toMatch(/^#\/player\//);
  });
});

describe('manifest served by Express server', () => {
  it('serves /manifest.json from the addon SDK router', async () => {
    const app = createServer({
      resolver: async () => ({}),
      fetch: async () => ({ ok: true }),
      shellHost: '127.0.0.1:7001',
    });
    const res = await request(app).get('/manifest.json');
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('dev.stremiolanremote.addon');
    expect(res.body.resources).toContain('stream');
  });
});

import { _setStateForTest } from '../src/downloader.js';

describe('addon-owned downloads', () => {
  it('/downloads returns the local downloader list', async () => {
    _setStateForTest('/tmp', [{ filename: 'a.mkv', status: 'done', meta_id: 'tt1:1:1' }]);
    const app = createServer({ fetch: vi.fn(), shellHost: '127.0.0.1:7001' });
    const res = await request(app).get('/downloads');
    expect(res.status).toBe(200);
    expect(res.body[0].filename).toBe('a.mkv');
  });
});

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

describe('get_subtitles endpoint', () => {
  it('fetches subs and posts the path to the shell /sub_add', async () => {
    const subPosts = [];
    const fetchFn = vi.fn(async (url, opts) => {
      if (url.endsWith('/sub_add')) subPosts.push(JSON.parse(opts.body));
      return { ok: true, status: 202 };
    });
    const getSubtitles = vi.fn(async () => '/home/deck/stremio-subs/tt1588170.en.srt');
    const app = createServer({ fetch: fetchFn, shellHost: '127.0.0.1:7001', getSubtitles });
    const res = await request(app).post('/get_subtitles').send({ id: 'tt1588170', type: 'movie' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(getSubtitles).toHaveBeenCalledWith(
      expect.objectContaining({ imdbId: '1588170', cacheKey: 'tt1588170' }),
      expect.anything(),
    );
    expect(subPosts).toEqual([{ url: '/home/deck/stremio-subs/tt1588170.en.srt' }]);
  });

  it('returns 400 no-id for an unparseable id', async () => {
    const app = createServer({ fetch: vi.fn(), shellHost: '127.0.0.1:7001', getSubtitles: vi.fn() });
    const res = await request(app).post('/get_subtitles').send({ id: 'kitsu:42' });
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe('no-id');
  });

  it('returns 404 when no subtitles are found', async () => {
    const getSubtitles = vi.fn(async () => { throw new NoSubtitlesError('no English subtitles found'); });
    const app = createServer({ fetch: vi.fn(), shellHost: '127.0.0.1:7001', getSubtitles });
    const res = await request(app).post('/get_subtitles').send({ id: 'tt9999999' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ ok: false, reason: 'no English subtitles found' });
  });

  it('passes the requested language through to the fetcher', async () => {
    const getSubtitles = vi.fn(async () => '/home/deck/stremio-subs/tt1588170.ja.srt');
    const fetchFn = vi.fn(async () => ({ ok: true, status: 202 }));
    const app = createServer({ fetch: fetchFn, shellHost: '127.0.0.1:7001', getSubtitles });
    await request(app).post('/get_subtitles').send({ id: 'tt1588170', lang: 'jpn' });
    expect(getSubtitles).toHaveBeenCalledWith(
      expect.objectContaining({ imdbId: '1588170' }),
      expect.objectContaining({ lang: 'jpn' }),
    );
  });

  it('loads a secondary (dual) sub: adds it, sets secondary-sid, restores primary', async () => {
    const calls = [];
    const fetchFn = vi.fn(async (url, opts) => {
      calls.push({ url, body: opts && opts.body ? JSON.parse(opts.body) : null });
      if (url.endsWith('/state')) {
        // first /state = before (English primary sid=1); second = after add (new track id=2)
        const nth = calls.filter((c) => c.url.endsWith('/state')).length;
        const tracks = nth === 1
          ? [{ type: 'sub', id: 1, 'external-filename': '/home/deck/stremio-subs/x.en.srt' }]
          : [{ type: 'sub', id: 1, 'external-filename': '/home/deck/stremio-subs/x.en.srt' },
             { type: 'sub', id: 2, 'external-filename': '/home/deck/stremio-subs/tt1.ja.srt' }];
        return { ok: true, json: async () => ({ sid: 1, track_list: tracks }) };
      }
      return { ok: true, status: 202 };
    });
    const getSubtitles = vi.fn(async () => '/home/deck/stremio-subs/tt1.ja.srt');
    const app = createServer({ fetch: fetchFn, shellHost: '127.0.0.1:7001', getSubtitles });
    const res = await request(app).post('/get_subtitles').send({ id: 'tt1', lang: 'jpn', secondary: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, secondary: true, id: 2 });
    const setTracks = calls.filter((c) => c.url.endsWith('/set_track')).map((c) => c.body);
    expect(setTracks).toContainEqual({ kind: 'secondary-sid', id: '2' });
    expect(setTracks).toContainEqual({ kind: 'sid', id: '1' }); // primary restored
  });
});

describe('Deck PWA routes', () => {
  it('serves /app as installable HTML', async () => {
    const app = createServer({ fetch: vi.fn(), shellHost: '127.0.0.1:7001' });
    const res = await request(app).get('/app');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toMatch(/manifest\.webmanifest/);
    expect(res.text).toMatch(/id="q"/); // search box
  });

  it('serves a valid web manifest', async () => {
    const app = createServer({ fetch: vi.fn(), shellHost: '127.0.0.1:7001' });
    const res = await request(app).get('/manifest.webmanifest');
    expect(res.status).toBe(200);
    expect(res.body.start_url).toBe('/app');
    expect(res.body.display).toBe('standalone');
    expect(res.body.icons.length).toBeGreaterThan(0);
  });

  it('serves png icons', async () => {
    const app = createServer({ fetch: vi.fn(), shellHost: '127.0.0.1:7001' });
    const res = await request(app).get('/icons/icon-192.png');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
  });

  it('/api/search proxies Cinemeta and returns normalized results', async () => {
    const fetchFn = vi.fn(async (url) =>
      url.includes('/movie/')
        ? { ok: true, json: async () => ({ metas: [{ id: 'tt1', type: 'movie', name: 'M', poster: 'p', releaseInfo: '2013' }] }) }
        : { ok: true, json: async () => ({ metas: [] }) }
    );
    const app = createServer({ fetch: fetchFn, shellHost: '127.0.0.1:7001' });
    const res = await request(app).get('/api/search?q=m');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: 'tt1', type: 'movie', name: 'M', poster: 'p', year: '2013' }]);
  });

  it('/api/meta returns episodes', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      json: async () => ({ meta: { videos: [{ id: 'tt:1:1', season: 1, episode: 1, name: 'Pilot' }] } }),
    }));
    const app = createServer({ fetch: fetchFn, shellHost: '127.0.0.1:7001' });
    const res = await request(app).get('/api/meta?id=tt0944947');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: 'tt:1:1', season: 1, episode: 1, name: 'Pilot', released: null, thumbnail: null }]);
  });

  it('/api/meta 400s without an id', async () => {
    const app = createServer({ fetch: vi.fn(), shellHost: '127.0.0.1:7001' });
    const res = await request(app).get('/api/meta');
    expect(res.status).toBe(400);
  });
});

describe('/api/streams', () => {
  it('returns summarized streams for a movie', async () => {
    const fetchFn = vi.fn(async (url) => {
      if (url.includes('/stream/movie/tt1706620')) {
        return { ok: true, json: async () => ({ streams: [
          { name: 'Torrentio\n1080p', title: 'Snow.2013.1080p.BluRay\n👤 150 💾 2.1 GB', infoHash: 'b'.repeat(40), fileIdx: 0 },
        ] }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });
    const app = createServer({ fetch: fetchFn, shellHost: '127.0.0.1:7001' });
    const res = await request(app).get('/api/streams?id=tt1706620&type=movie');
    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({ quality: '1080P', seeders: 150, size: '2.1 GB', label: 'Snow.2013.1080p.BluRay' });
    expect(typeof res.body[0].token).toBe('string');
  });

  it('builds the series id from season/episode', async () => {
    let seen = '';
    const fetchFn = vi.fn(async (url) => { seen = url; return { ok: true, json: async () => ({ streams: [] }) }; });
    const app = createServer({ fetch: fetchFn, shellHost: '127.0.0.1:7001' });
    await request(app).get('/api/streams?id=tt0944947&type=series&season=1&episode=7');
    expect(seen).toMatch(/\/stream\/series\/tt0944947:1:7\.json/);
  });

  it('400s without an id', async () => {
    const app = createServer({ fetch: vi.fn(), shellHost: '127.0.0.1:7001' });
    expect((await request(app).get('/api/streams')).status).toBe(400);
  });
});

describe('token auth', () => {
  const T = 'secrettoken123';
  const mk = () => createServer({ fetch: vi.fn(async()=>({ok:true,status:202,json:async()=>({metas:[]})})), shellHost: '127.0.0.1:7001', deckToken: T });

  it('blocks a protected route without a token', async () => {
    const res = await request(mk()).get('/app');
    expect(res.status).toBe(401);
  });
  it('accepts ?token= and sets an auth cookie', async () => {
    const res = await request(mk()).get('/app?token=' + T);
    expect(res.status).toBe(200);
    expect(String(res.headers['set-cookie'])).toMatch(/deck_token=secrettoken123/);
  });
  it('accepts a valid cookie', async () => {
    const res = await request(mk()).get('/app').set('Cookie', 'deck_token=' + T);
    expect(res.status).toBe(200);
  });
  it('rejects a wrong token', async () => {
    expect((await request(mk()).get('/app?token=nope')).status).toBe(401);
    expect((await request(mk()).get('/app').set('Cookie', 'deck_token=nope')).status).toBe(401);
  });
  it('leaves the Stremio manifest + PWA shell assets open', async () => {
    expect((await request(mk()).get('/manifest.json')).status).toBe(200);
    expect((await request(mk()).get('/manifest.webmanifest')).status).toBe(200);
    expect((await request(mk()).get('/icons/icon-192.png')).status).toBe(200);
  });
  it('is open when no token is configured', async () => {
    const open = createServer({ fetch: vi.fn(), shellHost: '127.0.0.1:7001' });
    expect((await request(open).get('/app')).status).toBe(200);
  });
});
