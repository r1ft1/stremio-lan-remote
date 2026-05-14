import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';

await mkdir('dist', { recursive: true });
await build({
  entryPoints: ['src/entry.js'],
  bundle: true,
  format: 'iife',
  target: 'es2020',
  outfile: 'dist/injected.js',
  minify: false,
});
console.log('built dist/injected.js');
