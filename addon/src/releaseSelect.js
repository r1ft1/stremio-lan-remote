function seederCount(stream) {
  const text = `${stream.title || ''} ${stream.description || ''}`;
  const m = text.match(/👤\s*(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

function is1080p(stream) {
  const text = `${stream.name || ''} ${stream.title || ''}`;
  return /\b1080p\b/i.test(text);
}

// Conservative: only skip a release when it is tagged with a single foreign
// language AND shows no English/MULTi marker. Errs toward keeping a release.
function isForeignOnly(stream) {
  const title = `${stream.name || ''} ${stream.title || ''}`;
  // Only inspect the portion after the first SxxExx/quality marker, so a show
  // TITLE that starts with a language word (e.g. "Russian Doll") isn't treated
  // as a foreign-language tag.
  const m = title.match(/[._ ](?:S\d{2}E\d{2}|1080p|720p|2160p)/i);
  const text = m ? title.slice(m.index) : title;
  const foreign = /\b(VOSTFR|TRUEFRENCH|FRENCH|GERMAN|ITA|ITALIAN|SPANISH|CASTELLANO|LATINO|HINDI|RUSSIAN|KOREAN|JAPANESE|POLISH|PL|NORDIC|DUBBED)\b/i.test(text);
  const english = /\b(ENG|ENGLISH|MULTI)\b/i.test(text);
  return foreign && !english;
}

export function pickRelease(streams, { minSeeders = 3 } = {}) {
  const candidates = (streams || [])
    .filter((s) => s.infoHash)
    .filter(is1080p)
    .filter((s) => !isForeignOnly(s))
    .filter((s) => seederCount(s) >= minSeeders)
    .sort((a, b) => seederCount(b) - seederCount(a));
  return candidates[0] || null;
}
