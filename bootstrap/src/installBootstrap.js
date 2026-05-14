export function installBootstrap(window) {
  window.__lanRemote = window.__lanRemote || {};
  let coreWorker = null;
  let nextId = 1;

  function emit(payload) {
    try {
      const h = window.webkit
        && window.webkit.messageHandlers
        && window.webkit.messageHandlers.lan_remote_log;
      if (h) h.postMessage(JSON.stringify(payload));
    } catch (e) {}
  }

  emit({ event: 'INSTALL', hasWorker: typeof window.Worker === 'function' });

  if (typeof window.Worker === 'function') {
    const OrigWorker = window.Worker;
    function PatchedWorker(scriptURL, options) {
      const w = new OrigWorker(scriptURL, options);
      const url = String(scriptURL);
      emit({ event: 'WORKER_CREATED', url, captured: !coreWorker && url.includes('worker.js') });
      if (url.includes('worker.js') && !coreWorker) {
        coreWorker = w;
      }
      return w;
    }
    PatchedWorker.prototype = OrigWorker.prototype;
    window.Worker = PatchedWorker;
  }

  window.__lanRemote.dispatch = function (action, field, locationHash) {
    emit({ event: 'DISPATCH_CALLED', hasWorker: !!coreWorker });
    if (!coreWorker) {
      throw new Error('lan-remote: core worker not yet created');
    }
    const id = 'lanremote_' + (nextId++);
    const envelope = {
      request: {
        id: id,
        path: ['dispatch'],
        args: [action, field == null ? null : field, locationHash || ''],
      },
    };
    coreWorker.postMessage(envelope);
    emit({ event: 'DISPATCH_SENT', id });
  };

  window.__lanRemote.cmd = function (json) {
    emit({ event: 'CMD_RECEIVED', length: json.length });
    const { action, field, locationHash } = JSON.parse(json);
    window.__lanRemote.dispatch(action, field == null ? null : field, locationHash || '');
    if (locationHash && typeof window.location !== 'undefined') {
      emit({ event: 'HASH_UPDATE', from: window.location.hash, to: locationHash });
      window.location.hash = locationHash.startsWith('#') ? locationHash.slice(1) : locationHash;
    }
  };
}
