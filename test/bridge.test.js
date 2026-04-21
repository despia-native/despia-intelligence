'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const INDEX_PATH = path.join(__dirname, '..', 'index.js');
const INDEX_SRC = fs.readFileSync(INDEX_PATH, 'utf8');

function loadInDespiaBridgeContext() {
  const hrefLog = [];
  const window = {
    native_runtime: 'despia',
    intelligence_available: true,
    intelligence: {},
    focusout: null,
    focusin: null,
  };
  window.location = {};
  Object.defineProperty(window.location, 'href', {
    configurable: true,
    enumerable: true,
    get() {
      return window._href || '';
    },
    set(u) {
      hrefLog.push(u);
      window._href = u;
    },
  });

  const navigator = { userAgent: 'Mozilla/5.0 despia-test' };
  const module = { exports: {} };
  const sandbox = {
    window,
    navigator,
    module,
    exports: module.exports,
    self: window,
    crypto: {
      randomUUID() {
        return '11111111-1111-4111-8111-111111111111';
      },
    },
    define: undefined,
  };
  sandbox.globalThis = sandbox;

  const context = vm.createContext(sandbox);
  vm.runInContext(INDEX_SRC, context, { filename: 'index.js' });

  return { intelligence: module.exports, hrefLog, window: sandbox.window };
}

test('loads under Node (no window): runtime not ready, run returns NotReady shape', () => {
  delete global.window;
  delete global.navigator;
  const intelligence = require('../index.js');
  assert.equal(intelligence.runtime.ok, false);
  assert.equal(intelligence.runtime.status, 'unavailable');
  const call = intelligence.run(
    { type: 'text', model: 'qwen3-0.6b', prompt: 'x' },
    {},
  );
  assert.equal(call.ok, false);
  assert.equal(typeof call.cancel, 'function');
});

test('Despia WebView context: runtime ready and run fires intelligence:// URL', () => {
  const { intelligence, hrefLog } = loadInDespiaBridgeContext();
  assert.equal(intelligence.runtime.ok, true);
  assert.equal(intelligence.runtime.status, 'ready');

  const call = intelligence.run(
    { type: 'text', model: 'm', prompt: 'Hello world', stream: true },
    {},
  );
  assert.equal(call.ok, true);
  assert.equal(hrefLog.length, 1);
  assert.match(hrefLog[0], /^intelligence:\/\/text\?/);
  assert.match(hrefLog[0], /prompt=Hello%20world/);
  assert.match(hrefLog[0], /model=m/);
  assert.match(hrefLog[0], /id=11111111-1111-4111-8111-111111111111/);
});

test('Despia WebView context: unknown type throws', () => {
  const { intelligence } = loadInDespiaBridgeContext();
  assert.throws(
    () => intelligence.run({ type: 'not-a-real-type', prompt: 'x' }, {}),
    /Unknown type/,
  );
});

test('Despia WebView context: disabled type throws with clear message', () => {
  const { intelligence } = loadInDespiaBridgeContext();
  assert.throws(
    () => intelligence.run({ type: 'transcription', model: 'x' }, {}),
    /not yet supported/,
  );
});

test('Despia WebView context: download event on/off', () => {
  const { intelligence, window } = loadInDespiaBridgeContext();
  intelligence.run({ type: 'text', model: 'm', prompt: 'boot' }, {});

  let n = 0;
  const off = intelligence.on('downloadStart', () => {
    n += 1;
  });
  window.intelligence.onDownloadStart('model-a');
  assert.equal(n, 1);
  off();
  window.intelligence.onDownloadStart('model-b');
  assert.equal(n, 1);
});
