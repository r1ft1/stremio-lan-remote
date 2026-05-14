import { createServer } from '../src/server.js';
import { config } from '../src/config.js';

const [host, port] = config.bind.split(':');
createServer().listen(Number(port), host, () => {
  console.log(`addon listening on http://${host}:${port}`);
});
