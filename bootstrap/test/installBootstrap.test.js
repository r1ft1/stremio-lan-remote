import { describe, it, expect, vi } from 'vitest';
import { installBootstrap } from '../src/installBootstrap.js';

function fakeWindow() {
  class MockWorker {
    constructor(url) {
      this.url = String(url);
      this.postMessage = vi.fn();
    }
  }
  return { Worker: MockWorker };
}

describe('installBootstrap', () => {
  it('captures the core worker when constructed with a worker.js URL', () => {
    const win = fakeWindow();
    installBootstrap(win);
    const w = new win.Worker('https://example.com/scripts/worker.js');
    expect(win.__lanRemote).toBeDefined();
    win.__lanRemote.dispatch({ action: 'Search' }, null, '#/search');
    expect(w.postMessage).toHaveBeenCalledTimes(1);
  });

  it('does not capture a non-worker.js worker', () => {
    const win = fakeWindow();
    installBootstrap(win);
    new win.Worker('https://example.com/other.js');
    expect(() => win.__lanRemote.dispatch({}, null, '')).toThrow(/not yet created/);
  });

  it('keeps the original Worker prototype', () => {
    const win = fakeWindow();
    const origProto = win.Worker.prototype;
    installBootstrap(win);
    expect(win.Worker.prototype).toBe(origProto);
  });
});

describe('dispatch envelope', () => {
  it('wraps action+field+locationHash in JSON-RPC request shape', () => {
    const win = fakeWindow();
    installBootstrap(win);
    const w = new win.Worker('worker.js');
    win.__lanRemote.dispatch(
      { action: 'Search', args: { action: 'Search', args: { searchQuery: 'foo', maxResults: 5 } } },
      null,
      '#/search',
    );
    const sent = w.postMessage.mock.calls[0][0];
    expect(sent.request.path).toEqual(['dispatch']);
    expect(sent.request.args[0]).toEqual({
      action: 'Search',
      args: { action: 'Search', args: { searchQuery: 'foo', maxResults: 5 } },
    });
    expect(sent.request.args[1]).toBe(null);
    expect(sent.request.args[2]).toBe('#/search');
    expect(typeof sent.request.id).toBe('string');
  });

  it('throws if called before worker is created', () => {
    const win = fakeWindow();
    installBootstrap(win);
    expect(() => win.__lanRemote.dispatch({}, null, '')).toThrow(/not yet created/);
  });
});

describe('cmd JSON wrapper', () => {
  it('forwards parsed JSON to dispatch', () => {
    const win = fakeWindow();
    installBootstrap(win);
    const w = new win.Worker('worker.js');
    win.__lanRemote.cmd(JSON.stringify({
      action: { action: 'Search', args: { action: 'Search', args: { searchQuery: 'x', maxResults: 5 } } },
      field: null,
      locationHash: '#/search',
    }));
    const sent = w.postMessage.mock.calls[0][0];
    expect(sent.request.args[0].action).toBe('Search');
    expect(sent.request.args[2]).toBe('#/search');
  });
});
