import { createServer } from '../src/server.js';
import { config } from '../src/config.js';
import { initDownloads } from '../src/downloader.js';
import { startPoller } from '../src/poller.js';

const [host, port] = config.bind.split(':');

await initDownloads(config.downloadDir);

createServer().listen(Number(port), host, () => {
  console.log(`addon listening on http://${host}:${port}`);
  startPoller();
  console.log(`poller started (every ${config.pollIntervalMs / 60000} min)`);
});
