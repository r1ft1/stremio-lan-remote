import { describe, it, expect } from 'vitest';
import { manifest } from '../src/index.js';

describe('manifest', () => {
  it('declares stream resource for movie and series', () => {
    expect(manifest.resources).toContain('stream');
    expect(manifest.types).toEqual(expect.arrayContaining(['movie', 'series']));
  });
});
