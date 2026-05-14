import { addonBuilder } from 'stremio-addon-sdk';
import { config } from './config.js';
import { castUrl } from './castUrl.js';

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

builder.defineStreamHandler(async ({ type, id }) => ({
  streams: [
    {
      name: '📺 Cast to Deck',
      title: 'Play on the Deck',
      externalUrl: castUrl({ type, id, publicHost: config.publicHost }),
    },
  ],
}));

export const addonInterface = builder.getInterface();
