import { describe, it, expect, vi } from 'vitest';
import { resolveBestStream } from '../src/resolver.js';

describe('resolveBestStream', () => {
  it('returns the first stream from upstream', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      json: async () => ({ streams: [
        { name: 'X', title: '1080p', url: 'http://stream' },
        { name: 'X', title: '720p', url: 'http://stream2' },
      ]}),
    }));
    const result = await resolveBestStream({ type: 'movie', id: 'tt0', upstreamUrl: 'http://up', fetch: fetchFn });
    expect(result.url).toBe('http://stream');
    expect(fetchFn).toHaveBeenCalledWith('http://up/stream/movie/tt0.json');
  });

  it('throws when upstream returns no streams', async () => {
    const fetchFn = vi.fn(async () => ({ ok: true, json: async () => ({ streams: [] }) }));
    await expect(resolveBestStream({ type: 'movie', id: 'tt0', upstreamUrl: 'http://x', fetch: fetchFn }))
      .rejects.toThrow();
  });

  it('throws when upstream is unreachable', async () => {
    const fetchFn = vi.fn(async () => ({ ok: false, status: 500 }));
    await expect(resolveBestStream({ type: 'movie', id: 'tt0', upstreamUrl: 'http://x', fetch: fetchFn }))
      .rejects.toThrow();
  });
});

import { summarizeStreams } from '../src/resolver.js';

describe('summarizeStreams', () => {
  it('parses quality/seeders/size and emits a decodable token', () => {
    const streams = [
      { name: 'Torrentio\n1080p', title: 'Movie.2013.1080p.BluRay\n👤 200 💾 2.5 GB', infoHash: 'a'.repeat(40), fileIdx: 0 },
    ];
    const [s] = summarizeStreams(streams);
    expect(s.quality).toBe('1080P');
    expect(s.seeders).toBe(200);
    expect(s.size).toBe('2.5 GB');
    expect(s.label).toBe('Movie.2013.1080p.BluRay');
    const decoded = JSON.parse(Buffer.from(s.token, 'base64url').toString('utf8'));
    expect(decoded.infoHash).toBe('a'.repeat(40));
  });
  it('drops entries without infoHash or url', () => {
    expect(summarizeStreams([{ name: 'x', title: 'y' }])).toEqual([]);
    expect(summarizeStreams(null)).toEqual([]);
  });
});
