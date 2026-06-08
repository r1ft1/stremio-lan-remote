import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const FILE = 'subscriptions.json';

export async function loadSubs(dir) {
  try {
    const parsed = JSON.parse(await readFile(join(dir, FILE), 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function save(dir, subs) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, FILE), JSON.stringify(subs));
}

export async function isSubscribed(dir, seriesId) {
  return (await loadSubs(dir)).some((s) => s.seriesId === seriesId);
}

export async function addSub(dir, seriesId, subscribedAt) {
  const subs = await loadSubs(dir);
  if (subs.some((s) => s.seriesId === seriesId)) return;
  subs.push({ seriesId, subscribedAt });
  await save(dir, subs);
}

export async function removeSub(dir, seriesId) {
  const subs = (await loadSubs(dir)).filter((s) => s.seriesId !== seriesId);
  await save(dir, subs);
}
