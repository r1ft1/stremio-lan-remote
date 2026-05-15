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

  function heartbeat() {
    try {
      const h = window.webkit
        && window.webkit.messageHandlers
        && window.webkit.messageHandlers.lan_remote_heartbeat;
      if (h) h.postMessage('1');
    } catch (e) {}
  }
  heartbeat();
  setInterval(heartbeat, 5000);

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

  function tryAutoplay() {
    const doc = window.document;
    if (!doc) return;
    const vids = doc.querySelectorAll('video');
    for (const v of vids) {
      try { v.play(); } catch (e) {}
    }
    const targets = [doc, doc.body, doc.getElementById('root'), doc.querySelector('.player'), doc.querySelector('.layer'), doc.querySelector('[class*="player"]'), doc.querySelector('[class*="video"]')].filter(Boolean);
    const keyOpts = (k, code, kc) => ({ key: k, code, keyCode: kc, which: kc, bubbles: true, cancelable: true });
    for (const t of targets) {
      try { t.dispatchEvent(new KeyboardEvent('keydown', keyOpts(' ', 'Space', 32))); } catch (e) {}
      try { t.dispatchEvent(new KeyboardEvent('keyup', keyOpts(' ', 'Space', 32))); } catch (e) {}
      try { t.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window })); } catch (e) {}
    }
    const playButtons = doc.querySelectorAll('button[class*="play" i], button[aria-label*="play" i], [class*="play-button" i], [class*="playButton"]');
    for (const b of playButtons) {
      try { b.click(); } catch (e) {}
    }
    emit({ event: 'AUTOPLAY_ATTEMPT', videoCount: vids.length, targets: targets.length, playButtons: playButtons.length });
  }

  function runProbe(name) {
    const w = window;
    if (name === 'globals') {
      const keys = Object.keys(w).filter((k) => /core|bridge|stremio|dispatch|store|redux|__/.test(k));
      emit({ probe: name, keys });
      return;
    }
    if (name === 'allGlobals') {
      emit({ probe: name, keys: Object.keys(w).slice(0, 200) });
      return;
    }
    if (name === 'core') {
      emit({ probe: name, exists: !!w.core, type: typeof w.core, keys: w.core ? Object.keys(w.core).slice(0, 50) : [] });
      return;
    }
    if (name === 'reactRoot') {
      const root = w.document.getElementById('root');
      const reactKey = root ? Object.keys(root).find((k) => k.startsWith('__reactContainer')) : null;
      emit({ probe: name, hasRoot: !!root, reactKey, allRootKeys: root ? Object.keys(root).filter((k) => k.startsWith('__react')) : [] });
      return;
    }
    if (name === 'findReactRoot') {
      const all = w.document.querySelectorAll('*');
      const reactMounts = [];
      for (const el of all) {
        const keys = Object.keys(el).filter((k) => k.startsWith('__reactContainer') || k.startsWith('__reactFiber') || k.startsWith('__reactProps'));
        if (keys.length > 0) {
          reactMounts.push({ tag: el.tagName, id: el.id || null, cls: String(el.className || '').slice(0, 60), keys: keys.slice(0, 3) });
          if (reactMounts.length >= 10) break;
        }
      }
      emit({ probe: name, mounts: reactMounts });
      return;
    }
    if (name === 'fiber') {
      const all = w.document.querySelectorAll('*');
      for (const el of all) {
        const containerKey = Object.keys(el).find((k) => k.startsWith('__reactContainer'));
        if (containerKey) {
          const fiber = el[containerKey];
          let node = fiber;
          let depth = 0;
          while (node && depth < 30) {
            if (node.stateNode && node.stateNode.store && typeof node.stateNode.store.dispatch === 'function') {
              emit({ probe: name, found: true, depth, hasGetState: !!node.stateNode.store.getState });
              w.__lanRemote.reduxStore = node.stateNode.store;
              return;
            }
            if (node.memoizedState && node.memoizedState.element) {
              const ctx = node.memoizedState.element.props && node.memoizedState.element.props.store;
              if (ctx && typeof ctx.dispatch === 'function') {
                emit({ probe: name, found: true, viaProps: true, depth });
                w.__lanRemote.reduxStore = ctx;
                return;
              }
            }
            node = node.child || node.return;
            depth++;
          }
          emit({ probe: name, found: false, traversed: depth });
          return;
        }
      }
      emit({ probe: name, found: false, noContainer: true });
      return;
    }
    if (name === 'worker') {
      emit({ probe: name, hasCoreWorker: !!coreWorker, onmessage: coreWorker ? typeof coreWorker.onmessage : 'no-worker' });
      return;
    }
    if (name === 'playerDom') {
      const doc = w.document;
      const playerEls = doc.querySelectorAll('[class*="layer"], [class*="player"], [class*="video"], video, button');
      const sample = Array.from(playerEls).slice(0, 30).map((el) => ({
        tag: el.tagName,
        cls: (el.className || '').toString().slice(0, 80),
        id: el.id || null,
        hasOnClick: !!el.onclick,
      }));
      emit({ probe: name, count: playerEls.length, sample });
      return;
    }
    if (name === 'ipc') {
      emit({ probe: name, hasIpc: !!w.ipc, ipcKeys: w.ipc ? Object.keys(w.ipc) : [], hasWebkitIpc: !!(w.webkit && w.webkit.messageHandlers && w.webkit.messageHandlers.ipc) });
      return;
    }
    if (name === 'streamEntries') {
      const doc = w.document;
      const candidates = doc.querySelectorAll('[class*="stream"], [class*="Stream"]');
      const sample = Array.from(candidates).slice(0, 15).map((el) => {
        const cls = String(el.className || '').slice(0, 80);
        const text = (el.textContent || '').slice(0, 100).trim();
        const props = Object.keys(el).find((k) => k.startsWith('__reactProps'));
        const propData = props ? Object.keys(el[props] || {}).slice(0, 10) : [];
        return { tag: el.tagName, cls, text, propData };
      });
      emit({ probe: name, count: candidates.length, sample });
      return;
    }
    emit({ probe: name, error: 'unknown probe' });
  }

  window.__lanRemote.cmd = function (json) {
    emit({ event: 'CMD_RECEIVED', length: json.length });
    const parsed = JSON.parse(json);
    if (parsed.probe) {
      runProbe(parsed.probe);
      return;
    }
    const { action, field, locationHash } = parsed;
    if (action) {
      window.__lanRemote.dispatch(action, field == null ? null : field, locationHash || '');
    }
    if (locationHash && typeof window.location !== 'undefined') {
      emit({ event: 'HASH_UPDATE', from: window.location.hash, to: locationHash });
      window.location.hash = locationHash.startsWith('#') ? locationHash.slice(1) : locationHash;
      if (locationHash.indexOf('/player/') !== -1) {
        setTimeout(tryAutoplay, 1500);
        setTimeout(tryAutoplay, 3500);
      }
    }
  };
}
