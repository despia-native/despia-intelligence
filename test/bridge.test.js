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
          window.intelligence.onAvailableModelsLoaded([{ id: 'a', name: 'A' }]);
        }, 10);
      }
      if (options && options.simulateInstalled && String(u).indexOf('query=installed') !== -1) {
        setTimeout(function () {
          window.intelligence.onInstalledModelsLoaded([{ id: 'm1', name: 'M1' }]);
        }, 10);
      }
    },
  });

  const navigator = { userAgent: 'Mozilla/5.0 despia-test' };
  const module = { exports: {} };
  const sandboxSetTimeout = function (fn, ms) {
    if (options && options.instantModelTimeout && ms === 10000) {
      fn();
      return 1;
    }
    return setTimeout(fn, ms);
  };
  const sandbox = {
    window,
    navigator,
    module,
    exports: module.exports,
    self: window,
    setTimeout: sandboxSetTimeout,
    clearTimeout,
    Date,
    crypto: (function () {
      var n = 0;
      return {
        randomUUID() {
          n += 1;
          var hex = n.toString(16).padStart(8, '0');
          return hex + '-1111-4111-8111-111111111111';
        },
      };
    }()),
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
  assert.match(hrefLog[0], /id=00000001-1111-4111-8111-111111111111/);
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
  const id1 = '00000001-1111-4111-8111-111111111111';
  window.intelligence.onMLToken(id1, 'Hel');
  window.intelligence.onMLToken(id1, 'Hello');
  window.intelligence.onMLComplete(id1, 'Hello world');
  assert.equal(chunks, 'Hello');
  assert.equal(final, 'Hello world');
  assert.equal(errored, null);

  // After complete, onMLToken should not throw / leak.
  window.intelligence.onMLToken(id1, 'after');
  assert.equal(chunks, 'Hello');

  // Error path on a fresh job (next UUID).
  let err2 = null;
  intelligence.run({ type: 'text', model: 'm', prompt: 'p2' }, {
    error: (e) => { err2 = e; },
  });
  const id2 = '00000002-1111-4111-8111-111111111111';
  window.intelligence.onMLError({ jobId: id2, errorCode: 7, errorMessage: 'invalid model id' });
  assert.equal(err2.code, 7);
  assert.equal(err2.message, 'invalid model id');
});

test('Despia WebView context: second concurrent run is rejected before native fire', () => {
  const { intelligence, hrefLog } = loadInDespiaBridgeContext();

  intelligence.run({ type: 'text', model: 'm', prompt: 'first' }, {});

  let rejected = null;
  const second = intelligence.run({ type: 'text', model: 'm', prompt: 'second' }, {
    error: (e) => { rejected = e; },
  });

  assert.equal(hrefLog.length, 1);
  assert.match(hrefLog[0], /prompt=first/);
  assert.equal(second.ok, false);
  assert.equal(second.status, 'busy');
  assert.equal(rejected.code, 409);
  assert.match(rejected.message, /already running/);
});

test('Despia WebView context: new run is allowed after complete', () => {
  const { intelligence, hrefLog, window } = loadInDespiaBridgeContext();

  intelligence.run({ type: 'text', model: 'm', prompt: 'first' }, {});
  window.intelligence.onMLComplete('00000001-1111-4111-8111-111111111111', 'done');
  const second = intelligence.run({ type: 'text', model: 'm', prompt: 'second' }, {});

  assert.equal(second.ok, true);
  assert.equal(hrefLog.length, 2);
  assert.match(hrefLog[1], /prompt=second/);
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

test('models.available resolves [] if native never replies', async () => {
  const { intelligence, hrefLog } = loadInDespiaBridgeContext({ instantModelTimeout: true });
  const list = await intelligence.models.available();
  assert.equal(hrefLog.length, 1);
  assert.match(hrefLog[0], /intelligence:\/\/models\?query=all/);
  assert.equal(Array.isArray(list), true);
  assert.equal(list.length, 0);
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

test('models.installed resolves [] if native never replies', async () => {
  const { intelligence, hrefLog } = loadInDespiaBridgeContext({ instantModelTimeout: true });
  const list = await intelligence.models.installed();
  assert.equal(hrefLog.length, 1);
  assert.match(hrefLog[0], /intelligence:\/\/models\?query=installed/);
  assert.equal(Array.isArray(list), true);
  assert.equal(list.length, 0);
});

test('lifecycle: focusout snapshots active jobs and focusin re-fires them with same intent', () => {
  const { intelligence, hrefLog, window } = loadInDespiaBridgeContext();

  let chunks = '';
  let completed = null;
  intelligence.run({ type: 'text', model: 'm', prompt: 'long essay' }, {
    stream:   (c) => { chunks = c; },
    complete: (t) => { completed = t; },
  });
  assert.equal(hrefLog.length, 1);
  assert.match(hrefLog[0], /prompt=long%20essay/);
  assert.match(hrefLog[0], /id=00000001-/);

  // App backgrounds.
  window.focusout();

  // Native session for the old id is dead; further callbacks for it must be no-ops.
  window.intelligence.onMLToken('00000001-1111-4111-8111-111111111111', 'leftover');
  assert.equal(chunks, '');

  // App returns. SDK re-fires run() with the same intent and a new id.
  window.focusin();
  assert.equal(hrefLog.length, 2);
  assert.match(hrefLog[1], /prompt=long%20essay/);
  assert.match(hrefLog[1], /id=00000002-/);

  // The same handler now receives tokens for the new id and completes.
  window.intelligence.onMLToken('00000002-1111-4111-8111-111111111111', 'Hello');
  window.intelligence.onMLComplete('00000002-1111-4111-8111-111111111111', 'Hello world');
  assert.equal(chunks, 'Hello');
  assert.equal(completed, 'Hello world');
});

test('lifecycle: terminal callback after focusout clears pending job instead of resuming it', () => {
  const { intelligence, hrefLog, window } = loadInDespiaBridgeContext();

  let completed = null;
  intelligence.run({ type: 'text', model: 'm', prompt: 'finish-in-bg' }, {
    complete: (t) => { completed = t; },
  });
  assert.equal(hrefLog.length, 1);

  window.focusout();
  window.intelligence.onMLComplete('00000001-1111-4111-8111-111111111111', 'done while backgrounding');
  assert.equal(completed, 'done while backgrounding');

  window.focusin();
  assert.equal(hrefLog.length, 1, 'completed pending job must not be re-fired');
});

test('lifecycle: cancelled job does not resume after focusin', () => {
  const { intelligence, hrefLog, window } = loadInDespiaBridgeContext();

  const call = intelligence.run({ type: 'text', model: 'm', prompt: 'cancel-me' }, {});
  assert.equal(hrefLog.length, 1);

  window.focusout();
  // User cancels while in BG (e.g. the SDK consumer holds the call handle and
  // the JS thread runs again before focusin — defensive case).
  call.cancel();

  window.focusin();
  assert.equal(hrefLog.length, 1, 'cancelled job must not be re-fired');
});

test('lifecycle: new run is rejected while previous job is pending resume', () => {
  const { intelligence, hrefLog, window } = loadInDespiaBridgeContext();

  intelligence.run({ type: 'text', model: 'm', prompt: 'first' }, {});
  window.focusout();

  const second = intelligence.run({ type: 'text', model: 'm', prompt: 'second' }, {});
  assert.equal(second.ok, false);
  assert.equal(second.status, 'busy');

  window.focusin();
  assert.equal(hrefLog.length, 2);
  assert.match(hrefLog[1], /prompt=first/);
});

test('lifecycle: original call handle cancels the resumed job after focusin', () => {
  const { intelligence, hrefLog, window } = loadInDespiaBridgeContext();

  let chunks = '';
  const call = intelligence.run({ type: 'text', model: 'm', prompt: 'cancel-after-resume' }, {
    stream: (c) => { chunks = c; },
  });
  window.focusout();
  window.focusin();
  assert.equal(hrefLog.length, 2);

  call.cancel();
  window.intelligence.onMLToken('00000002-1111-4111-8111-111111111111', 'should be ignored');
  assert.equal(chunks, '');
});
