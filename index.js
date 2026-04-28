(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.intelligence = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // --- Bridge: prefer window.despia (native setter). FIFO ~1ms between assignments so bursts
  // never set the property twice in the same synchronous turn.
  //
  // Internal contract: JS -> native is via window.despia assignment (native setter).

  var _despiaQueue      = [];
  var _despiaProcessing = false;

  function _processDespiaQueue() {
    if (_despiaProcessing || _despiaQueue.length === 0) return;
    _despiaProcessing = true;
    var item = _despiaQueue.shift();
    var url = item && item.url;
    try {
      if (typeof window !== 'undefined' && url != null) window.despia = url;
    } catch (e) {
      if (typeof console !== 'undefined' && console.error) {
        console.error('[despia-intelligence] Despia command failed:', e);
      }
    }
    if (typeof setTimeout !== 'undefined') {
      setTimeout(function () {
        _despiaProcessing = false;
        _processDespiaQueue();
      }, 1);
    } else {
      _despiaProcessing = false;
      _processDespiaQueue();
    }
  }

  function _fire(url) {
    if (typeof window === 'undefined') return;
    _despiaQueue.push({ url: url });
    _processDespiaQueue();
  }

  // --- Routes: extend TYPES when native adds a route; set enabled when supported.

  var TYPES = {
    "text": {
      "route":   "text",
      "enabled": true,
      "params":  ["model", "prompt", "system", "stream", "file", "filepicker"]
    },
    "transcription": {
      "route":   "microphone",
      "enabled": false,
      "params":  ["model"]
    },
    "audio": {
      "route":   "audio",
      "enabled": false,
      "params":  ["model", "prompt", "voice", "response", "file", "filepicker"]
    },
    "vision": {
      "route":   "vision",
      "enabled": false,
      "params":  ["model", "prompt", "file", "filepicker"]
    },
    "embed": {
      "route":   "embed",
      "enabled": false,
      "params":  ["model", "input"]
    }
  };

  function _supported_list() {
    return Object.keys(TYPES).filter(function (k) { return TYPES[k].enabled; }).join(', ');
  }

  function _build(params) {
    var type   = params.type;
    var config = TYPES[type];

    if (!config) {
      throw new Error('[despia-intelligence] Unknown type: "' + type + '". Supported: ' + _supported_list());
    }
    if (!config.enabled) {
      throw new Error('[despia-intelligence] Type "' + type + '" is not yet supported in this release. Supported: ' + _supported_list());
    }

    // encodeURIComponent per pair (not URLSearchParams): '+' for space breaks iOS/Android query parsers.
    var id    = _uuid();
    var parts = ['id=' + encodeURIComponent(id)];

    Object.keys(params).forEach(function (k) {
      if (k === 'type') return;
      var v = params[k];
      if (v === undefined || v === null) return;
      var str = Array.isArray(v) ? v.join(',') : String(v);
      parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(str));
    });

    return {
      url:   'intelligence://' + config.route + '?' + parts.join('&'),
      id:    id,
      route: config.route,
    };
  }

  function _uuid() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  // --- Observe window.intelligence[key] until WebView updates it (poll + timeout).

  function _safeSig(val) {
    if (val === undefined) return 'u';
    if (val === null) return 'n';
    var t = typeof val;
    if (t !== 'object') return t + ':' + String(val);
    try { return 'o:' + JSON.stringify(val); } catch (e) { return 'o:[unserializable]'; }
  }

  function _observe(key, callback, timeout) {
    timeout = timeout || 30000;
    var startTime = Date.now();
    var namespace = (typeof window !== 'undefined' && window.intelligence) ? window.intelligence : {};
    var initialRef = namespace[key];
    var initialSig = _safeSig(initialRef);

    var ready = function (val) {
      if (val === undefined || val === 'n/a') return false;
      if (Array.isArray(val) && val.length === 0) return false;
      if (val && typeof val === 'object' && !Array.isArray(val) && Object.keys(val).length === 0) return false;
      return true;
    };

    var changed = function (val) {
      if (val === null) return true;
      if (val !== initialRef) return true;
      return _safeSig(val) !== initialSig;
    };

    function check() {
      var val = window.intelligence && window.intelligence[key];
      if (ready(val) && changed(val)) { callback(val); return; }
      if (Date.now() - startTime < timeout) { setTimeout(check, 100); return; }
      callback(undefined);
    }

    check();
  }

  // --- Runtime (fixed at import): ready only when native_runtime === 'despia'.

  var _rt = (function () {
    if (typeof window === 'undefined') return { ok: false, status: 'unavailable', message: null };

    var hasRuntime = window.native_runtime === 'despia';
    var hasUA      = (navigator.userAgent.toLowerCase().indexOf('despia') !== -1) || window.__DESPIA_UA_OVERRIDE === true;

    if (hasRuntime) return { ok: true,  status: 'ready',       message: null };
    if (hasUA)                  return { ok: false, status: 'outdated',    message: 'Your Despia app is outdated. Install the latest version to use Local Intelligence.' };
                                return { ok: false, status: 'unavailable', message: null };
  }());

  function _nr() {
    return { ok: false, status: _rt.status, message: _rt.message, intent: null, interrupted: false, cancel: function () {} };
  }

  // --- Events: _ev[event] -> listener arrays; .on() returns unsubscribe.

  var _ev = {};

  function _emit(e) {
    var args = Array.prototype.slice.call(arguments, 1);
    if (_ev[e]) _ev[e].forEach(function (fn) { fn.apply(null, args); });
  }

  function _on(e, fn) {
    if (!_ev[e]) _ev[e] = [];
    _ev[e].push(fn);
    return function () { _off(e, fn); };
  }

  function _off(e, fn) {
    if (!_ev[e]) return;
    _ev[e] = _ev[e].filter(function (f) { return f !== fn; });
  }

  function _once(e, fn) {
    var off = _on(e, function () {
      fn.apply(null, arguments);
      off();
    });
  }

  var _jobs             = {}; // active inference: jobId -> { handler, params }
  var _downloads        = {}; // active download callbacks by modelId
  var _pendingDownloads = {}; // snapshot during background; merged back on focusin
  var _removes          = {}; // modelId -> { resolve, reject }
  var _removeAll        = null;
  var _booted           = false;
  var _pending          = {}; // interrupted jobs; swap then drain on focusin (see focusin)

  // --- Lifecycle: Despia calls window.focusout / window.focusin from the OS (reliable
  // in WebViews vs visibilitychange). focusout snapshots jobs + download callbacks;
  // focusin re-runs pending inference via run(); downloads keep natively, callbacks restored.

  if (typeof window !== 'undefined') {

    window.focusout = function () {
      Object.keys(_jobs).forEach(function (id) {
        var job = _jobs[id];
        if (!job) return;

        _pending[id] = { handler: job.handler, params: job.params };

        if (job.handler && job.handler.interrupted) {
          try { job.handler.interrupted(job.params); } catch (e) {}
        }
      });

      _jobs = {};

      Object.keys(_downloads).forEach(function (modelId) {
        _pendingDownloads[modelId] = _downloads[modelId];
      });
    };

    window.focusin = function () {
      var toResume = _pending;
      _pending = {};

      Object.keys(toResume).forEach(function (id) {
        var job = toResume[id];
        if (job) {
          try { run(job.params, job.handler); } catch (e) {}
        }
      });

      Object.keys(_pendingDownloads).forEach(function (modelId) {
        if (!_downloads[modelId]) {
          _downloads[modelId] = _pendingDownloads[modelId];
        }
      });
      _pendingDownloads = {};
    };

  }

  // --- Boot: native calls window.intelligence.* directly (internal bridge contract).

  function _boot() {
    if (_booted || !_rt.ok) return;
    _booted = true;

    if (!window.intelligence) window.intelligence = {};

    // Streaming inference (native calls these directly).
    window.intelligence.onMLToken = function (id, chunk) {
      var job = _jobs[id];
      if (job && job.handler && job.handler.stream) {
        try { job.handler.stream(chunk); } catch (e) {}
      }
    };

    window.intelligence.onMLComplete = function (id, fullText) {
      var job = _jobs[id];
      if (job) {
        if (job.handler && job.handler.complete) {
          try { job.handler.complete(fullText); } catch (e) {}
        }
        delete _jobs[id];
        delete _pending[id];
      }
    };

    window.intelligence.onMLError = function (err) {
      var jobId = err && err.jobId;
      var job   = _jobs[jobId];
      if (job) {
        if (job.handler && job.handler.error) {
          try { job.handler.error({ code: err.errorCode, message: err.errorMessage }); } catch (e) {}
        }
        delete _jobs[jobId];
        delete _pending[jobId];
      }
    };

    // Model lifecycle events (native calls these directly).
    window.intelligence.onDownloadStart = function (modelId) {
      var cb = _downloads[modelId];
      if (cb && cb.onStart) try { cb.onStart(); } catch (e) {}
      _emit('downloadStart', modelId);
    };

    window.intelligence.onDownloadProgress = function (modelId, pct) {
      // Native often sends 0-1; tolerate 0-100.
      var percent = pct;
      if (typeof percent === 'number') {
        if (percent <= 1) percent = Math.round(percent * 100);
        else percent = Math.max(0, Math.min(100, Math.round(percent)));
      } else {
        percent = 0;
      }
      var cb = _downloads[modelId];
      if (cb && cb.onProgress) try { cb.onProgress(percent); } catch (e) {}
      _emit('downloadProgress', modelId, percent);
    };

    window.intelligence.onDownloadEnd = function (modelId) {
      var cb = _downloads[modelId];
      if (cb && cb.onEnd) try { cb.onEnd(); } catch (e) {}
      delete _downloads[modelId];
      delete _pendingDownloads[modelId];
      _emit('downloadEnd', modelId);
    };

    window.intelligence.onDownloadError = function (modelId, err) {
      var cb = _downloads[modelId];
      if (cb && cb.onError) try { cb.onError(err); } catch (e) {}
      delete _downloads[modelId];
      delete _pendingDownloads[modelId];
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

    // Catalogue delivery: native may set window.intelligence.availableModels /
    // installedModels directly OR call these loaded-callbacks. Mirror the
    // payload onto the variable so _observe picks it up either way.
    window.intelligence.onAvailableModelsLoaded = function (models) {
      if (!window.intelligence) window.intelligence = {};
      window.intelligence.availableModels = Array.isArray(models) ? models : [];
    };

    window.intelligence.onInstalledModelsLoaded = function (models) {
      if (!window.intelligence) window.intelligence = {};
      window.intelligence.installedModels = Array.isArray(models) ? models : [];
    };
  }

  function run(params, handler) {
    params  = params  || {};
    handler = handler || {};

    if (!_rt.ok) return _nr();
    _boot();

    var built = _build(params);
    _jobs[built.id] = { handler: handler, params: params };
    _fire(built.url);

    return {
      ok:          true,
      intent:      params,
      interrupted: false,
      cancel: function () {
        delete _jobs[built.id];
        delete _pending[built.id];
      },
    };
  }

  var models = {
    available: function () {
      if (!_rt.ok) return Promise.resolve([]);
      _boot();
      var existing = (window.intelligence && window.intelligence.availableModels) || [];
      if (Array.isArray(existing) && existing.length > 0) return Promise.resolve(existing);

      // Internal contract (matches the working HTML demo): fire query=all and wait
      // for native to inject window.intelligence.availableModels.
      return new Promise(function (resolve) {
        if (window.intelligence) window.intelligence.availableModels = [];
        _observe('availableModels', function (val) {
          resolve(val || []);
        }, 10000);
        _fire('intelligence://models?query=all');
      });
    },

    installed: function () {
      if (!_rt.ok) return Promise.resolve(_nr());
      _boot();
      return new Promise(function (resolve) {
        if (window.intelligence) window.intelligence.installedModels = [];
        _observe('installedModels', function (val) {
          resolve(val || []);
        });
        _fire('intelligence://models?query=installed');
      });
    },

    download: function (modelId, callbacks) {
      callbacks = callbacks || {};
      if (!_rt.ok) return _nr();
      _boot();
      _downloads[modelId] = callbacks;
      _fire('intelligence://download?model=' + encodeURIComponent(modelId));
    },

    remove: function (modelId) {
      if (!_rt.ok) return Promise.resolve(_nr());
      _boot();
      return new Promise(function (resolve, reject) {
        _removes[modelId] = { resolve: resolve, reject: reject };
        _fire('intelligence://remove?model=' + encodeURIComponent(modelId));
      });
    },

    removeAll: function () {
      if (!_rt.ok) return Promise.resolve(_nr());
      _boot();
      return new Promise(function (resolve, reject) {
        _removeAll = { resolve: resolve, reject: reject };
        _fire('intelligence://remove?model=all');
      });
    },
  };

  var intelligence = {
    run:     run,
    models:  models,
    runtime: _rt,
    on:      _on,
    off:     _off,
    once:    _once,
  };

  return intelligence;
}));
