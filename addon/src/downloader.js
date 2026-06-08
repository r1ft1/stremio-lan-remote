import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const PERSIST_FILE = '.downloads.json';

let DIR = null;
let LIST = [];

export async function loadDownloads(dir) {
  try {
    const raw = await readFile(join(dir, PERSIST_FILE), 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    for (const e of parsed) if (e.status === 'downloading') e.status = 'interrupted';
    return parsed;
  } catch {
    return [];
  }
}

export async function saveDownloads(dir, list) {
  await writeFile(join(dir, PERSIST_FILE), JSON.stringify(list));
}

export async function initDownloads(dir) {
  DIR = dir;
  await mkdir(dir, { recursive: true });
  LIST = await loadDownloads(dir);
  await saveDownloads(DIR, LIST);
  return LIST;
}

export function getDownloads() {
  return LIST;
}

export function _setStateForTest(dir, list) {
  DIR = dir;
  LIST = list;
}
