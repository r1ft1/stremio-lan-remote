process.env.STREAM_RESOLVER_URL = 'http://upstream';
process.env.PUBLIC_HOST = '192.168.1.10:7000';

import { describe, it, expect, vi } from 'vitest';

let mockStreams = [];
let throwInResolver = false;

vi.mock('../src/resolver.js', () => ({
  resolveAllStreams: vi.fn(async () => {
    if (throwInResolver) throw new Error('boom');
    return mockStreams;
  }),
  resolveBestStream: vi.fn(),
}));

const { addonInterface } = await import('../src/index.js');

describe('stream handler', () => {
  it('returns one Cast entry per upstream stream', async () => {
    throwInResolver = false;
    mockStreams = [
      { name: 'Torrentio\n1080p', title: '1080p WEB-DL', infoHash: 'aaa', fileIdx: 0 },
      { name: 'Torrentio\n720p', title: '720p HEVC', infoHash: 'bbb', fileIdx: 1 },
    ];
    const res = await addonInterface.get('stream', 'movie', 'tt2222001');
    expect(res.streams).toHaveLength(2);
    expect(res.streams[0].name).toMatch(/Cast: Torrentio . 1080p/);
    expect(res.streams[1].name).toMatch(/Cast: Torrentio . 720p/);
  });

  it('encodes the full stream object in each URL', async () => {
    throwInResolver = false;
    mockStreams = [{ name: 'Torrentio\n1080p', infoHash: 'aaa', fileIdx: 0 }];
    const res = await addonInterface.get('stream', 'movie', 'tt2222002');
    const url = res.streams[0].externalUrl;
    expect(url).toMatch(/^http:\/\/192\.168\.1\.10:7000\/cast\?id=tt2222002&stream=/);
    const streamParam = new URL(url).searchParams.get('stream');
    const decoded = JSON.parse(Buffer.from(streamParam, 'base64url').toString('utf8'));
    expect(decoded.infoHash).toBe('aaa');
    expect(decoded.fileIdx).toBe(0);
  });

  it('passes season/episode for series', async () => {
    throwInResolver = false;
    mockStreams = [{ name: 'Torrentio\n1080p', infoHash: 'aaa', fileIdx: 0 }];
    const res = await addonInterface.get('stream', 'series', 'tt2222003:2:3');
    const url = res.streams[0].externalUrl;
    expect(url).toMatch(/id=tt2222003/);
    expect(url).toMatch(/season=2/);
    expect(url).toMatch(/episode=3/);
  });

  it('returns empty streams when upstream throws', async () => {
    throwInResolver = true;
    const res = await addonInterface.get('stream', 'movie', 'tt2222004');
    expect(res.streams).toEqual([]);
  });

  it('sorts by seeder count descending and shows 👤 N in the name', async () => {
    throwInResolver = false;
    mockStreams = [
      { name: 'Torrentio\n720p', title: 'low.mkv\n👤 5 💾 1 GB', infoHash: 'low', fileIdx: 0 },
      { name: 'Torrentio\n4k', title: 'high.mkv\n👤 200 💾 60 GB', infoHash: 'high', fileIdx: 0 },
      { name: 'Torrentio\n1080p', title: 'mid.mkv\n👤 50 💾 5 GB', infoHash: 'mid', fileIdx: 0 },
    ];
    const res = await addonInterface.get('stream', 'movie', 'tt2222005');
    expect(res.streams).toHaveLength(3);
    expect(res.streams[0].name).toMatch(/👤 200/);
    expect(res.streams[1].name).toMatch(/👤 50/);
    expect(res.streams[2].name).toMatch(/👤 5/);
    const url0 = new URL(res.streams[0].externalUrl).searchParams.get('stream');
    const decoded0 = JSON.parse(Buffer.from(url0, 'base64url').toString('utf8'));
    expect(decoded0.infoHash).toBe('high');
  });
});
