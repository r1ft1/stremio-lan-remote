import { describe, it, expect, vi } from 'vitest';
import { installBootstrap } from '../src/installBootstrap.js';

function fakeWindow() {
  return {
    WebAssembly: {
      instantiate: async () => ({ instance: { exports: { dispatch: () => {}, getState: () => {} } } }),
      instantiateStreaming: async () => ({ instance: { exports: { dispatch: () => {}, getState: () => {} } } }),
    },
  };
}

describe('installBootstrap WASM hook', () => {
  it('captures dispatch from WebAssembly.instantiate', async () => {
    const win = fakeWindow();
    installBootstrap(win);
    await win.WebAssembly.instantiate({}, {});
    expect(win.__lanRemote.dispatch).toBeDefined();
  });

  it('captures dispatch from WebAssembly.instantiateStreaming', async () => {
    const win = fakeWindow();
    installBootstrap(win);
    await win.WebAssembly.instantiateStreaming({}, {});
    expect(win.__lanRemote.dispatch).toBeDefined();
  });

  it('ignores instances without dispatch export', async () => {
    const win = fakeWindow();
    win.WebAssembly.instantiate = async () => ({ instance: { exports: {} } });
    installBootstrap(win);
    await win.WebAssembly.instantiate({}, {});
    expect(win.__lanRemote.dispatch).toBeUndefined();
  });

  it('still works if window has no instantiateStreaming', async () => {
    const win = fakeWindow();
    delete win.WebAssembly.instantiateStreaming;
    installBootstrap(win);
    await win.WebAssembly.instantiate({}, {});
    expect(win.__lanRemote.dispatch).toBeDefined();
  });
});

describe('cmd dispatcher', () => {
  it('forwards parsed action to captured dispatch', async () => {
    const win = fakeWindow();
    const dispatch = vi.fn();
    win.WebAssembly.instantiate = async () => ({ instance: { exports: { dispatch, getState: () => {} } } });
    installBootstrap(win);
    await win.WebAssembly.instantiate({}, {});

    win.__lanRemote.cmd(JSON.stringify({
      action: { Search: { search_query: 'foo', max_results: 10 } },
      field: '',
      locationHash: '#/search',
    }));

    expect(dispatch).toHaveBeenCalledWith(
      { Search: { search_query: 'foo', max_results: 10 } },
      '',
      '#/search',
    );
  });

  it('throws if cmd is called before dispatch is captured', () => {
    const win = fakeWindow();
    installBootstrap(win);
    expect(() => win.__lanRemote.cmd('{"action":{}}')).toThrow();
  });
});
