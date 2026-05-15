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
    externalUrl: `http://${publicHost}/cast?${queryFor(id, stream)}`,
  };
}

function downloadEntryFor({ stream, id, publicHost }) {
  return {
    name: `⬇ Download: ${streamLabel(stream)}`,
    title: 'Download to the Deck for later',
    url: `http://${publicHost}/download_trigger?${queryFor(id, stream)}`,
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
    externalUrl: `http://${publicHost}/cast_local?stream=${token}&name=${encodeURIComponent(entry.filename)}`,
  };
}

const builder = new addonBuilder(manifest);

builder.defineStreamHandler(async ({ type, id }) => {
  if (id.startsWith('lan-dl:')) {
    const filename = decodeURIComponent(id.slice('lan-dl:'.length));
    const list = await fetchDownloads();
    const entry = list.find((d) => d.filename === filename);
    if (!entry || entry.status !== 'done') return { streams: [] };
    return {
      streams: [localStreamEntry({ entry, publicHost: config.publicHost })],
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

builder.defineCatalogHandler(async ({ type, id }) => {
  if (id !== 'lan-remote-downloads') return { metas: [] };
  const list = await fetchDownloads();
  const order = (s) => (s === 'downloading' ? 0 : s === 'done' ? 1 : 2);
  const sorted = [...list].sort((a, b) => order(a.status) - order(b.status));
  const metas = sorted.map((d) => {
    let suffix = '';
    if (d.status === 'downloading') {
      const pct = d.total > 0 ? Math.round((d.bytes / d.total) * 100) : 0;
      suffix = ` [Downloading ${pct}%]`;
    } else if (d.status !== 'done') {
      suffix = ` [${d.status}]`;
    }
    return {
      id: `lan-dl:${encodeURIComponent(d.filename)}`,
      type: 'movie',
      name: prettyTitleFromFilename(d.filename) + suffix,
      description:
        d.status === 'done'
          ? `Downloaded to ${d.path}`
          : `${fmtBytes(d.bytes)} / ${fmtBytes(d.total)} — ${d.status}`,
      releaseInfo: '',
    };
  });
  return { metas };
});

builder.defineMetaHandler(async ({ type, id }) => {
  if (!id.startsWith('lan-dl:')) return { meta: null };
  const filename = decodeURIComponent(id.slice('lan-dl:'.length));
  const list = await fetchDownloads();
  const entry = list.find((d) => d.filename === filename);
  return {
    meta: {
      id,
      type: 'movie',
      name: prettyTitleFromFilename(filename),
      description: entry ? `Downloaded to ${entry.path}` : 'Local file',
    },
  };
});

export const addonInterface = builder.getInterface();
