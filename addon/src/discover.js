// Thin Cinemeta client for the Deck PWA: search, popular catalogs, episode lists.
// All functions take an injectable `fetch` for testing and are best-effort
// (search/popular return [] rather than throwing, so the UI never hard-fails).

const CINEMETA = 'https://v3-cinemeta.strem.io';

async function getJson(url, fetchFn) {
  const r = await fetchFn(url);
  if (!r.ok) throw new Error(`cinemeta ${r.status}`);
  return r.json();
}

function normMeta(m, type) {
  return {
    id: m.id,
    type: m.type || type,
    name: m.name,
    poster: m.poster || null,
    year: m.releaseInfo || m.year || null,
  };
}

// Search movies + series, merged. Empty query -> []. Per-type failure tolerated.
export async function cinemetaSearch(query, { fetch: fetchFn = fetch } = {}) {
  const q = encodeURIComponent(String(query || '').trim());
  if (!q) return [];
  const types = ['movie', 'series'];
  const lists = await Promise.all(
    types.map(async (type) => {
      try {
        const d = await getJson(`${CINEMETA}/catalog/${type}/top/search=${q}.json`, fetchFn);
        return (d.metas || []).map((m) => normMeta(m, type));
      } catch {
        return [];
      }
    })
  );
  return lists.flat();
}

// Popular catalog for one type. [] on error.
export async function cinemetaPopular(type = 'movie', { fetch: fetchFn = fetch } = {}) {
  try {
    const d = await getJson(`${CINEMETA}/catalog/${type}/top.json`, fetchFn);
    return (d.metas || []).map((m) => normMeta(m, type));
  } catch {
    return [];
  }
}

// Episode list for a series id. Throws on fetch failure (route maps to 502).
export async function cinemetaEpisodes(id, { fetch: fetchFn = fetch } = {}) {
  const d = await getJson(`${CINEMETA}/meta/series/${encodeURIComponent(id)}.json`, fetchFn);
  const videos = (d.meta && d.meta.videos) || [];
  return videos
    .map((v) => ({
      id: v.id,
      season: Number(v.season),
      episode: Number(v.episode ?? v.number),
      name: v.name || v.title || `Episode ${v.episode ?? v.number}`,
      released: v.released || null,
      thumbnail: v.thumbnail || null,
    }))
    .filter((v) => Number.isFinite(v.season) && v.season > 0 && Number.isFinite(v.episode))
    .sort((a, b) => a.season - b.season || a.episode - b.episode);
}
