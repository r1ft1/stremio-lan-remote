import { homedir } from 'node:os';
import { join } from 'node:path';

export const config = {
  bind: process.env.BIND || '0.0.0.0:7000',
  shellHost: process.env.SHELL_HOST || '127.0.0.1:7001',
  streamResolverUrl: process.env.STREAM_RESOLVER_URL || '',
  publicHost: process.env.PUBLIC_HOST || '127.0.0.1:7000',
  castResponseMode: process.env.CAST_RESPONSE_MODE || 'placeholder',
  downloadDir: process.env.DOWNLOAD_DIR || join(homedir(), 'stremio-downloads'),
  serverUrl: process.env.SERVER_URL || 'http://127.0.0.1:11470',
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS) || 15 * 60 * 1000,
  minSeeders: Number(process.env.MIN_SEEDERS) || 3,
  retryWindowMs: Number(process.env.RETRY_WINDOW_MS) || 7 * 24 * 60 * 60 * 1000,
};
