import { describe, it, expect } from 'vitest';
import { addonInterface } from '../src/index.js';

describe('stream handler', () => {
  it('returns a single Cast to Deck stream for movie', async () => {
    const res = await addonInterface.get('stream', 'movie', 'tt0111161');
    expect(res.streams).toHaveLength(1);
    expect(res.streams[0].name).toMatch(/Cast to Deck/);
    const url = res.streams[0].externalUrl || res.streams[0].url;
    expect(url).toMatch(/\/cast\?id=tt0111161/);
  });

  it('passes season/episode for series', async () => {
    const res = await addonInterface.get('stream', 'series', 'tt0903747:2:3');
    const url = res.streams[0].externalUrl || res.streams[0].url;
    expect(url).toMatch(/season=2/);
    expect(url).toMatch(/episode=3/);
  });
});
