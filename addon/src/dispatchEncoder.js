export function encodePlayerLoad({ stream, metaId, videoId, type }) {
  const streamObject = {
    name: stream.name ?? '',
    description: stream.description ?? '',
  };
  if (stream.infoHash) {
    streamObject.infoHash = stream.infoHash;
    streamObject.fileIdx = stream.fileIdx ?? 0;
    streamObject.announce = stream.announce ?? [];
    if (stream.sources) streamObject.sources = stream.sources;
  } else if (stream.url) {
    streamObject.url = stream.url;
  } else if (stream.ytId) {
    streamObject.ytId = stream.ytId;
  }

  return {
    action: {
      action: 'Load',
      args: {
        model: 'Player',
        args: {
          stream: streamObject,
          streamPath: {
            resource: 'stream',
            type,
            id: videoId,
            extra: [],
          },
          metaPath: {
            resource: 'meta',
            type,
            id: metaId,
            extra: [],
          },
          subtitlesPath: null,
          videoParams: null,
          videoId,
        },
      },
    },
    field: 'player',
    locationHash: '',
  };
}

export function encodeSearch(query, maxResults = 10) {
  return {
    action: {
      action: 'Search',
      args: {
        action: 'Search',
        args: {
          searchQuery: query,
          maxResults,
        },
      },
    },
    field: null,
    locationHash: '#/search',
  };
}

export function encodeMetaDetailsLoad({ type, metaId, videoId }) {
  const metaPath = { resource: 'meta', type, id: metaId, extra: [] };
  const streamPath = videoId
    ? { resource: 'stream', type, id: videoId, extra: [] }
    : null;
  const locationHash = videoId
    ? `#/detail/${type}/${metaId}/${videoId}`
    : `#/detail/${type}/${metaId}`;
  return {
    action: {
      action: 'Load',
      args: {
        model: 'MetaDetails',
        args: {
          metaPath,
          streamPath,
          guessStream: true,
        },
      },
    },
    field: 'meta_details',
    locationHash,
  };
}
