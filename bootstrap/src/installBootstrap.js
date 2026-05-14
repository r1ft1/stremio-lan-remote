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
}
