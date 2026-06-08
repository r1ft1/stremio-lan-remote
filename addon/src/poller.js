import { pickRelease } from './releaseSelect.js';
import { config } from './config.js';
import { loadSubs } from './subscriptions.js';
import { getDownloads, startDownload } from './downloader.js';

function isHandled(downloads, metaId) {
  return downloads.some((d) => {
    if (d.meta_id !== metaId) return false;
    const status = String(d.status);
    if (status.startsWith('error')) return false;   // retry failed downloads
    if (status === 'interrupted') return false;      // retry → startDownload resumes from partial file
    return true;                                      // done / downloading / cancelled / unknown block
  });
}

export async function pollOnce(deps) {
  const now = deps.now();
  const subs = await deps.loadSubs();
  for (const sub of subs) {
    let episodes;
    try {
      episodes = await deps.cinemetaEpisodes(sub.seriesId);
    } catch {
      continue;
    }
    const subAt = new Date(sub.subscribedAt).getTime();
    const downloads = deps.getDownloads();
    for (const ep of episodes) {
      const released = new Date(ep.released).getTime();
      if (!(released > subAt)) continue;
      if (released > now) continue;
      if (now - released > deps.retryWindowMs) continue;
      const metaId = `${sub.seriesId}:${ep.season}:${ep.episode}`;
      if (isHandled(downloads, metaId)) continue;

      let streams;
      try {
        streams = await deps.torrentioStreams('series', `${sub.seriesId}:${ep.season}:${ep.episode}`);
      } catch {
        continue;
      }
      const release = pickRelease(streams, { minSeeders: deps.minSeeders });
      if (!release) continue;

      const url = `${config.serverUrl}/${release.infoHash}/${release.fileIdx ?? 0}`;
      const base = `${sub.seriesId}.S${String(ep.season).padStart(2, '0')}E${String(ep.episode).padStart(2, '0')}`;
      deps.startDownload({ url, filename: `${base}.mkv`, meta_id: metaId, dir: config.downloadDir });
    }
  }
}

export function buildDeps({ fetchFn = fetch } = {}) {
  return {
    now: () => Date.now(),
    minSeeders: config.minSeeders,
    retryWindowMs: config.retryWindowMs,
    loadSubs: () => loadSubs(config.downloadDir),
    getDownloads,
    startDownload,
    cinemetaEpisodes: async (seriesId) => {
      const r = await fetchFn(`https://v3-cinemeta.strem.io/meta/series/${seriesId}.json`);
      if (!r.ok) return [];
      const j = await r.json();
      return (j?.meta?.videos || []).map((v) => ({
        season: v.season,
        episode: v.number ?? v.episode,
        released: v.released,
      }));
    },
    torrentioStreams: async (type, id) => {
      if (!config.streamResolverUrl) return [];
      const r = await fetchFn(`${config.streamResolverUrl}/stream/${type}/${id}.json`);
      if (!r.ok) return [];
      const j = await r.json();
      return j?.streams || [];
    },
  };
}

let timer = null;

export function startPoller() {
  const deps = buildDeps();
  const tick = () => { pollOnce(deps).catch((e) => console.error('poll error', e)); };
  tick();
  timer = setInterval(tick, config.pollIntervalMs);
  return () => clearInterval(timer);
}
