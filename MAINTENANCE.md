# MAINTENANCE

Internal team docs for `despia-intelligence`. Not published to users.

For the **full raw WebView bridge** (scheme URLs, `window` callbacks, lifecycle hooks, and a 1:1 map to the npm API), see **[RAW_BRIDGE.md](./RAW_BRIDGE.md)**.

---

## What this package is

A thin wrapper around the Despia Local Intelligence WebView bridge. It does four things and nothing else:

1. Serialises a plain params object to an `intelligence://` scheme URL (percent-encoded via `encodeURIComponent`) and enqueues it for **`window.despia = command`** via the same **despia-native-style** command queue (not `location.href`)
2. Generates and manages job IDs invisibly
3. Routes native `window` callbacks to the right handler
4. Auto-resumes every interrupted job on app return via `window.focusout` / `window.focusin`
5. Persists download session callbacks across background so `onProgress` keeps flowing and `onEnd` fires to the right handler on reopen

It does not restrict what the native system can do. Adding a new scheme route requires zero changes to any function - only the `TYPES` config at the top of `index.js`.

---

## How the native bridge works

Despia turns web apps into native iOS and Android apps by running them inside a native WebView shell. The npm package fires scheme URLs through **`window.despia`** (queued like **despia-native**), which Despia routes like an intercepted navigation without touching **`location.href`** (better for SPAs and debugging). Native handling aligns with the same policy entry points as URL loads:

- iOS: `WebViewController.swift` → `decidePolicyFor navigationAction`
- Android: `MainActivity.java` → `shouldOverrideUrlLoading`

Results come back through global `window` callbacks the native layer fires directly. There is no variable injection. The `despia-native` variable-watching Promise system is not used here - intelligence results are direct function calls, not variable writes.

### Runtime detection - `native_runtime` only

```
window.native_runtime = 'despia'   Despia WebView runtime is active
```

There is no `intelligence_available` flag. Resolved once at import time.

| `native_runtime` | `runtime.status` | `ok` |
|---|---|---|
| `'despia'` | `'ready'` | `true` |
| not set, UA includes `'despia'` | `'outdated'` | `false` |
| not set, UA clean | `'unavailable'` | `false` |

`window.__DESPIA_UA_OVERRIDE = true` before import forces `hasUA = true` for white-label builds with a custom user agent. Not publicly documented.

### Scheme table

| Action | Scheme |
|---|---|
| Available models (catalog) | Injected as `window.intelligence.availableModels` - npm `models.available()` reads this only |
| Available models (scheme, native) | `intelligence://models?query=all` may still exist for other callers |
| Installed models | `intelligence://models?query=installed` |
| Download model | `intelligence://download?model=<id>` |
| Remove model | `intelligence://remove?model=<id>` |
| Remove all | `intelligence://remove?model=all` |
| Text inference | `intelligence://text?id=<uuid>&model=<id>&prompt=<text>&...` |
| Transcription (future) | `intelligence://microphone?id=<uuid>&model=<id>` |
| Audio out (future) | `intelligence://audio?id=<uuid>&model=<id>&prompt=<text>&response=speak,file` |
| Vision (future) | `intelligence://vision?id=<uuid>&model=<id>&prompt=<text>&file=<path>` |
| Embed (future) | `intelligence://embed?id=<uuid>&model=<id>&input=<text>` |

### Native bridge - two surfaces

**Inference (streaming):** native invokes **`window.onMLToken`**, **`window.onMLComplete`**, **`window.onMLError`** after the SDK assigns them in `_boot()` (property assignment on `window`). **`onMLError`** includes **`jobId`** for concurrent job routing.

**Model lifecycle:** native exposes **registrar functions** on **`window.intelligence`** (`onDownloadStart(fn)`, etc.). `_boot()` registers SDK handlers via those calls.

App lifecycle - still assigned on `window` by the native runtime (not registrars):

```
window.focusout()
  iOS applicationDidEnterBackground / Android onPause
  called synchronously before WebView suspension - JS context guaranteed alive
  SDK copies every entry in _jobs into _pending and clears _jobs
  SDK copies every entry in _downloads into _pendingDownloads - does NOT clear _downloads

window.focusin()
  iOS applicationWillEnterForeground / Android onResume
  called synchronously - JS context guaranteed alive
  SDK swaps _pending out, clears it, and re-fires run(params, handler) for each entry
  A cancel() during this loop therefore cannot re-queue itself
  SDK merges _pendingDownloads back into _downloads (only for slots not already present)
  and clears _pendingDownloads
```

Model catalogues (WebView-injected arrays):

```
window.intelligence.availableModels   // read synchronously; npm models.available() uses this
window.intelligence.installedModels     // updated after install/remove; may still refresh via scheme
```

`models.installed()` uses **`_observe('installedModels', …)`** (despia-native-style variable watch) after firing `intelligence://models?query=installed` - not `onInstalledModelsLoaded`.

Model + download + remove events (registrars used in `_boot`):

```
window.intelligence.onDownloadStart(function (modelId) { ... })
window.intelligence.onDownloadProgress(function (modelId, pct) { ... })
window.intelligence.onDownloadEnd(function (modelId) { ... })
window.intelligence.onDownloadError(function (modelId, err) { ... })
window.intelligence.onRemoveSuccess(function (modelId) { ... })
window.intelligence.onRemoveError(function (modelId, err) { ... })
window.intelligence.onRemoveAllSuccess(function () { ... })
window.intelligence.onRemoveAllError(function (err) { ... })
```

### App lifecycle

Text, transcription, and audio inference sessions do not survive app backgrounding. The native layer owns the session and tears it down before suspension. The SDK re-fires every interrupted job automatically when the app returns.

**Why not `visibilitychange`**

The original SDK used `document.addEventListener('visibilitychange', ...)`. It was unreliable:

- iOS suspends the JS thread almost immediately on background; `visibilitychange` handlers often did not execute before suspension. `applicationDidEnterBackground` in Swift fires before JS gets any event.
- On Android, `visibilitychange` timing is inconsistent across WebView implementations and versions. Can be delayed seconds or not fire at all.

**Why `focusout` / `focusin` works**

These are not DOM events - they are direct native-to-JS function calls that Despia invokes from inside the OS lifecycle callbacks, synchronously, before any suspension. The JS context is provably alive. The save-state and resume windows are guaranteed.

**Auto-resume semantics**

On `focusout`, every entry in `_jobs` is copied into `_pending`, then `_jobs` is cleared. `handler.interrupted(intent)` is also fired per active job for backwards compatibility and UI affordances like a "Resuming..." toast. It is no longer required to implement resume.

On `focusin`, `_pending` is swapped to a local and cleared in a single step, then each saved entry is re-fired via `run(params, handler)`. Swap-before-iterate means a `cancel()` landed during the resume loop cannot re-queue itself.

Four things remove a job from `_pending`:

1. `onMLComplete` - completed cleanly, never re-fires
2. `onMLError` - errored, never retries
3. `call.cancel()` - explicitly stopped, never resumes
4. The `focusin` drain itself

**Downloads are different from inference**

Downloads continue natively via NSURLSession (iOS) and WorkManager (Android) - they do not die on background, and we do not re-fire them. The native layer replays `onDownloadEnd` and `onDownloadError` on reopen but never replays `onDownloadProgress`.

The only problem worth solving at the SDK level is keeping the JS-side session callbacks alive across background so the replayed `onDownloadEnd` can route to `cb.onEnd()` instead of being silently dropped.

- On `focusout`, every entry in `_downloads` is copied into `_pendingDownloads`. `_downloads` is intentionally NOT cleared so a fast background/foreground cycle keeps working without any action.
- On `focusin`, `_pendingDownloads` is merged back into `_downloads` (only slots that are not already present, to cover the edge case of a new download started between `focusout` and `focusin`), then `_pendingDownloads` is cleared.
- `onDownloadEnd` and `onDownloadError` delete from both `_downloads` and `_pendingDownloads` so a completed or failed download never resurrects on a later `focusin`.

Full kill-and-relaunch mid-download is the one case session callbacks cannot cover - the JS context is gone. That is why global events (`intelligence.on('downloadEnd', ...)`) are the documented safety net for persistent state, registered at boot.

---

## TYPES config - single source of truth

The only thing that needs editing to add or enable a type. Lives at the top of `index.js`.

```js
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
```

| Field | Description |
|---|---|
| `route` | The `intelligence://` route segment |
| `enabled` | `false` = throws a clear error. `true` = live |
| `params` | Informational only - not validated. Any key still passes through |

### To enable a type when native ships it

1. Flip `"enabled": false` → `"enabled": true`
2. Update `type` union in `index.d.ts`
3. Add usage example to `README.md`
4. Bump minor version in `package.json`

No other changes needed anywhere.

### To add a brand new type

1. Add entry to `TYPES` with `"enabled": false`
2. Confirm with iOS/Android team: route name, which callbacks it fires, result shape
3. Flip to `true` when confirmed, update `index.d.ts` and `README.md`, bump version

### Error messages

```
[despia-intelligence] Unknown type: "xyz". Supported: text
→ type not in TYPES at all

[despia-intelligence] Type "audio" is not yet supported in this release. Supported: text
→ type in TYPES but enabled is false
```

The supported list is generated dynamically - always accurate as types are enabled.

---

## Internal state reference

| Variable | Type | Purpose |
|---|---|---|
| `_jobs` | `{}` | `jobId → { handler, params }`. Active inference jobs. Deleted on complete, error, cancel. Cleared on `focusout`. |
| `_pending` | `{}` | `jobId → { handler, params }`. Jobs interrupted by app background. Populated on `focusout`, drained and re-fired on `focusin`. Deleted on complete, error, cancel. |
| `_downloads` | `{}` | `modelId → session callbacks`. Active downloads. Not cleared on `focusout`. Deleted on end or error. |
| `_pendingDownloads` | `{}` | `modelId → session callbacks`. Mirrors `_downloads` across background. Populated on `focusout`, merged back into `_downloads` on `focusin`, then cleared. Also deleted on end or error so completed downloads never resurrect. |
| `_removes` | `{}` | `modelId → { resolve, reject }`. Pending remove promises. |
| `_removeAll` | `null \| object` | Pending removeAll promise. One at a time. |
| `_booted` | `boolean` | Guards `_boot()`. Callbacks wired once only. |
| `_ev` | `{}` | `event → fn[]`. Global event emitter. |
| `TYPES` | `{}` | Config. Single source of truth for type support. |

---

## Rules - non-negotiable

- No dependencies. No build step. No bundler. No ESM-only exports.
- No logging or console output anywhere.
- No retry logic - the native layer handles retries.
- No `init()`, `setup()`, or `configure()`. Boot is lazy on first `run()`.
- No `Promise` polyfills - target environment is the Despia WebView which supports ES6+ natively. The UMD wrapper and ES5 style are for module system compatibility only, not for old browsers.
- Do not add stubs for future types. They live in `TYPES` with `enabled: false`.
- Do not rename internals: `_fire`, `_build`, `_uuid`, `TYPES`, `_supported_list`, `_rt`, `_nr`, `_ev`, `_emit`, `_on`, `_off`, `_once`, `_jobs`, `_pending`, `_downloads`, `_pendingDownloads`, `_removes`, `_removeAll`, `_booted`, `_boot`, `run`, `models`.
- Do not add back `visibilitychange`, `pagehide`, or `beforeunload` listeners. Lifecycle is handled by native-injected `window.focusout` / `window.focusin`.
- Do not collapse `_pending` back to a single `_lastIntent` slot. The map is load-bearing - concurrent jobs must all resume.
- Do not clear `_downloads` on `focusout`. The download is still in progress natively and callbacks must keep routing if the app returns quickly.
- Do not try to re-fire downloads on `focusin` the way inference jobs are re-fired. NSURLSession / WorkManager own the transfer - re-firing would start a duplicate download.
- Do not attempt to fabricate `onDownloadProgress` events on `focusin`. The native layer does not replay them and we have no source of truth for the current percentage until the next real progress tick.

---

## Per-release WebView QA (native build)

Run this on a **real Despia iOS and Android build** that includes Local Intelligence, before treating an SDK + native combo as shippable. Node tests in this repo do not replace this pass.

### Environment

- [ ] `window.native_runtime === 'despia'`
- [ ] `intelligence.runtime.ok === true` and `status === 'ready'` after import
- [ ] `window.intelligence` exists; `availableModels` is a non-empty array after boot (when models are configured on the build)

### Inference (`run`, `type: 'text'`)

- [ ] After first `intelligence.run(...)`, **`typeof window.onMLToken === 'function'`** (and `onMLComplete`, `onMLError`) - SDK `_boot()` wired flat on `window`
- [ ] Single job: tokens stream; **`stream` handler receives full accumulated text** each time (replace, not append semantics in UI)
- [ ] **`complete`** fires once with final string; **`onMLError`** path if you force an error - payload includes **`jobId`** when multiple jobs exist
- [ ] **Two concurrent jobs** with different prompts: each handler only receives its job’s tokens/errors

### Models

- [ ] **`await intelligence.models.available()`** matches native catalog (ids, names, categories)
- [ ] **`await intelligence.models.installed()`** resolves after `query=installed` (empty array valid); no hung promise after 35s wait
- [ ] **Download**: `onStart` / `onProgress` (0-100) / `onEnd` or `onError`; background app mid-download then return. Progress or end still reaches the session callbacks or global `intelligence.on('download*')` listeners as designed
- [ ] **Remove** / **removeAll**: promise resolves; `installedModels` updates

### Lifecycle

- [ ] **Home button mid-generation**: on return, interrupted jobs **resume** without app code re-calling `run` for those intents
- [ ] **`handler.interrupted`**: fires **once per active job** on `focusout` if you use it (optional smoke)

### Release hygiene

- [ ] Update **[CHANGELOG.md](./CHANGELOG.md)** with the version and date when you cut the release
- [ ] Bump **`package.json`** version; tag Git; **`npm publish`** after `npm test`

---

## Shipping checklist - new type

- [ ] Native team confirms route name and callback shape
- [ ] Entry exists in `TYPES` with `"enabled": false`
- [ ] `"enabled"` flipped to `true`
- [ ] `"params"` array updated
- [ ] `index.d.ts` - `type` union updated
- [ ] `README.md` - usage example added
- [ ] `package.json` - minor version bumped
- [ ] Tested against Despia V4 build with native route active
