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

  // ─── Bridge ─────────────────────────────────────────────────────────────────
  // The Despia native runtime intercepts window.location.href before navigation.
  // iOS:     WebViewController.swift → decidePolicyFor navigationAction
  // Android: MainActivity.java       → shouldOverrideUrlLoading
  // Results come back through window callbacks the native layer fires directly.
  // No variable injection - no despia-native variable watching needed.

  function _fire(url) {
    if (typeof window !== 'undefined') window.location.href = url;
  }

  // ─── Config ─────────────────────────────────────────────────────────────────
  // Single source of truth for all supported types.
  // To add a new type when the native route ships:
  //   1. Add an entry to TYPES
  //   2. Set "enabled": true
  //   3. Done - no other changes needed anywhere
  //
  // Fields:
  //   "route"    string   the intelligence:// route segment
  //   "enabled"  boolean  false = throws with a clear message if called
  //   "params"   array    documented params for this type (informational only)

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

    // Build the query manually with encodeURIComponent so every value is
    // percent-encoded. URLSearchParams.toString() would form-encode spaces
    // as '+', which iOS URLComponents and Android Uri.getQueryParameter do
    // not decode back to space - prompts like "Hello world" would arrive at
    // the model as "Hello+world". encodeURIComponent emits %20, which every
    // URL parser on both platforms decodes identically. Also covers newlines,
    // ampersands, quotes, unicode, commas inside array members, everything.
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

  // ─── Runtime ────────────────────────────────────────────────────────────────
  // window.native_runtime         = 'despia'  injected by Despia on boot
  // window.intelligence_available = true       injected when Local AI is supported
  // Resolved once at load time. Immutable after that.

  var _rt = (function () {
    if (typeof window === 'undefined') return { ok: false, status: 'unavailable', message: null };

    var hasRuntime = window.native_runtime === 'despia';
    var hasAI      = window.intelligence_available === true;
    var hasUA      = (navigator.userAgent.toLowerCase().indexOf('despia') !== -1) || window.__DESPIA_UA_OVERRIDE === true;

    if (hasRuntime && hasAI)  return { ok: true,  status: 'ready',                message: null };
    if (hasRuntime && !hasAI) return { ok: false, status: 'runtime_incompatible', message: 'Update Despia to the latest version to enable Local Intelligence.' };
    if (hasUA)                return { ok: false, status: 'outdated',             message: 'Your Despia app is outdated. Install the latest version to use Local Intelligence.' };
                              return { ok: false, status: 'unavailable',          message: null };
  }());

  function _nr() {
    return { ok: false, status: _rt.status, message: _rt.message, intent: null, interrupted: false, cancel: function () {} };
  }

  // ─── Events ─────────────────────────────────────────────────────────────────
  // Plain object of arrays - multiple listeners per event, no overwrites.
  // .on() returns an unsubscribe function.

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

  // ─── State ──────────────────────────────────────────────────────────────────

  var _jobs             = {};  // jobId   -> { handler, params } - active inference jobs
  var _downloads        = {};  // modelId -> session callbacks - active downloads
  var _pendingDownloads = {};  // modelId -> session callbacks - saved on focusout, restored on focusin.
                               // Mirrors _pending for inference but for downloads.
                               // Downloads continue natively via NSURLSession / WorkManager -
                               // we just need to keep callbacks alive so onDownloadProgress keeps
                               // routing and onDownloadEnd fires to the right session handler on reopen.
  var _removes          = {};  // modelId -> { resolve, reject }
  var _removeAll        = null;
  var _booted           = false;
  var _pending          = {};  // jobId   -> { handler, params } - inference jobs interrupted by background.
                               // Populated on focusout - every active job saved, not just the last.
                               // Drained and re-fired on focusin - all jobs resume automatically.
                               // Cleaned on complete, error, and cancel so only genuinely
                               // interrupted jobs ever resume. Developer writes zero code for this.

  // ─── Native app lifecycle ───────────────────────────────────────────────────
  //
  // BACKGROUND:
  // visibilitychange was tried first but was unreliable in WebViews. iOS suspends
  // the JS thread before visibilitychange handlers reliably execute - state saves
  // happened too late or not at all. On Android timing was inconsistent.
  //
  // SOLUTION:
  // Despia injects window.focusout and window.focusin directly from the OS:
  //   iOS applicationDidEnterBackground   -> window.focusout()
  //   iOS applicationWillEnterForeground  -> window.focusin()
  //   Android onPause                     -> window.focusout()
  //   Android onResume                    -> window.focusin()
  //
  // The native runtime calls these synchronously before suspending the WebView.
  // The JS context is provably alive. This is the guaranteed window to save state.
  //
  // DESIGN:
  // Every active job is saved to _pending on focusout.
  // Every job in _pending is re-fired on focusin.
  // 7 concurrent jobs? All 7 resume. Developer writes nothing for this.

  if (typeof window !== 'undefined') {

    window.focusout = function () {
      // ── Inference jobs ──────────────────────────────────────────────────────
      // Native inference session dies when app backgrounds.
      // Save every active job so focusin can re-fire them.
      Object.keys(_jobs).forEach(function (id) {
        var job = _jobs[id];
        if (!job) return;

        _pending[id] = { handler: job.handler, params: job.params };

        // Call handler.interrupted if developer set it - backwards compatible
        if (job.handler && job.handler.interrupted) {
          try { job.handler.interrupted(job.params); } catch (e) {}
        }
      });

      _jobs = {};

      // ── Downloads ───────────────────────────────────────────────────────────
      // Downloads continue natively via NSURLSession / WorkManager - we do not
      // need to re-fire them. We just need to keep the session callbacks alive
      // so that onDownloadProgress keeps flowing and onDownloadEnd fires to
      // the right handler when the download completes on reopen.
      //
      // Save _downloads into _pendingDownloads. On focusin, restore them back
      // into _downloads so the native callbacks have somewhere to route to.
      Object.keys(_downloads).forEach(function (modelId) {
        _pendingDownloads[modelId] = _downloads[modelId];
      });
      // Do NOT clear _downloads here - if the app merely backgrounds and returns
      // quickly, the callbacks are still registered and work without any action.
    };

    window.focusin = function () {
      // ── Inference jobs ──────────────────────────────────────────────────────
      // Re-fire every interrupted inference job.
      // Swap _pending before iterating so cancel() during resume doesn't re-queue.
      var toResume = _pending;
      _pending = {};

      Object.keys(toResume).forEach(function (id) {
        var job = toResume[id];
        if (job) {
          try { run(job.params, job.handler); } catch (e) {}
        }
      });

      // ── Downloads ───────────────────────────────────────────────────────────
      // Restore saved download callbacks back into _downloads.
      //
      // If the app was backgrounded while a download was in progress,
      // _pendingDownloads has the session callbacks. On reopen:
      //   - If the download completed while backgrounded, the native layer
      //     replays onDownloadEnd - _downloads[modelId] must be there to receive it.
      //   - If the download is still in progress, onDownloadProgress events resume
      //     flowing - _downloads[modelId] must be there to receive them.
      //
      // Merge rather than replace - in case a new download was started
      // between focusout and focusin (edge case, but safe to handle).
      Object.keys(_pendingDownloads).forEach(function (modelId) {
        if (!_downloads[modelId]) {
          _downloads[modelId] = _pendingDownloads[modelId];
        }
      });
      _pendingDownloads = {};
    };

  }

  // ─── Boot ───────────────────────────────────────────────────────────────────
  // Wires window callbacks to job handlers. Called lazily on first run().
  // Safe to call multiple times - guarded by _booted flag.

  function _boot() {
    if (_booted || !_rt.ok) return;
    _booted = true;

    window.onMLToken = function (id, chunk) {
      var job = _jobs[id];
      if (job && job.handler && job.handler.stream) {
        try { job.handler.stream(chunk); } catch (e) {}
      }
    };

    // onMLComplete(id, fullText)
    // Native sends the full response string as the second argument.
    // Same value as the last onMLToken chunk but guaranteed to be the final complete value.
    window.onMLComplete = function (id, fullText) {
      var job = _jobs[id];
      if (job) {
        if (job.handler && job.handler.complete) {
          try { job.handler.complete(fullText); } catch (e) {}
        }
        delete _jobs[id];
        // Completed cleanly - remove from _pending so focusin does not re-fire it.
        // Only genuinely interrupted jobs auto-resume.
        delete _pending[id];
      }
    };

    window.onMLError = function (err) {
      var jobId = err && err.jobId;
      var job   = _jobs[jobId];
      if (job) {
        if (job.handler && job.handler.error) {
          try { job.handler.error({ code: err.errorCode, message: err.errorMessage }); } catch (e) {}
        }
        delete _jobs[jobId];
        // Errored - remove from _pending so focusin does not retry a failed job.
        delete _pending[jobId];
      }
    };

    if (!window.intelligence) window.intelligence = {};

    window.intelligence.onAvailableModelsLoaded = function (list) {
      if (window.__resAvail) { window.__resAvail(list); window.__resAvail = null; }
    };

    window.intelligence.onInstalledModelsLoaded = function (list) {
      if (window.__resInst) { window.__resInst(list); window.__resInst = null; }
    };

    window.intelligence.onDownloadStart = function (id) {
      var cb = _downloads[id];
      if (cb && cb.onStart) try { cb.onStart(); } catch (e) {}
      _emit('downloadStart', id);
    };

    window.intelligence.onDownloadProgress = function (id, pct) {
      // Native sends a 0-1 float. Normalise to a 0-100 integer once here so
      // session callbacks and global event listeners both receive the same
      // developer-friendly percentage value.
      var percent = pct;
      if (typeof percent === 'number') {
        if (percent <= 1) percent = percent * 100;
        percent = Math.max(0, Math.min(100, Math.round(percent)));
      }
      var cb = _downloads[id];
      if (cb && cb.onProgress) try { cb.onProgress(percent); } catch (e) {}
      _emit('downloadProgress', id, percent);
    };

    window.intelligence.onDownloadEnd = function (id) {
      var cb = _downloads[id];
      if (cb && cb.onEnd) try { cb.onEnd(); } catch (e) {}
      delete _downloads[id];
      delete _pendingDownloads[id];  // download complete - no need to restore on focusin
      _emit('downloadEnd', id);
    };

    window.intelligence.onDownloadError = function (id, err) {
      var cb = _downloads[id];
      if (cb && cb.onError) try { cb.onError(err); } catch (e) {}
      delete _downloads[id];
      delete _pendingDownloads[id];  // download failed - no need to restore on focusin
      _emit('downloadError', id, err);
    };

    window.intelligence.onRemoveSuccess = function (id) {
      if (_removes[id]) { _removes[id].resolve(); delete _removes[id]; }
    };

    window.intelligence.onRemoveError = function (id, err) {
      if (_removes[id]) { _removes[id].reject(new Error(err)); delete _removes[id]; }
    };

    window.intelligence.onRemoveAllSuccess = function () {
      if (_removeAll) { _removeAll.resolve(); _removeAll = null; }
    };

    window.intelligence.onRemoveAllError = function (err) {
      if (_removeAll) { _removeAll.reject(new Error(err)); _removeAll = null; }
    };
  }

  // ─── run ────────────────────────────────────────────────────────────────────
  // Primary API. params is a plain object. type routes the call.
  // handler wires the callbacks. Returns a call handle with .cancel() and .intent.
  // Every job is automatically observed - focusout saves it, focusin resumes it.
  // Any number of concurrent jobs all resume. Developer writes nothing for this.

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
        // Cancelled explicitly - remove from _pending so focusin does not resume it.
        delete _pending[built.id];
      },
    };
  }

  // ─── models ─────────────────────────────────────────────────────────────────

  var models = {
    available: function () {
      if (!_rt.ok) return Promise.resolve(_nr());
      _boot();
      if (window.intelligence && window.intelligence.availableModels && window.intelligence.availableModels.length) {
        return Promise.resolve(window.intelligence.availableModels);
      }
      return new Promise(function (resolve) {
        window.__resAvail = resolve;
        _fire('intelligence://models?query=all');
      });
    },

    installed: function () {
      if (!_rt.ok) return Promise.resolve(_nr());
      _boot();
      if (window.intelligence && window.intelligence.installedModels && window.intelligence.installedModels.length) {
        return Promise.resolve(window.intelligence.installedModels);
      }
      return new Promise(function (resolve) {
        window.__resInst = resolve;
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

  // ─── Public API ─────────────────────────────────────────────────────────────

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
