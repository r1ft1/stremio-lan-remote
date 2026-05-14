import { addonBuilder } from 'stremio-addon-sdk';
import { config } from './config.js';
import { resolveAllStreams } from './resolver.js';

export const manifest = {
  id: 'dev.stremiolanremote.addon',
  version: '0.3.0',
  name: 'LAN Remote',
  description: 'Cast playback to a Stremio LAN Remote desktop',
  resources: ['stream'],
  types: ['movie', 'series'],
  catalogs: [],
  idPrefixes: ['tt'],
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

function castEntryFor({ stream, type, id, publicHost }) {
  const isSeries = id.includes(':');
  const baseId = isSeries ? id.split(':')[0] : id;
  const query = isSeries
    ? `id=${baseId}&season=${id.split(':')[1]}&episode=${id.split(':')[2]}&stream=${encodeStreamToken(stream)}`
    : `id=${baseId}&stream=${encodeStreamToken(stream)}`;
  return {
    name: `📺 Cast: ${streamLabel(stream)}`,
    title: 'Play on the Deck',
    externalUrl: `http://${publicHost}/cast?${query}`,
  };
}

const builder = new addonBuilder(manifest);

builder.defineStreamHandler(async ({ type, id }) => {
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
  return {
    streams: sorted.map((s) => castEntryFor({ stream: s, type, id, publicHost: config.publicHost })),
  };
});

export const addonInterface = builder.getInterface();
