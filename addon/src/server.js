import express from 'express';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import sdk from 'stremio-addon-sdk';
const { getRouter } = sdk;
import { addonInterface } from './index.js';
import { encodePlayerLoad } from './dispatchEncoder.js';
import { resolveBestStream } from './resolver.js';
import { config } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLACEHOLDER = readFileSync(resolve(__dirname, '../assets/casting.mp4'));

export function createServer({
  resolver = ({ type, id }) =>
    resolveBestStream({ type, id, upstreamUrl: config.streamResolverUrl }),
  fetch: fetchFn = fetch,
  shellHost = config.shellHost,
} = {}) {
  const app = express();
  app.use(getRouter(addonInterface));

  app.get('/cast', async (req, res) => {
    try {
      const { id, season, episode } = req.query;
      const isSeries = season != null;
      const type = isSeries ? 'series' : 'movie';
      const videoId = isSeries ? `${id}:${season}:${episode}` : id;

      const stream = await resolver({ type, id: videoId });
      const action = encodePlayerLoad({ stream, metaId: id, videoId, type });

      const dispatchRes = await fetchFn(`http://${shellHost}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(action),
      });
      if (!dispatchRes.ok) {
        return res.status(502).send('shell dispatch failed');
      }

      res.set('Content-Type', 'video/mp4');
      res.send(PLACEHOLDER);
    } catch (e) {
      res.status(502).send(e.message);
    }
  });

  return app;
}
