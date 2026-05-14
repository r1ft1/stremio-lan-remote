import { addonBuilder } from 'stremio-addon-sdk';
import { config } from './config.js';

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

const builder = new addonBuilder(manifest);
builder.defineStreamHandler(async () => ({ streams: [] }));
export const addonInterface = builder.getInterface();
