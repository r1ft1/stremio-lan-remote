export function installBootstrap(window) {
  window.__lanRemote = window.__lanRemote || {};
  let coreWorker = null;
  let nextId = 1;

  if (typeof window.Worker === 'function') {
    const OrigWorker = window.Worker;
    function PatchedWorker(scriptURL, options) {
      const w = new OrigWorker(scriptURL, options);
      if (String(scriptURL).includes('worker.js') && !coreWorker) {
        coreWorker = w;
      }
      return w;
    }
    PatchedWorker.prototype = OrigWorker.prototype;
    window.Worker = PatchedWorker;
  }

  window.__lanRemote.dispatch = function (action, field, locationHash) {
    if (!coreWorker) {
      throw new Error('lan-remote: core worker not yet created');
    }
    const id = 'lanremote_' + (nextId++);
    coreWorker.postMessage({
      request: {
        id: id,
        path: ['dispatch'],
        args: [action, field == null ? null : field, locationHash || ''],
      },
    });
  };

  window.__lanRemote.cmd = function (json) {
    const { action, field, locationHash } = JSON.parse(json);
    return window.__lanRemote.dispatch(action, field == null ? null : field, locationHash || '');
  };
}
