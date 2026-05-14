import { describe, it, expect } from 'vitest';
import { castUrl } from '../src/castUrl.js';

describe('castUrl', () => {
  it('produces a movie URL with id', () => {
    expect(castUrl({ type: 'movie', id: 'tt0111161', publicHost: '192.168.1.10:7000' }))
      .toBe('http://192.168.1.10:7000/cast?id=tt0111161');
  });
  it('produces a series URL with id, season, episode', () => {
    expect(castUrl({ type: 'series', id: 'tt0903747:2:3', publicHost: '192.168.1.10:7000' }))
      .toBe('http://192.168.1.10:7000/cast?id=tt0903747&season=2&episode=3');
  });
});
