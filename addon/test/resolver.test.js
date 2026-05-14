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
