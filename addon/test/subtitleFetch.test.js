import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  parseMetaId,
  buildQueryUrl,
  pickBest,
  cleanSrt,
  fetchEnglishSub,
  NoSubtitlesError,
} from '../src/subtitleFetch.js';

describe('parseMetaId', () => {
  it('parses a movie id', () => {
    expect(parseMetaId('tt1588170')).toEqual({
      imdbId: '1588170', season: null, episode: null, cacheKey: 'tt1588170',
    });
  });
  it('parses a series episode id', () => {
    expect(parseMetaId('tt0944947:1:7')).toEqual({
      imdbId: '0944947', season: '1', episode: '7', cacheKey: 'tt0944947_S1E7',
    });
  });
  it('returns null for non-tt ids', () => {
    expect(parseMetaId('kitsu:42')).toBeNull();
    expect(parseMetaId('')).toBeNull();
    expect(parseMetaId(undefined)).toBeNull();
  });
});

describe('buildQueryUrl', () => {
  it('builds a movie search URL', () => {
    expect(buildQueryUrl({ imdbId: '1588170' })).toBe(
      'https://rest.opensubtitles.org/search/imdbid-1588170/sublanguageid-eng'
    );
  });
  it('builds a series search URL with season + episode', () => {
    expect(buildQueryUrl({ imdbId: '0944947', season: '1', episode: '7' })).toBe(
      'https://rest.opensubtitles.org/search/episode-7/imdbid-0944947/season-1/sublanguageid-eng'
    );
  });
});

describe('pickBest', () => {
  const r = (over) => ({ SubFormat: 'srt', SubDownloadsCnt: '1', MovieReleaseName: 'X', SubDownloadLink: 'u', ...over });
  it('picks the most-downloaded srt', () => {
    const best = pickBest([
      r({ SubDownloadsCnt: '10', MovieReleaseName: 'A' }),
      r({ SubDownloadsCnt: '500', MovieReleaseName: 'B' }),
      r({ SubDownloadsCnt: '50', MovieReleaseName: 'C' }),
    ]);
    expect(best.MovieReleaseName).toBe('B');
  });
  it('excludes non-srt formats', () => {
    expect(pickBest([r({ SubFormat: 'sub', SubDownloadsCnt: '999' })])).toBeNull();
  });
  it('excludes "Foreign parts only" partials', () => {
    const best = pickBest([
      r({ SubDownloadsCnt: '999', MovieReleaseName: '1080p BluRay (Foreign parts only)' }),
      r({ SubDownloadsCnt: '5', MovieReleaseName: 'Full English' }),
    ]);
    expect(best.MovieReleaseName).toBe('Full English');
  });
  it('returns null for empty / non-array', () => {
    expect(pickBest([])).toBeNull();
    expect(pickBest(null)).toBeNull();
  });
});

describe('cleanSrt', () => {
  it('strips ad cues and renumbers the rest', () => {
    const raw = [
      '1\n00:00:06,000 --> 00:00:12,074\nWatch Online Movies\nwww.osdb.link/lm',
      '2\n00:03:30,100 --> 00:03:33,297\nReal line one.',
      '3\n00:03:34,000 --> 00:03:36,000\nReal line two.',
      '4\n02:17:48,305 --> 02:18:48,738\nDo you want subtitles for any video?',
    ].join('\n\n');
    const out = cleanSrt(raw);
    expect(out).not.toMatch(/osdb\.link/i);
    expect(out).not.toMatch(/do you want subtitles/i);
    expect(out).toMatch(/Real line one\./);
    expect(out).toMatch(/Real line two\./);
    // renumbered 1,2 (ads removed)
    expect(out.startsWith('1\n00:03:30,100')).toBe(true);
    expect(out).toMatch(/\n\n2\n00:03:34,000/);
  });
  it('strips a UTF-8 BOM', () => {
    const out = cleanSrt('﻿1\n00:00:01,000 --> 00:00:02,000\nHi.');
    expect(out.startsWith('1\n')).toBe(true);
  });
});

describe('fetchEnglishSub', () => {
  let cacheDir;
  beforeEach(() => { cacheDir = mkdtempSync(join(tmpdir(), 'subs-')); });
  afterEach(() => { rmSync(cacheDir, { recursive: true, force: true }); });

  const srtBody = '1\n00:03:30,100 --> 00:03:33,297\nHello.\n';

  it('downloads, cleans, caches and returns the path on a cache miss', async () => {
    const calls = [];
    const fetchFn = async (url) => {
      calls.push(url);
      if (url.includes('/search/')) {
        return { ok: true, json: async () => [
          { SubFormat: 'srt', SubDownloadsCnt: '100', MovieReleaseName: 'BluRay', SubDownloadLink: 'https://dl/x.gz' },
        ] };
      }
      return { ok: true, arrayBuffer: async () => gzipSync(Buffer.from(srtBody)) };
    };
    const meta = parseMetaId('tt1588170');
    const path = await fetchEnglishSub(meta, { fetch: fetchFn, cacheDir });
    expect(path).toBe(join(cacheDir, 'tt1588170.en.srt'));
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf8')).toMatch(/Hello\./);
    expect(calls.length).toBe(2); // search + download
  });

  it('is a cache hit (no network) when the file already exists', async () => {
    const meta = parseMetaId('tt1588170');
    writeFileSync(join(cacheDir, 'tt1588170.en.srt'), srtBody, 'utf8');
    let called = false;
    const fetchFn = async () => { called = true; return { ok: false }; };
    const path = await fetchEnglishSub(meta, { fetch: fetchFn, cacheDir });
    expect(path).toBe(join(cacheDir, 'tt1588170.en.srt'));
    expect(called).toBe(false);
  });

  it('throws NoSubtitlesError when search yields nothing usable', async () => {
    const fetchFn = async () => ({ ok: true, json: async () => [] });
    const meta = parseMetaId('tt9999999');
    await expect(fetchEnglishSub(meta, { fetch: fetchFn, cacheDir })).rejects.toBeInstanceOf(NoSubtitlesError);
  });
});

import { fetchSub, LANGS } from '../src/subtitleFetch.js';
import { mkdtempSync as mkdtemp2, existsSync as exists2, rmSync as rm2 } from 'node:fs';
import { tmpdir as tmp2 } from 'node:os';
import { join as join2 } from 'node:path';
import { gzipSync as gz2 } from 'node:zlib';
import { buildQueryUrl as bq2, parseMetaId as pm2 } from '../src/subtitleFetch.js';

describe('language support', () => {
  it('buildQueryUrl uses the Japanese language code', () => {
    expect(bq2({ imdbId: '1588170' }, 'jpn')).toMatch(/sublanguageid-jpn$/);
    expect(bq2({ imdbId: '1588170' }, 'eng')).toMatch(/sublanguageid-eng$/);
  });
  it('fetchSub caches Japanese under a .ja.srt path', async () => {
    const dir = mkdtemp2(join2(tmp2(), 'subs-ja-'));
    const fetchFn = async (url) => url.includes('/search/')
      ? { ok: true, json: async () => [{ SubFormat: 'srt', SubDownloadsCnt: '9', MovieReleaseName: 'BluRay', SubDownloadLink: 'https://dl/x.gz' }] }
      : { ok: true, arrayBuffer: async () => gz2(Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nこんにちは\n')) };
    const path = await fetchSub(pm2('tt1588170'), { lang: 'jpn', fetch: fetchFn, cacheDir: dir });
    expect(path).toBe(join2(dir, 'tt1588170.ja.srt'));
    expect(exists2(path)).toBe(true);
    rm2(dir, { recursive: true, force: true });
  });
  it('LANGS maps eng/jpn to extensions', () => {
    expect(LANGS.eng.ext).toBe('en');
    expect(LANGS.jpn.ext).toBe('ja');
  });
});
