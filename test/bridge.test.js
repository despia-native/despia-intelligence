'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const INDEX_PATH = path.join(__dirname, '..', 'index.js');
const INDEX_SRC = fs.readFileSync(INDEX_PATH, 'utf8');

function stubRegister(registry, name) {
  return function (fn) {
    registry[name] = fn;
  };
}

function loadInDespiaBridgeContext(options) {
  const hrefLog = [];
  const nativeReg = {};
  const names = [
    'onMLToken',
    'onMLComplete',
    'onMLError',
    'onDownloadStart',
    'onDownloadProgress',
    'onDownloadEnd',
    'onDownloadError',
    'onRemoveSuccess',
    'onRemoveError',
    'onRemoveAllSuccess',
    'onRemoveAllError',
  ];
  const intelligence = {};
  for (let i = 0; i < names.length; i += 1) {
    intelligence[names[i]] = stubRegister(nativeReg, names[i]);
  }
  if (options && options.availableModels) {
    intelligence.availableModels = options.availableModels;
  }
  if (options && options.installedModels) {
    intelligence.installedModels = options.installedModels;
  }

  const window = {
    native_runtime: 'despia',
    intelligence,
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
      if (options && options.simulateInstalledResponse && String(u).indexOf('query=installed') !== -1) {
        setTimeout(function () {
          window.intelligence.installedModels = [{ id: 'm1', name: 'M1', category: 'text' }];
        }, 50);
      }
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
    setTimeout,
    clearTimeout,
    Date,
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

  return { intelligence: module.exports, hrefLog, window: sandbox.window, nativeReg };
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

test('Despia WebView context: download event on/off via native registrar', () => {
  const { intelligence, nativeReg } = loadInDespiaBridgeContext();
  intelligence.run({ type: 'text', model: 'm', prompt: 'boot' }, {});

  assert.ok(typeof nativeReg.onDownloadStart === 'function', '_boot registers onDownloadStart');

  let n = 0;
  const off = intelligence.on('downloadStart', () => {
    n += 1;
  });
  nativeReg.onDownloadStart('model-a');
  assert.equal(n, 1);
  off();
  nativeReg.onDownloadStart('model-b');
  assert.equal(n, 1);
});

test('models.available reads injected list and does not fire models scheme', async () => {
  const modelsList = [{ id: 'a', name: 'A', category: 'text' }];
  const { intelligence, hrefLog } = loadInDespiaBridgeContext({
    availableModels: modelsList,
  });
  const list = await intelligence.models.available();
  assert.deepEqual(list, modelsList);
  assert.equal(hrefLog.length, 0);
});

test('models.available returns empty array when runtime not ready', async () => {
  delete global.window;
  delete global.navigator;
  const intelligence = require('../index.js');
  const list = await intelligence.models.available();
  assert.deepEqual(list, []);
});

test('models.installed fires scheme and resolves after installedModels changes', async () => {
  const { intelligence, hrefLog, window } = loadInDespiaBridgeContext({
    simulateInstalledResponse: true,
  });
  const list = await intelligence.models.installed();
  assert.equal(hrefLog.length, 1);
  assert.match(hrefLog[0], /intelligence:\/\/models\?query=installed/);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'm1');
  assert.deepEqual(window.intelligence.installedModels, list);
});
