import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createServer } from '../src/server.js';
import request from 'supertest';

// Builds a server whose fetch mock answers YouTube oEmbed lookups and records
// everything posted at the shell.
function makeApp({ oembedTitle = 'A Video Title', oembedOk = true } = {}) {
  const shellPosts = [];
  const oembedCalls = [];
  const fetchFn = vi.fn(async (url, opts) => {
    if (String(url).includes('/oembed')) {
      oembedCalls.push(String(url));
      if (!oembedOk) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ title: oembedTitle }) };
    }
    shellPosts.push({ url: String(url), body: JSON.parse(opts.body) });
    return { ok: true, status: 202 };
  });
  const app = createServer({
    resolver: vi.fn(),
    fetch: fetchFn,
    shellHost: '127.0.0.1:7001',
  });
  return { app, shellPosts, oembedCalls };
}

const playUrlOf = (posts) => posts.find((p) => p.url.endsWith('/play_url'));

describe('/cast_youtube', () => {
  let app, shellPosts, oembedCalls;

  beforeEach(() => {
    ({ app, shellPosts, oembedCalls } = makeApp());
  });

  it('casts a plain watch URL to the shell', async () => {
    const res = await request(app).get(
      '/cast_youtube?url=' + encodeURIComponent('https://www.youtube.com/watch?v=dQw4w9WgXcQ'),
    );
    expect(res.status).toBe(200);
    expect(playUrlOf(shellPosts).body.url).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  });

  it('returns the existing controller page so playback/volume can be driven', async () => {
    const res = await request(app).get(
      '/cast_youtube?url=' + encodeURIComponent('https://www.youtube.com/watch?v=dQw4w9WgXcQ'),
    );
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('set_volume');
    expect(res.text).toContain('seek_abs');
  });

  // Android's YouTube share sheet sends "Title https://youtu.be/ID" as `text`,
  // and frequently sends no `url` field at all.
  it('extracts the link out of Android share text', async () => {
    const res = await request(app).get(
      '/cast_youtube?text=' +
        encodeURIComponent('Check this out https://youtu.be/dQw4w9WgXcQ'),
    );
    expect(res.status).toBe(200);
    expect(playUrlOf(shellPosts).body.url).toBe('https://youtu.be/dQw4w9WgXcQ');
  });

  it('prefers the url field over a link buried in text', async () => {
    await request(app).get(
      '/cast_youtube?url=' +
        encodeURIComponent('https://youtu.be/AAAAAAAAAAA') +
        '&text=' +
        encodeURIComponent('see https://youtu.be/BBBBBBBBBBB'),
    );
    expect(playUrlOf(shellPosts).body.url).toBe('https://youtu.be/AAAAAAAAAAA');
  });

  it('keeps timestamp and playlist query parameters intact', async () => {
    const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=90s';
    await request(app).get('/cast_youtube?url=' + encodeURIComponent(url));
    expect(playUrlOf(shellPosts).body.url).toBe(url);
  });

  it('uses the oEmbed title for the now-playing label', async () => {
    await request(app).get(
      '/cast_youtube?url=' + encodeURIComponent('https://youtu.be/dQw4w9WgXcQ'),
    );
    expect(oembedCalls.length).toBe(1);
    expect(playUrlOf(shellPosts).body.title).toBe('A Video Title');
  });

  it('falls back to the shared title when oEmbed fails', async () => {
    ({ app, shellPosts } = makeApp({ oembedOk: false }));
    await request(app).get(
      '/cast_youtube?url=' +
        encodeURIComponent('https://youtu.be/dQw4w9WgXcQ') +
        '&title=' +
        encodeURIComponent('Shared Title'),
    );
    expect(playUrlOf(shellPosts).body.title).toBe('Shared Title');
  });

  it('still casts when oEmbed throws outright', async () => {
    const shellPosts2 = [];
    const fetchFn = vi.fn(async (url, opts) => {
      if (String(url).includes('/oembed')) throw new Error('network down');
      shellPosts2.push({ url: String(url), body: JSON.parse(opts.body) });
      return { ok: true, status: 202 };
    });
    const app2 = createServer({ resolver: vi.fn(), fetch: fetchFn, shellHost: '127.0.0.1:7001' });
    const res = await request(app2).get(
      '/cast_youtube?url=' + encodeURIComponent('https://youtu.be/dQw4w9WgXcQ'),
    );
    expect(res.status).toBe(200);
    expect(playUrlOf(shellPosts2)).toBeDefined();
  });

  it('rejects a request with no link in it', async () => {
    const res = await request(app).get('/cast_youtube?text=' + encodeURIComponent('no link here'));
    expect(res.status).toBe(400);
    expect(shellPosts.length).toBe(0);
  });

  // A share target accepts text from other apps, so anything that isn't a
  // remote http(s) URL must not reach mpv — file:// would read the Deck's disk.
  it('refuses non-http schemes', async () => {
    for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'ftp://host/x']) {
      const res = await request(app).get('/cast_youtube?url=' + encodeURIComponent(bad));
      expect(res.status).toBe(400);
    }
    expect(shellPosts.length).toBe(0);
  });
});

describe('PWA manifest share target', () => {
  it('declares a GET share target pointing at /cast_youtube', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/manifest.webmanifest');
    expect(res.status).toBe(200);
    const st = res.body.share_target;
    expect(st).toBeDefined();
    expect(st.action).toBe('/cast_youtube');
    expect((st.method || 'GET').toUpperCase()).toBe('GET');
    // The params YouTube's Android share sheet actually populates.
    expect(st.params).toMatchObject({ title: 'title', text: 'text', url: 'url' });
  });
});

describe('paste-a-link fallback in the PWA', () => {
  it('/app offers a form that submits to /cast_youtube', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/app');
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/action="\/cast_youtube"/);
    expect(res.text).toMatch(/name="url"/);
  });
});
