import { addonBuilder } from 'stremio-addon-sdk';
import { config } from './config.js';
import { resolveAllStreams } from './resolver.js';

export const manifest = {
  id: 'dev.stremiolanremote.addon',
  version: '0.1.0',
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

function streamLabel(stream) {
  const parts = [];
  if (stream.name) parts.push(stream.name.replace(/\n/g, ' • '));
  if (stream.title) parts.push(stream.title.split('\n')[0]);
  if (stream.description && parts.length < 2) parts.push(stream.description.split('\n')[0]);
  return parts.join(' — ').slice(0, 200);
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
  return {
    streams: streams.map((s) => castEntryFor({ stream: s, type, id, publicHost: config.publicHost })),
  };
});

export const addonInterface = builder.getInterface();
