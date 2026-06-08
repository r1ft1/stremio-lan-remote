import { describe, it, expect } from 'vitest';
import { pickRelease } from '../src/releaseSelect.js';

const s = (name, title, infoHash = 'a'.repeat(40)) => ({ name, title, infoHash, fileIdx: 0 });

describe('pickRelease', () => {
  it('picks the most-seeded 1080p above the seeder threshold', () => {
    const streams = [
      s('Torrentio\n1080p', 'Show.S01E01.1080p.WEB\n👤 50'),
      s('Torrentio\n1080p', 'Show.S01E01.1080p.WEBRip\n👤 200'),
      s('Torrentio\n720p', 'Show.S01E01.720p.WEB\n👤 999'),
    ];
    const r = pickRelease(streams, { minSeeders: 3 });
    expect(r.title).toMatch(/👤 200/);
  });

  it('returns null when no 1080p meets the seeder threshold', () => {
    const streams = [s('1080p', 'X.1080p\n👤 1'), s('720p', 'X.720p\n👤 500')];
    expect(pickRelease(streams, { minSeeders: 3 })).toBeNull();
  });

  it('skips obviously foreign-only releases', () => {
    const streams = [
      s('1080p', 'X.S01E01.1080p.FRENCH\n👤 800'),
      s('1080p', 'X.S01E01.1080p.WEB-DL\n👤 100'),
    ];
    const r = pickRelease(streams, { minSeeders: 3 });
    expect(r.title).toMatch(/WEB-DL/);
  });

  it('keeps MULTi (has English) over a lower-seeded English-only', () => {
    const streams = [
      s('1080p', 'X.S01E01.1080p.MULTi\n👤 800'),
      s('1080p', 'X.S01E01.1080p.WEB-DL\n👤 100'),
    ];
    const r = pickRelease(streams, { minSeeders: 3 });
    expect(r.title).toMatch(/MULTi/);
  });

  it('ignores streams without an infoHash', () => {
    const streams = [{ name: '1080p', title: 'X.1080p\n👤 900', url: 'http://x' }];
    expect(pickRelease(streams, { minSeeders: 3 })).toBeNull();
  });
});
