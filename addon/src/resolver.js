export async function resolveBestStream({ type, id, upstreamUrl, fetch: fetchFn = fetch }) {
  const url = `${upstreamUrl}/stream/${type}/${id}.json`;
  const res = await fetchFn(url);
  if (!res.ok) {
    throw new Error(`upstream ${url} returned ${res.status}`);
  }
  const data = await res.json();
  if (!data.streams || data.streams.length === 0) {
    throw new Error(`no streams available for ${type}/${id}`);
  }
  return data.streams[0];
}
