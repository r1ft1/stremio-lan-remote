import { createServer } from '../src/server.js';
import { config } from '../src/config.js';
import { initDownloads } from '../src/downloader.js';

const [host, port] = config.bind.split(':');

await initDownloads(config.downloadDir);

createServer().listen(Number(port), host, () => {
  console.log(`addon listening on http://${host}:${port}`);
});
