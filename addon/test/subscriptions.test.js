import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSubs, addSub, removeSub, isSubscribed } from '../src/subscriptions.js';

describe('subscriptions store', () => {
  let dir;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'sub-')); });

  it('starts empty', async () => {
    expect(await loadSubs(dir)).toEqual([]);
    expect(await isSubscribed(dir, 'tt1')).toBe(false);
  });

  it('adds idempotently with a timestamp', async () => {
    await addSub(dir, 'tt1', '2026-06-08T00:00:00Z');
    await addSub(dir, 'tt1', '2026-06-09T00:00:00Z');
    const subs = await loadSubs(dir);
    expect(subs).toHaveLength(1);
    expect(subs[0]).toEqual({ seriesId: 'tt1', subscribedAt: '2026-06-08T00:00:00Z' });
    expect(await isSubscribed(dir, 'tt1')).toBe(true);
  });

  it('removes', async () => {
    await addSub(dir, 'tt1', '2026-06-08T00:00:00Z');
    await removeSub(dir, 'tt1');
    expect(await isSubscribed(dir, 'tt1')).toBe(false);
  });
});
