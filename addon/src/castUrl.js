export function castUrl({ type, id, publicHost }) {
  if (type === 'series') {
    const [imdb, season, episode] = id.split(':');
    return `http://${publicHost}/cast?id=${imdb}&season=${season}&episode=${episode}`;
  }
  return `http://${publicHost}/cast?id=${id}`;
}
