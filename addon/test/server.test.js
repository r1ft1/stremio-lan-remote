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

  it('returns placeholder MP4 and posts dispatch for series', async () => {
    const res = await request(app).get('/cast?id=tt0903747&season=2&episode=3');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/video\/mp4/);
    expect(shellPosts).toHaveLength(1);
    expect(shellPosts[0].url).toBe('http://127.0.0.1:7001/dispatch');
    const body = shellPosts[0].body;
    expect(body.action.action).toBe('Load');
    expect(body.action.args.model).toBe('Player');
    expect(body.action.args.args.streamPath.id).toBe('tt0903747:2:3');
    expect(body.field).toBe('player');
  });

  it('returns placeholder MP4 and posts dispatch for movie', async () => {
    const res = await request(app).get('/cast?id=tt0111161');
    expect(res.status).toBe(200);
    expect(shellPosts).toHaveLength(1);
    expect(shellPosts[0].body.action.args.args.streamPath.id).toBe('tt0111161');
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
