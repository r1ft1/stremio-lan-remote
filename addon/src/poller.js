import { pickRelease } from './releaseSelect.js';
import { config } from './config.js';

function isHandled(downloads, metaId) {
  return downloads.some((d) => d.meta_id === metaId && !String(d.status).startsWith('error'));
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
