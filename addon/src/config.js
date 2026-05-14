export const config = {
  bind: process.env.BIND || '0.0.0.0:7000',
  shellHost: process.env.SHELL_HOST || '127.0.0.1:7001',
  streamResolverUrl: process.env.STREAM_RESOLVER_URL || '',
  publicHost: process.env.PUBLIC_HOST || '127.0.0.1:7000',
};
