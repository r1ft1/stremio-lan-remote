import { describe, it, expect } from 'vitest';
import { encodePlayerLoad, encodeSearch, encodeMetaDetailsLoad } from '../src/dispatchEncoder.js';

describe('encodePlayerLoad', () => {
  it('builds a torrent stream Load(Player) action', () => {
    const out = encodePlayerLoad({
      stream: {
        infoHash: '66672b822002b6f19af478fb7c886787afee5f9f',
        fileIdx: 91,
        announce: [],
        name: 'Torrentio\n1080p',
        description: 'Inception',
      },
      metaId: 'tt1375666',
      videoId: 'tt1375666',
      type: 'movie',
    });
    expect(out.action.action).toBe('Load');
    expect(out.action.args.model).toBe('Player');
    expect(out.action.args.args.stream.infoHash).toBe('66672b822002b6f19af478fb7c886787afee5f9f');
    expect(out.action.args.args.stream.fileIdx).toBe(91);
    expect(out.action.args.args.streamPath).toEqual({
      resource: 'stream',
      type: 'movie',
      id: 'tt1375666',
      extra: [],
    });
    expect(out.action.args.args.metaPath).toEqual({
      resource: 'meta',
      type: 'movie',
      id: 'tt1375666',
      extra: [],
    });
    expect(out.field).toBe('player');
  });

  it('handles HTTP direct URL streams', () => {
    const out = encodePlayerLoad({
      stream: { url: 'https://example.com/video.mp4', name: 'Direct' },
      metaId: 'tt0903747',
      videoId: 'tt0903747:2:3',
      type: 'series',
    });
    expect(out.action.args.args.stream.url).toBe('https://example.com/video.mp4');
    expect(out.action.args.args.stream.infoHash).toBeUndefined();
    expect(out.action.args.args.streamPath.id).toBe('tt0903747:2:3');
  });

  it('defaults fileIdx to 0 when missing', () => {
    const out = encodePlayerLoad({
      stream: { infoHash: 'abc', name: 'x' },
      metaId: 'tt0',
      videoId: 'tt0',
      type: 'movie',
    });
    expect(out.action.args.args.stream.fileIdx).toBe(0);
  });
});

describe('encodeSearch', () => {
  it('matches captured shape', () => {
    const out = encodeSearch('inception', 5);
    expect(out.action).toEqual({
      action: 'Search',
      args: {
        action: 'Search',
        args: { searchQuery: 'inception', maxResults: 5 },
      },
    });
    expect(out.field).toBe(null);
    expect(out.locationHash).toBe('#/search');
  });
});

describe('encodeMetaDetailsLoad', () => {
  it('matches captured shape for movie', () => {
    const out = encodeMetaDetailsLoad({ type: 'movie', metaId: 'tt1375666' });
    expect(out.action.args.args.metaPath.type).toBe('movie');
    expect(out.action.args.args.streamPath).toBe(null);
    expect(out.locationHash).toBe('#/detail/movie/tt1375666');
  });

  it('includes streamPath for series with videoId', () => {
    const out = encodeMetaDetailsLoad({ type: 'series', metaId: 'tt0903747', videoId: 'tt0903747:1:1' });
    expect(out.action.args.args.streamPath.id).toBe('tt0903747:1:1');
    expect(out.locationHash).toBe('#/detail/series/tt0903747/tt0903747:1:1');
  });
});
