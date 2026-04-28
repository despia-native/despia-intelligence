'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const INDEX_PATH = path.join(__dirname, '..', 'index.js');
const INDEX_SRC = fs.readFileSync(INDEX_PATH, 'utf8');

function loadInDespiaBridgeContext(options) {
  const hrefLog = [];
  const intelligence = {};

  const window = {
    native_runtime: 'despia',
    intelligence,
  };
  Object.defineProperty(window, 'despia', {
    configurable: true,
    enumerable: true,
    get() { return window._despiaUrl; },
    set(u) {
      hrefLog.push(u);
      window._despiaUrl = u;
      if (options && options.simulateAvailable && String(u).indexOf('query=all') !== -1) {
        setTimeout(function () {
          window.intelligence.onAvailableModelsLoaded([{ id: 'a', name: 'A', category: 'text' }]);
        }, 10);
      }
      if (options && options.simulateInstalled && String(u).indexOf('query=installed') !== -1) {
        setTimeout(function () {
          window.intelligence.onInstalledModelsLoaded([{ id: 'm1', name: 'M1', category: 'text' }]);
        }, 10);
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
      randomUUID() { return '11111111-1111-4111-8111-111111111111'; },
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
  const call = intelligence.run({ type: 'text', model: 'qwen3-0.6b', prompt: 'x' }, {});
  assert.equal(call.ok, false);
  assert.equal(typeof call.cancel, 'function');
});

test('Despia WebView context: native callbacks are wired eagerly on window.intelligence', () => {
  const { window } = loadInDespiaBridgeContext();
  // Streaming
  assert.equal(typeof window.intelligence.onMLToken, 'function');
  assert.equal(typeof window.intelligence.onMLComplete, 'function');
  assert.equal(typeof window.intelligence.onMLError, 'function');
  // Downloads
  assert.equal(typeof window.intelligence.onDownloadStart, 'function');
  assert.equal(typeof window.intelligence.onDownloadProgress, 'function');
  assert.equal(typeof window.intelligence.onDownloadEnd, 'function');
  assert.equal(typeof window.intelligence.onDownloadError, 'function');
  // Removes
  assert.equal(typeof window.intelligence.onRemoveSuccess, 'function');
  assert.equal(typeof window.intelligence.onRemoveError, 'function');
  assert.equal(typeof window.intelligence.onRemoveAllSuccess, 'function');
  assert.equal(typeof window.intelligence.onRemoveAllError, 'function');
  // Catalogue
  assert.equal(typeof window.intelligence.onAvailableModelsLoaded, 'function');
  assert.equal(typeof window.intelligence.onInstalledModelsLoaded, 'function');
});

test('Despia WebView context: run fires intelligence://text via window.despia', () => {
  const { intelligence, hrefLog } = loadInDespiaBridgeContext();
  assert.equal(intelligence.runtime.ok, true);
  assert.equal(intelligence.runtime.status, 'ready');

  const call = intelligence.run({ type: 'text', model: 'm', prompt: 'Hello world', stream: true }, {});
  assert.equal(call.ok, true);
  assert.equal(hrefLog.length, 1);
  assert.match(hrefLog[0], /^intelligence:\/\/text\?/);
  assert.match(hrefLog[0], /prompt=Hello%20world/);
  assert.match(hrefLog[0], /model=m/);
  assert.match(hrefLog[0], /id=11111111-1111-4111-8111-111111111111/);
});

test('streaming callbacks route token / complete / error to handler', () => {
  const { intelligence, window } = loadInDespiaBridgeContext();
  let chunks = '';
  let final = null;
  let errored = null;
  intelligence.run({ type: 'text', model: 'm', prompt: 'p' }, {
    stream:   (c) => { chunks = c; },
    complete: (t) => { final = t; },
    error:    (e) => { errored = e; },
  });
  const id = '11111111-1111-4111-8111-111111111111';
  window.intelligence.onMLToken(id, 'Hel');
  window.intelligence.onMLToken(id, 'Hello');
  window.intelligence.onMLComplete(id, 'Hello world');
  assert.equal(chunks, 'Hello');
  assert.equal(final, 'Hello world');
  assert.equal(errored, null);

  // After complete, onMLToken should not throw / leak.
  window.intelligence.onMLToken(id, 'after');
  assert.equal(chunks, 'Hello');

  // Error path on a fresh job.
  let err2 = null;
  intelligence.run({ type: 'text', model: 'm', prompt: 'p2' }, {
    error: (e) => { err2 = e; },
  });
  window.intelligence.onMLError({ jobId: id, errorCode: 7, errorMessage: 'invalid model id' });
  assert.equal(err2.code, 7);
  assert.equal(err2.message, 'invalid model id');
});

test('Despia WebView context: unknown type throws', () => {
  const { intelligence } = loadInDespiaBridgeContext();
  assert.throws(() => intelligence.run({ type: 'not-a-real-type', prompt: 'x' }, {}), /Unknown type/);
});

test('Despia WebView context: disabled type throws with clear message', () => {
  const { intelligence } = loadInDespiaBridgeContext();
  assert.throws(() => intelligence.run({ type: 'transcription', model: 'x' }, {}), /not yet supported/);
});

test('download lifecycle: native callbacks fan out to per-modelId callbacks and event bus', () => {
  const { intelligence, hrefLog, window } = loadInDespiaBridgeContext();
  let started = 0;
  let lastPct = -1;
  let ended = 0;
  intelligence.models.download('model-x', {
    onStart:    () => { started += 1; },
    onProgress: (p) => { lastPct = p; },
    onEnd:      () => { ended += 1; },
  });
  assert.equal(hrefLog.length, 1);
  assert.match(hrefLog[0], /intelligence:\/\/download\?model=model-x/);

  let busStart = 0;
  const off = intelligence.on('downloadStart', () => { busStart += 1; });

  window.intelligence.onDownloadStart('model-x');
  window.intelligence.onDownloadProgress('model-x', 0.42); // 0-1 normalised to 42
  window.intelligence.onDownloadEnd('model-x');

  assert.equal(started, 1);
  assert.equal(lastPct, 42);
  assert.equal(ended, 1);
  assert.equal(busStart, 1);

  off();
  window.intelligence.onDownloadStart('model-y');
  assert.equal(busStart, 1);
});

test('models.remove resolves on onRemoveSuccess and rejects on onRemoveError', async () => {
  const { intelligence, hrefLog, window } = loadInDespiaBridgeContext();
  const okPromise = intelligence.models.remove('m1');
  setTimeout(() => window.intelligence.onRemoveSuccess('m1'), 5);
  await okPromise;
  assert.match(hrefLog[0], /intelligence:\/\/remove\?model=m1/);

  const failPromise = intelligence.models.remove('m2');
  setTimeout(() => window.intelligence.onRemoveError('m2', 'boom'), 5);
  await assert.rejects(failPromise, /boom/);
});

test('models.removeAll resolves on onRemoveAllSuccess', async () => {
  const { intelligence, hrefLog, window } = loadInDespiaBridgeContext();
  const p = intelligence.models.removeAll();
  setTimeout(() => window.intelligence.onRemoveAllSuccess(), 5);
  await p;
  assert.match(hrefLog[0], /intelligence:\/\/remove\?model=all/);
});

test('models.available fires query=all and resolves on onAvailableModelsLoaded', async () => {
  const { intelligence, hrefLog, window } = loadInDespiaBridgeContext({ simulateAvailable: true });
  const list = await intelligence.models.available();
  assert.equal(hrefLog.length, 1);
  assert.match(hrefLog[0], /intelligence:\/\/models\?query=all/);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'a');
  assert.deepEqual(window.intelligence.availableModels, list);
});

test('models.available returns empty array when runtime not ready', async () => {
  delete global.window;
  delete global.navigator;
  const intelligence = require('../index.js');
  const list = await intelligence.models.available();
  assert.deepEqual(list, []);
});

test('models.installed fires query=installed and resolves on onInstalledModelsLoaded', async () => {
  const { intelligence, hrefLog, window } = loadInDespiaBridgeContext({ simulateInstalled: true });
  const list = await intelligence.models.installed();
  assert.equal(hrefLog.length, 1);
  assert.match(hrefLog[0], /intelligence:\/\/models\?query=installed/);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'm1');
  assert.deepEqual(window.intelligence.installedModels, list);
});
