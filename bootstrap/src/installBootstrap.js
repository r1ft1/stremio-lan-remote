export function installBootstrap(window) {
  const WA = window.WebAssembly;
  const origInstantiate = WA.instantiate;
  const origInstantiateStreaming = WA.instantiateStreaming;

  window.__lanRemote = window.__lanRemote || {};

  function capture(result) {
    const instance = result && (result.instance || result);
    if (instance && instance.exports && typeof instance.exports.dispatch === 'function') {
      window.__lanRemote.dispatch = instance.exports.dispatch;
      window.__lanRemote.getState = instance.exports.getState;
    }
  }

  WA.instantiate = async function (...args) {
    const result = await origInstantiate.apply(this, args);
    capture(result);
    return result;
  };

  if (typeof origInstantiateStreaming === 'function') {
    WA.instantiateStreaming = async function (...args) {
      const result = await origInstantiateStreaming.apply(this, args);
      capture(result);
      return result;
    };
  }

  window.__lanRemote.cmd = function (json) {
    if (!window.__lanRemote.dispatch) {
      throw new Error('lan-remote: dispatch not captured yet');
    }
    const { action, field, locationHash } = JSON.parse(json);
    return window.__lanRemote.dispatch(action, field || '', locationHash || '');
  };
}
