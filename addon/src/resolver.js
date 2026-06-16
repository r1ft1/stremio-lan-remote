export async function resolveBestStream({ type, id, upstreamUrl, fetch: fetchFn }) {
  const url = `${upstreamUrl}/stream/${type}/${id}.json`;
  const f = fetchFn || globalThis.fetch;
  const res = await f(url);
  if (!res.ok) {
    throw new Error(`upstream ${url} returned ${res.status}`);
  }
  const data = await res.json();
  if (!data.streams || data.streams.length === 0) {
    throw new Error(`no streams available for ${type}/${id}`);
  }
  return data.streams[0];
}

// Turn raw upstream (Torrentio) streams into compact picker rows for the PWA:
// a release label, parsed quality/seeders/size, and a base64url cast token that
// /cast already knows how to decode.
export function summarizeStreams(streams) {
  return (streams || [])
    .filter((s) => s && (s.infoHash || s.url))
    .map((s) => {
      const text = `${s.name || ''}\n${s.title || ''}\n${s.description || ''}`;
      const seed = text.match(/👤\s*(\d+)/);
      const size = text.match(/💾\s*([\d.]+\s*[KMGT]B)/i);
      const qual = text.match(/\b(2160p|4k|1080p|720p|480p)\b/i);
      const label = (s.title || s.name || '').split('\n')[0].trim() || 'Stream';
      return {
        label,
        quality: qual ? qual[1].toUpperCase() : '',
        seeders: seed ? Number(seed[1]) : 0,
        size: size ? size[1].replace(/\s+/g, ' ').trim() : '',
        token: Buffer.from(JSON.stringify(s), 'utf8').toString('base64url'),
      };
    });
}

export async function resolveAllStreams({ type, id, upstreamUrl, fetch: fetchFn }) {
  const url = `${upstreamUrl}/stream/${type}/${id}.json`;
  const f = fetchFn || globalThis.fetch;
  const res = await f(url);
  if (!res.ok) {
    throw new Error(`upstream ${url} returned ${res.status}`);
  }
  const data = await res.json();
  return data.streams || [];
}
