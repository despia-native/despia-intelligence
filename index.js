(function (root, factory) {
  var api = factory();
  if (typeof define === 'function' && define.amd) {
    define([], function () { return api; });
  } else if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else if (root) {
    // Merge into root.intelligence: the factory already attached native
    // callbacks (window.intelligence.onML* etc) during execution, so we MUST
    // NOT overwrite them. Assign API methods on top of the same object.
    if (!root.intelligence) root.intelligence = {};
    for (var k in api) {
      if (Object.prototype.hasOwnProperty.call(api, k)) root.intelligence[k] = api[k];
    }
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // JS -> native: assign the scheme URL to window.despia.
  function _fire(url) {
    if (typeof window === 'undefined' || url == null) return;
    try {
      window.despia = url;
    } catch (e) {
      if (typeof console !== 'undefined' && console.error) {
        console.error('[despia-intelligence] Despia command failed:', e);
      }
    }
  }

  // Routes: extend TYPES when native adds a route; flip enabled when ready.
  var TYPES = {
    text:          { route: 'text',       enabled: true,  params: ['model', 'prompt', 'system', 'stream', 'file', 'filepicker'] },
    transcription: { route: 'microphone', enabled: false, params: ['model'] },
    audio:         { route: 'audio',      enabled: false, params: ['model', 'prompt', 'voice', 'response', 'file', 'filepicker'] },
    vision:        { route: 'vision',     enabled: false, params: ['model', 'prompt', 'file', 'filepicker'] },
    embed:         { route: 'embed',      enabled: false, params: ['model', 'input'] },
  };

  function _supported() {
    return Object.keys(TYPES).filter(function (k) { return TYPES[k].enabled; }).join(', ');
  }

  function _uuid() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  function _build(params) {
    var cfg = TYPES[params.type];
    if (!cfg) throw new Error('[despia-intelligence] Unknown type: "' + params.type + '". Supported: ' + _supported());
    if (!cfg.enabled) throw new Error('[despia-intelligence] Type "' + params.type + '" is not yet supported in this release. Supported: ' + _supported());

    var id = _uuid();
    var parts = ['id=' + encodeURIComponent(id)];
    Object.keys(params).forEach(function (k) {
      if (k === 'type') return;
      var v = params[k];
      if (v == null) return;
      var s = Array.isArray(v) ? v.join(',') : String(v);
      parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(s));
    });
    return { url: 'intelligence://' + cfg.route + '?' + parts.join('&'), id: id };
  }

  // Runtime: ready iff window.native_runtime === 'despia'.
  var _rt = (function () {
    if (typeof window === 'undefined') return { ok: false, status: 'unavailable', message: null };
    if (window.native_runtime === 'despia') return { ok: true, status: 'ready', message: null };
    var ua = (typeof navigator !== 'undefined' && navigator.userAgent || '').toLowerCase();
    if (ua.indexOf('despia') !== -1) return { ok: false, status: 'outdated', message: 'Your Despia app is outdated. Install the latest version to use Local Intelligence.' };
    return { ok: false, status: 'unavailable', message: null };
  }());

  function _nr() {
    return { ok: false, status: _rt.status, message: _rt.message, intent: null, cancel: function () {} };
  }

  function _busy(handler) {
    var err = { code: 409, message: 'Another inference job is already running. Wait for it to finish or cancel it before starting a new one.' };
    if (handler && handler.error) {
      try { handler.error(err); } catch (e) {}
    }
    return { ok: false, status: 'busy', message: err.message, intent: null, cancel: function () {} };
  }

  // Event fanout (download lifecycle).
  var _ev = {};
  function _emit(e) {
    var args = Array.prototype.slice.call(arguments, 1);
    if (_ev[e]) _ev[e].forEach(function (fn) { fn.apply(null, args); });
  }
  function _on(e, fn) {
    (_ev[e] || (_ev[e] = [])).push(fn);
    return function () { _off(e, fn); };
  }
  function _off(e, fn) {
    if (_ev[e]) _ev[e] = _ev[e].filter(function (f) { return f !== fn; });
  }
  function _once(e, fn) {
    var off = _on(e, function () { fn.apply(null, arguments); off(); });
  }

  function _removeItem(list, item) {
    var i = list.indexOf(item);
    if (i !== -1) list.splice(i, 1);
  }

  function _hasActiveInference() {
    return Object.keys(_jobs).length > 0 || Object.keys(_pending).length > 0;
  }

  // Internal state.
  var _jobs              = {}; // active inference job: jobId -> { handler, intent }
  var _pending           = {}; // pending resume job: jobId -> { handler, intent }; populated by focusout, drained by focusin
  var _downloads         = {}; // modelId -> callbacks
  var _removes           = {}; // modelId -> { resolve, reject }
  var _removeAll         = null;
  var _availableWaiters  = []; // resolvers for models.available()
  var _installedWaiters  = []; // resolvers for models.installed()
  var _modelsTimeoutMs   = 10000;

  function _start(params, handler, ref) {
    var built = _build(params);
    ref.id = built.id;
    _jobs[built.id] = { handler: handler, intent: params, ref: ref };
    _fire(built.url);
  }

  function _resolveModels(waiters, url) {
    return new Promise(function (resolve) {
      var done = false;
      var timer = null;
      var waiter = function (list) {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        resolve(list);
      };

      waiters.push(waiter);
      timer = setTimeout(function () {
        if (done) return;
        done = true;
        _removeItem(waiters, waiter);
        resolve([]);
      }, _modelsTimeoutMs);
      _fire(url);
    });
  }

  // Native -> JS: native calls these directly. Wired eagerly so unsolicited
  // pushes (e.g. catalogue at app start) are never dropped.
  if (typeof window !== 'undefined' && _rt.ok) {
    if (!window.intelligence) window.intelligence = {};

    window.intelligence.onMLToken = function (id, chunk) {
      var job = _jobs[id];
      if (job && job.handler && job.handler.stream) {
        try { job.handler.stream(chunk); } catch (e) {}
      }
    };

    window.intelligence.onMLComplete = function (id, fullText) {
      var job = _jobs[id] || _pending[id];
      if (!job) return;
      if (job.handler && job.handler.complete) {
        try { job.handler.complete(fullText); } catch (e) {}
      }
      delete _jobs[id];
      delete _pending[id];
    };

    window.intelligence.onMLError = function (err) {
      var jobId = err && err.jobId;
      var job = _jobs[jobId] || _pending[jobId];
      if (!job) return;
      if (job.handler && job.handler.error) {
        try { job.handler.error({ code: err.errorCode, message: err.errorMessage }); } catch (e) {}
      }
      delete _jobs[jobId];
      delete _pending[jobId];
    };

    window.intelligence.onDownloadStart = function (modelId) {
      var cb = _downloads[modelId];
      if (cb && cb.onStart) try { cb.onStart(); } catch (e) {}
      _emit('downloadStart', modelId);
    };

    window.intelligence.onDownloadProgress = function (modelId, pct) {
      var percent = 0;
      if (typeof pct === 'number') {
        percent = pct <= 1 ? Math.round(pct * 100) : Math.max(0, Math.min(100, Math.round(pct)));
      }
      var cb = _downloads[modelId];
      if (cb && cb.onProgress) try { cb.onProgress(percent); } catch (e) {}
      _emit('downloadProgress', modelId, percent);
    };

    window.intelligence.onDownloadEnd = function (modelId) {
      var cb = _downloads[modelId];
      if (cb && cb.onEnd) try { cb.onEnd(); } catch (e) {}
      delete _downloads[modelId];
      _emit('downloadEnd', modelId);
    };

    window.intelligence.onDownloadError = function (modelId, err) {
      var cb = _downloads[modelId];
      if (cb && cb.onError) try { cb.onError(err); } catch (e) {}
      delete _downloads[modelId];
      _emit('downloadError', modelId, err);
    };

    window.intelligence.onRemoveSuccess = function (modelId) {
      if (_removes[modelId]) { _removes[modelId].resolve(); delete _removes[modelId]; }
    };

    window.intelligence.onRemoveError = function (modelId, err) {
      if (_removes[modelId]) { _removes[modelId].reject(new Error(err)); delete _removes[modelId]; }
    };

    window.intelligence.onRemoveAllSuccess = function () {
      if (_removeAll) { _removeAll.resolve(); _removeAll = null; }
    };

    window.intelligence.onRemoveAllError = function (err) {
      if (_removeAll) { _removeAll.reject(new Error(err)); _removeAll = null; }
    };

    window.intelligence.onAvailableModelsLoaded = function (models) {
      var list = Array.isArray(models) ? models : [];
      window.intelligence.availableModels = list;
      var waiters = _availableWaiters;
      _availableWaiters = [];
      waiters.forEach(function (resolve) { resolve(list); });
    };

    window.intelligence.onInstalledModelsLoaded = function (models) {
      var list = Array.isArray(models) ? models : [];
      window.intelligence.installedModels = list;
      var waiters = _installedWaiters;
      _installedWaiters = [];
      waiters.forEach(function (resolve) { resolve(list); });
    };

    // Lifecycle: native invokes window.focusout / window.focusin synchronously
    // from applicationDidEnterBackground / applicationWillEnterForeground (iOS)
    // and onPause / onResume (Android), while the JS thread is still alive.
    // We snapshot active inference jobs on focusout, then re-fire them with
    // fresh native sessions on focusin. Downloads keep running natively, so
    // _downloads is intentionally NOT cleared.
    window.focusout = function () {
      Object.keys(_jobs).forEach(function (id) { _pending[id] = _jobs[id]; });
      _jobs = {};
    };

    window.focusin = function () {
      var toResume = _pending;
      _pending = {};
      Object.keys(toResume).forEach(function (id) {
        var job = toResume[id];
        if (job && job.intent && job.ref) try { _start(job.intent, job.handler, job.ref); } catch (e) {}
      });
    };
  }

  function run(params, handler) {
    params  = params  || {};
    handler = handler || {};
    if (!_rt.ok) return _nr();
    if (_hasActiveInference()) return _busy(handler);

    var ref = { id: null };
    _start(params, handler, ref);

    return {
      ok: true,
      intent: params,
      cancel: function () { delete _jobs[ref.id]; delete _pending[ref.id]; },
    };
  }

  var models = {
    available: function () {
      if (!_rt.ok) return Promise.resolve([]);
      return _resolveModels(_availableWaiters, 'intelligence://models?query=all');
    },

    installed: function () {
      if (!_rt.ok) return Promise.resolve(_nr());
      return _resolveModels(_installedWaiters, 'intelligence://models?query=installed');
    },

    download: function (modelId, callbacks) {
      if (!_rt.ok) return _nr();
      _downloads[modelId] = callbacks || {};
      _fire('intelligence://download?model=' + encodeURIComponent(modelId));
    },

    remove: function (modelId) {
      if (!_rt.ok) return Promise.resolve(_nr());
      return new Promise(function (resolve, reject) {
        _removes[modelId] = { resolve: resolve, reject: reject };
        _fire('intelligence://remove?model=' + encodeURIComponent(modelId));
      });
    },

    removeAll: function () {
      if (!_rt.ok) return Promise.resolve(_nr());
      return new Promise(function (resolve, reject) {
        _removeAll = { resolve: resolve, reject: reject };
        _fire('intelligence://remove?model=all');
      });
    },
  };

  return {
    run: run,
    models: models,
    runtime: _rt,
    on: _on,
    off: _off,
    once: _once,
  };
}));
