import { gunzipSync } from 'node:zlib';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';

// Thrown when a search succeeds but yields no usable English subtitle.
export class NoSubtitlesError extends Error {
  constructor(message = 'no English subtitles found') {
    super(message);
    this.name = 'NoSubtitlesError';
  }
}

// Parse a Stremio meta id into the pieces the OpenSubtitles query + cache need.
//   "tt1588170"     -> { imdbId:'1588170', season:null, episode:null, cacheKey:'tt1588170' }
//   "tt0944947:1:7" -> { imdbId:'0944947', season:'1', episode:'7', cacheKey:'tt0944947_S1E7' }
// Returns null for anything that isn't a tt-prefixed id.
export function parseMetaId(id) {
  if (typeof id !== 'string') return null;
  const parts = id.split(':');
  const m = /^tt(\d+)$/i.exec(parts[0].trim());
  if (!m) return null;
  const imdbId = m[1];
  if (parts.length >= 3 && parts[1] !== '' && parts[2] !== '') {
    const season = parts[1];
    const episode = parts[2];
    return { imdbId, season, episode, cacheKey: `tt${imdbId}_S${season}E${episode}` };
  }
  return { imdbId, season: null, episode: null, cacheKey: `tt${imdbId}` };
}

// Build the OpenSubtitles legacy REST search URL (English only).
export function buildQueryUrl({ imdbId, season, episode }) {
  const base = 'https://rest.opensubtitles.org/search';
  if (season != null && episode != null) {
    return `${base}/episode-${episode}/imdbid-${imdbId}/season-${season}/sublanguageid-eng`;
  }
  return `${base}/imdbid-${imdbId}/sublanguageid-eng`;
}

// From the OpenSubtitles result array, choose the best full English .srt:
// srt only, exclude "foreign parts only" partials, prefer most-downloaded.
export function pickBest(results) {
  if (!Array.isArray(results)) return null;
  const cands = results
    .filter((x) => String(x?.SubFormat || '').toLowerCase() === 'srt')
    .filter((x) => !String(x?.MovieReleaseName || '').toLowerCase().includes('foreign parts only'))
    .sort((a, b) => Number(b?.SubDownloadsCnt || 0) - Number(a?.SubDownloadsCnt || 0));
  return cands[0] || null;
}

// Ad-line markers injected by subtitle sites; whole cue blocks containing any of
// these are dropped during cleaning.
const AD_MARKERS = [
  'osdb.link',
  'opensubtitles',
  'watch online movies',
  'do you want subtitles for any video',
  'subtitles by',
  'subtitles ßy',
];

// Strip spam ad cues and renumber the surviving cues sequentially.
export function cleanSrt(text) {
  const blocks = String(text).replace(/^﻿/, '').trim().split(/\r?\n\r?\n/);
  const out = [];
  let n = 0;
  for (const b of blocks) {
    const low = b.toLowerCase();
    if (AD_MARKERS.some((a) => low.includes(a))) continue;
    const lines = b.split(/\r?\n/);
    if (lines.length < 2) continue; // need at least a number line + timing line
    n += 1;
    out.push(`${n}\n${lines.slice(1).join('\n')}`);
  }
  return out.join('\n\n') + '\n';
}

// Fetch + clean + cache the best English subtitle for a parsed meta id.
// Returns the absolute path to the .srt on disk (readable by the shell's mpv,
// which shares $HOME inside the distrobox). Caches by cacheKey: a repeat call is
// an instant offline hit. `deps` are injectable for tests.
export async function fetchEnglishSub(meta, deps = {}) {
  const {
    fetch: fetchFn = fetch,
    gunzip = gunzipSync,
    cacheDir = join(homedir(), 'stremio-subs'),
  } = deps;
  if (!meta || !meta.imdbId || !meta.cacheKey) throw new NoSubtitlesError('no-id');

  mkdirSync(cacheDir, { recursive: true });
  const outPath = join(cacheDir, `${meta.cacheKey}.en.srt`);
  if (existsSync(outPath)) return outPath; // cache hit — no network

  const headers = { 'User-Agent': 'TemporaryUserAgent' };
  const searchUrl = buildQueryUrl(meta);
  const sr = await fetchFn(searchUrl, { headers });
  if (!sr.ok) throw new Error(`opensubtitles search ${sr.status}`);
  const best = pickBest(await sr.json());
  if (!best || !best.SubDownloadLink) throw new NoSubtitlesError();

  const dr = await fetchFn(best.SubDownloadLink, { headers });
  if (!dr.ok) throw new Error(`opensubtitles download ${dr.status}`);
  const srt = cleanSrt(gunzip(Buffer.from(await dr.arrayBuffer())).toString('utf8'));
  writeFileSync(outPath, srt, 'utf8');
  return outPath;
}
