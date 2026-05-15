import { addonBuilder } from 'stremio-addon-sdk';
import { config } from './config.js';
import { resolveAllStreams } from './resolver.js';

export const manifest = {
  id: 'dev.stremiolanremote.addon',
  version: '0.4.0',
  name: 'LAN Remote',
  description: 'Cast playback to a Stremio LAN Remote desktop',
  resources: ['stream', 'catalog', 'meta'],
  types: ['movie', 'series'],
  catalogs: [
    { type: 'movie', id: 'lan-remote-downloads', name: 'Deck Downloads' },
  ],
  idPrefixes: ['tt', 'lan-dl:'],
};

function encodeStreamToken(stream) {
  return Buffer.from(JSON.stringify(stream), 'utf8').toString('base64url');
}

function seederCount(stream) {
  const text = `${stream.title || ''} ${stream.description || ''}`;
  const m = text.match(/👤\s*(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

function streamLabel(stream) {
  const seeders = seederCount(stream);
  const quality = stream.name ? stream.name.replace(/\n/g, ' • ') : '';
  const filename = (stream.title || stream.description || '').split('\n')[0];
  const seederTag = seeders > 0 ? ` • 👤 ${seeders}` : '';
  return `${quality}${seederTag} — ${filename}`.slice(0, 200);
}

function publicBase(host) {
  if (/^https?:\/\//i.test(host)) return host.replace(/\/+$/, '');
  return `https://${host}`;
}

function queryFor(id, stream) {
  const isSeries = id.includes(':');
  const baseId = isSeries ? id.split(':')[0] : id;
  return isSeries
    ? `id=${baseId}&season=${id.split(':')[1]}&episode=${id.split(':')[2]}&stream=${encodeStreamToken(stream)}`
    : `id=${baseId}&stream=${encodeStreamToken(stream)}`;
}

function castEntryFor({ stream, id, publicHost }) {
  return {
    name: `📺 Cast: ${streamLabel(stream)}`,
    title: 'Play on the Deck',
    externalUrl: `${publicBase(publicHost)}/cast?${queryFor(id, stream)}`,
  };
}

function downloadEntryFor({ stream, id, publicHost }) {
  return {
    name: `⬇ Download: ${streamLabel(stream)}`,
    title: 'Download to the Deck for later',
    externalUrl: `${publicBase(publicHost)}/download_trigger_html?${queryFor(id, stream)}`,
  };
}

function progressEntry({ entry, publicHost }) {
  const pct = entry.total > 0 ? Math.round((entry.bytes / entry.total) * 100) : 0;
  const fmt = (n) => {
    let v = Number(n) || 0;
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return v.toFixed(i ? 1 : 0) + ' ' + u[i];
  };
  const label = entry.total > 0
    ? `${pct}% • ${fmt(entry.bytes)} / ${fmt(entry.total)}`
    : `${fmt(entry.bytes)} downloaded so far`;
  return {
    name: `📥 ${label}`,
    title: 'Live download progress (refresh to update)',
    url: `${publicBase(publicHost)}/noop`,
    behaviorHints: { notWebReady: true },
  };
}

function prettyTitleFromFilename(filename) {
  return String(filename).replace(/\.(mkv|mp4|webm|avi|mov)$/i, '').replace(/[._]/g, ' ');
}

async function fetchDownloads() {
  try {
    const r = await fetch(`http://${config.shellHost}/downloads`);
    if (!r.ok) return [];
    return await r.json();
  } catch (e) {
    return [];
  }
}

function localStreamEntry({ entry, publicHost }) {
  const localUrl = `file://${entry.path}`;
  const token = encodeStreamToken({ url: localUrl, name: entry.filename });
  return {
    name: `📺 Cast: ${prettyTitleFromFilename(entry.filename)}`,
    title: 'Play downloaded file on the Deck',
    externalUrl: `${publicBase(publicHost)}/cast_local?stream=${token}&name=${encodeURIComponent(entry.filename)}`,
  };
}

function deleteDownloadEntry({ filename, publicHost }) {
  return {
    name: `🗑 Delete download`,
    title: 'Delete this downloaded file from the Deck',
    url: `${publicBase(publicHost)}/delete_download?filename=${encodeURIComponent(filename)}`,
    behaviorHints: { notWebReady: true },
  };
}

function cancelDownloadEntry({ filename, publicHost }) {
  return {
    name: `✗ Cancel download`,
    title: 'Cancel and remove the partial file from the Deck',
    url: `${publicBase(publicHost)}/cancel_download?filename=${encodeURIComponent(filename)}`,
    behaviorHints: { notWebReady: true },
  };
}

function resumeDownloadEntry({ filename, publicHost }) {
  return {
    name: `↻ Resume download`,
    title: 'Continue the interrupted download on the Deck',
    url: `${publicBase(publicHost)}/resume_download?filename=${encodeURIComponent(filename)}`,
    behaviorHints: { notWebReady: true },
  };
}

const builder = new addonBuilder(manifest);

builder.defineStreamHandler(async ({ type, id }) => {
  if (id.startsWith('lan-dl:')) {
    const filename = decodeURIComponent(id.slice('lan-dl:'.length));
    const list = await fetchDownloads();
    const entry = list.find((d) => d.filename === filename);
    if (!entry) return { streams: [] };
    if (entry.status === 'done') {
      return {
        streams: [
          localStreamEntry({ entry, publicHost: config.publicHost }),
          deleteDownloadEntry({ filename, publicHost: config.publicHost }),
        ],
      };
    }
    if (entry.status === 'downloading') {
      return {
        streams: [
          progressEntry({ entry, publicHost: config.publicHost }),
          cancelDownloadEntry({ filename, publicHost: config.publicHost }),
        ],
      };
    }
    if (entry.status === 'interrupted') {
      return {
        streams: [deleteDownloadEntry({ filename, publicHost: config.publicHost })],
      };
    }
    if (entry.status === 'unknown') {
      return {
        streams: [
          { ...localStreamEntry({ entry, publicHost: config.publicHost }),
            title: 'Play local file (completeness unknown)' },
          deleteDownloadEntry({ filename, publicHost: config.publicHost }),
        ],
      };
    }
    return {
      streams: [deleteDownloadEntry({ filename, publicHost: config.publicHost })],
    };
  }
  if (!config.streamResolverUrl) {
    return { streams: [] };
  }
  let streams;
  try {
    streams = await resolveAllStreams({ type, id, upstreamUrl: config.streamResolverUrl });
  } catch (e) {
    return { streams: [] };
  }
  const sorted = [...streams].sort((a, b) => seederCount(b) - seederCount(a));
  const entries = [];
  for (const s of sorted) {
    entries.push(castEntryFor({ stream: s, id, publicHost: config.publicHost }));
    if (s.infoHash) {
      entries.push(downloadEntryFor({ stream: s, id, publicHost: config.publicHost }));
    }
  }
  return { streams: entries };
});

function fmtBytes(n) {
  if (!n) return '0 B';
  let v = Number(n);
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return v.toFixed(i ? 1 : 0) + ' ' + u[i];
}

const CINEMETA_CACHE = new Map();
const CINEMETA_TTL_MS = 24 * 60 * 60 * 1000;

async function cinemetaLookup(metaId, type = 'movie') {
  if (!metaId) return null;
  const key = `${type}:${metaId}`;
  const cached = CINEMETA_CACHE.get(key);
  if (cached && cached.at + CINEMETA_TTL_MS > Date.now()) return cached.meta;
  try {
    const r = await fetch(`https://v3-cinemeta.strem.io/meta/${type}/${metaId}.json`);
    if (!r.ok) {
      CINEMETA_CACHE.set(key, { meta: null, at: Date.now() });
      return null;
    }
    const j = await r.json();
    const meta = j?.meta || null;
    CINEMETA_CACHE.set(key, { meta, at: Date.now() });
    return meta;
  } catch (e) {
    return null;
  }
}

function parseFilename(filename) {
  let s = String(filename).replace(/\.(mkv|mp4|webm|avi|mov|m4v)$/i, '');
  s = s.replace(/[._]/g, ' ').replace(/\s+/g, ' ').trim();
  const yearMatch = s.match(/\b(19\d{2}|20\d{2})\b/);
  const year = yearMatch ? yearMatch[0] : '';
  let title = s;
  if (yearMatch) {
    title = s.slice(0, yearMatch.index).trim();
  } else {
    title = s
      .split(/\s+(?=1080p|720p|2160p|480p|4K|BluRay|BDRip|WEBRip|WEB-DL|HEVC|x264|x265|REMUX|HDR|DV|DDP)/i)[0]
      .trim();
  }
  return { title, year };
}

async function cinemetaSearchByFilename(filename) {
  const key = `filename:${filename}`;
  const cached = CINEMETA_CACHE.get(key);
  if (cached && cached.at + CINEMETA_TTL_MS > Date.now()) return cached.meta;
  const { title, year } = parseFilename(filename);
  if (!title) {
    CINEMETA_CACHE.set(key, { meta: null, at: Date.now() });
    return null;
  }
  try {
    const r = await fetch(
      `https://v3-cinemeta.strem.io/catalog/movie/top/search=${encodeURIComponent(title)}.json`
    );
    if (!r.ok) {
      CINEMETA_CACHE.set(key, { meta: null, at: Date.now() });
      return null;
    }
    const j = await r.json();
    const metas = j?.metas || [];
    let match = null;
    if (year) {
      match = metas.find((m) => String(m.releaseInfo || '').startsWith(year));
    }
    if (!match) match = metas[0] || null;
    const full = match?.id ? await cinemetaLookup(match.id) : null;
    CINEMETA_CACHE.set(key, { meta: full, at: Date.now() });
    return full;
  } catch (e) {
    return null;
  }
}

builder.defineCatalogHandler(async ({ type, id }) => {
  if (id !== 'lan-remote-downloads') return { metas: [] };
  const list = await fetchDownloads();
  const order = (s) => (s === 'downloading' ? 0 : s === 'done' ? 1 : 2);
  const sorted = [...list].sort((a, b) => order(a.status) - order(b.status));
  const metas = await Promise.all(
    sorted.map(async (d) => {
      let suffix = '';
      if (d.status === 'downloading') {
        const pct = d.total > 0 ? Math.round((d.bytes / d.total) * 100) : 0;
        suffix = ` [Downloading ${pct}%]`;
      } else if (d.status !== 'done') {
        suffix = ` [${d.status}]`;
      }
      let cm = d.meta_id ? await cinemetaLookup(d.meta_id) : null;
      if (!cm) cm = await cinemetaSearchByFilename(d.filename);
      const baseName = cm?.name || prettyTitleFromFilename(d.filename);
      const displayName = d.status === 'done' ? baseName : baseName + suffix;
      const description =
        d.status === 'done'
          ? cm?.description || `Downloaded to ${d.path}`
          : `${fmtBytes(d.bytes)} / ${fmtBytes(d.total)} — ${d.status}`;
      const meta = {
        id: `lan-dl:${encodeURIComponent(d.filename)}`,
        type: 'movie',
        name: displayName,
        description,
        releaseInfo: cm?.releaseInfo || '',
      };
      if (cm?.poster) {
        meta.poster = cm.poster;
        meta.posterShape = cm.posterShape || 'poster';
      }
      if (cm?.background) meta.background = cm.background;
      if (cm?.logo) meta.logo = cm.logo;
      if (cm?.genres) meta.genres = cm.genres;
      return meta;
    })
  );
  return { metas, cacheMaxAge: 0, staleRevalidate: 0, staleError: 0 };
});

builder.defineMetaHandler(async ({ type, id }) => {
  if (!id.startsWith('lan-dl:')) return { meta: null };
  const filename = decodeURIComponent(id.slice('lan-dl:'.length));
  const list = await fetchDownloads();
  const entry = list.find((d) => d.filename === filename);
  let cm = entry?.meta_id ? await cinemetaLookup(entry.meta_id) : null;
  if (!cm && entry) cm = await cinemetaSearchByFilename(filename);
  const meta = {
    id,
    type: 'movie',
    name: cm?.name || prettyTitleFromFilename(filename),
    description: cm?.description || (entry ? `Downloaded to ${entry.path}` : 'Local file'),
  };
  if (cm?.poster) { meta.poster = cm.poster; meta.posterShape = cm.posterShape || 'poster'; }
  if (cm?.background) meta.background = cm.background;
  if (cm?.logo) meta.logo = cm.logo;
  if (cm?.genres) meta.genres = cm.genres;
  if (cm?.releaseInfo) meta.releaseInfo = cm.releaseInfo;
  if (cm?.cast) meta.cast = cm.cast;
  if (cm?.director) meta.director = cm.director;
  if (cm?.runtime) meta.runtime = cm.runtime;
  return { meta };
});

export const addonInterface = builder.getInterface();
