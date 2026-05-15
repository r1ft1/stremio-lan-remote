import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createServer } from '../src/server.js';
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
