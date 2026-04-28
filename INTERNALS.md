# INTERNALS

Internal documentation for maintainers and native integrators. Not published on npm (`package.json` `files`).

## Contents

- [Package maintenance](#package-maintenance)
  - [What this package is](#what-this-package-is)
  - [How the native bridge works](#how-the-native-bridge-works)
  - [App lifecycle](#app-lifecycle)
  - [TYPES config](#types-config---single-source-of-truth)
  - [Internal state reference](#internal-state-reference)
  - [Rules](#rules---non-negotiable)
  - [Per-release WebView QA](#per-release-webview-qa-native-build)
  - [Shipping checklist - new type](#shipping-checklist---new-type)
- [Raw WebView bridge reference](#raw-webview-bridge-reference)
- [Future ideas (not shipped)](#future-ideas-not-shipped)
  - [Multi-modal - attach files](#multi-modal---attach-files)
  - [Native file picker](#native-file-picker)
  - [Stacking - text to speech per sentence](#stacking---text-to-speech-per-sentence)
  - [Future model catalogue](#future-model-catalogue)
  - [Shipping checklist - publishing an idea](#shipping-checklist---publishing-an-idea)

---

## Package maintenance

### What this package is

A thin wrapper around the Despia Local Intelligence WebView bridge. It does five things and nothing else:

1. Serialises params to an `intelligence://` URL and enqueues **`window.despia = url`** with a **~1ms** gap between writes via internal **`_fire`** (same surface as the old **`location.href`** bridge, without mutating **`location`**).
2. Generates and manages job IDs invisibly
3. Routes native `window` callbacks to the right handler
4. Auto-resumes every interrupted job on app return via `window.focusout` / `window.focusin`
5. Persists download session callbacks across background so `onProgress` keeps flowing and `onEnd` fires to the right handler on reopen

It does not restrict what the native system can do. Adding a new scheme route requires zero changes to any function - only the `TYPES` config at the top of `index.js`.

---

### How the native bridge works

Schemes are delivered with `window.despia` (the SDK uses a FIFO queue with ~1ms between writes inside `_fire`), not `location.href`. Native intercepts like navigation (iOS `decidePolicyFor`, Android `shouldOverrideUrlLoading`). Callbacks live on `window.intelligence` (native calls them directly). Full parameters, flows, and tables are in [Raw WebView bridge reference](#raw-webview-bridge-reference) below.

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


### TYPES config - single source of truth

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

### Internal state reference

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

### Rules - non-negotiable

- No dependencies. No build step. No bundler. No ESM-only exports.
- No `console.log` or noisy logging in normal paths. The only exception is `console.error('[despia-intelligence] Despia command failed:', e)` when assigning to `window.despia` throws inside `_fire` (native setter failure).
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

### Per-release WebView QA (native build)

Run this on a **real Despia iOS and Android build** that includes Local Intelligence, before treating an SDK + native combo as shippable. Node tests in this repo do not replace this pass.

### Environment

- [ ] `window.native_runtime === 'despia'`
- [ ] `intelligence.runtime.ok === true` and `status === 'ready'` after import
- [ ] `window.intelligence` exists; `availableModels` is a non-empty array after boot (when models are configured on the build)

### Inference (`run`, `type: 'text'`)

- [ ] After first `intelligence.run(...)`, **`typeof window.intelligence.onMLToken === 'function'`** (and `onMLComplete`, `onMLError`) - SDK `_boot()` wired under `window.intelligence`
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

- [ ] Bump **`package.json`** version; tag Git with version and date in the message or GitHub Release notes; **`npm publish`** after `npm test`

---

### Shipping checklist - new type

- [ ] Native team confirms route name and callback shape
- [ ] Entry exists in `TYPES` with `"enabled": false`
- [ ] `"enabled"` flipped to `true`
- [ ] `"params"` array updated
- [ ] `index.d.ts` - `type` union updated
- [ ] `README.md` - usage example added
- [ ] `package.json` - minor version bumped
- [ ] Tested against Despia V4 build with native route active


---

## Raw WebView bridge reference

**Internal reference.** This document describes the native WebView bridge as a direct contract: scheme URLs fired from JavaScript and callbacks invoked in the JS context. It is the conceptual source of truth that [`despia-intelligence`](https://www.npmjs.com/package/despia-intelligence) (the npm package) is built on.

Every public behaviour of the npm package maps to something here. The package does not add capabilities the bridge does not expose; it adds routing, encoding, lifecycle glue, and safety. If you are forking the package, porting to another language, or collaborating on native changes, start here and confirm details with the iOS/Android teams.

---

### How the bridge works

Despia runs your web app inside a native WebView shell. The bridge is bidirectional.

**JS → native:** assign the scheme URL string to **`window.despia`**. Despia routes it like an intercepted navigation **without** assigning **`window.location.href`**, which avoids SPA router clashes and keeps bridge traffic easy to log or breakpoint.

- **iOS:** `WebViewController.swift` → `decidePolicyFor navigationAction`
- **Android:** `MainActivity.java` → `shouldOverrideUrlLoading`

**Native → JS:** callbacks are invoked on **`window.intelligence`** directly. **Streaming inference** calls `window.intelligence.onMLToken`, `window.intelligence.onMLComplete`, and `window.intelligence.onMLError` after the SDK assigns them. **Model download / remove / progress** also calls `window.intelligence.onDownload*` / `onRemove*` functions directly (no registrar pattern). Lifecycle hooks **`window.focusout` / `window.focusin`** are assigned on `window` by native. No variable injection for tokens; no promise handoff from native for inference.

Examples below use **`window.despia = '…'`** directly (what the native Xcode / Android Studio WebView exposes). The [`despia-native`](https://www.npmjs.com/package/despia-native) npm package exposes **`despia(url)`** that queues and assigns **`window.despia`**. **`despia-intelligence`** does the same for **`run`** and **`models.*`** only: a short FIFO with **~1ms** between **`window.despia = url`** writes so concurrent calls do not stack in one tick. Prefer **`run`** / **`models`** so encoding and job IDs stay correct. Never **`location.href`** for these schemes.

---

### Runtime detection

The WebView injects the runtime flag on boot (read once at page load):

```js
window.native_runtime // === 'despia' inside the Despia WebView
```

There is **no** `window.intelligence_available` variable. If `native_runtime === 'despia'`, the Local Intelligence bridge is available from the JS perspective.

The npm package still treats a Despia-like user agent **without** `native_runtime === 'despia'` as **`outdated`**, and exposes `intelligence.runtime` with statuses `ready` | `outdated` | `unavailable`. Minimal raw gate:

```js
const ready = window.native_runtime === 'despia'
```

---

### Scheme 1 - One-shot inference (`appleintelligence://`)

**iOS only (documented contract).** Fires via `appleintelligence://`. Runs the prompt to completion and invokes a named global function with the full response string. No streaming and no job ID.

#### Fire the call

```js
window.despia =
  'appleintelligence://?prompt=' + encodeURIComponent('What is the capital of France?')
```

#### Parameters

| Key | Type | Required | Description |
| --- | --- | --- | --- |
| `prompt` | string | Yes | User prompt |
| `instructions` | string | No | System-style instruction context |
| `callback` | string | No | Name of a global function on `window` to receive the result. Defaults to `handleAIResponse` |

#### Callback

Native calls `window[callback](response)` on success. On failure, the same callback may receive an error message string (there is no separate error callback in this scheme).

```js
function handleAIResponse(response) {
  document.getElementById('output').textContent = response
}

window.despia =
  'appleintelligence://?prompt=' + encodeURIComponent('Explain TCP in one sentence.')
```

Custom callback and instructions:

```js
function myCallback(response) {
  console.log(response)
}

window.despia =
  'appleintelligence://?' +
  'instructions=' + encodeURIComponent('Reply in one sentence.') +
  '&prompt=' + encodeURIComponent('What is TCP?') +
  '&callback=myCallback'
```

#### Flow

```
appleintelligence://?prompt=...&callback=handleAIResponse
  → native intercepts scheme
  → native runs one-shot completion
  → window.handleAIResponse(response)   // success
  → window.handleAIResponse(message)    // failure (string)
```

---

### Scheme 2 - Streaming inference (`intelligence://text`)

**iOS and Android.** Text streaming uses the **`intelligence://`** host with a **`text`** path segment and a query string. The npm package always uses this route for `type: 'text'` (see `TYPES.text.route` in `index.js`).

#### Inference callbacks - `window.intelligence` (internal native contract)

Streaming inference uses **function assignment on `window.intelligence`** (the SDK assigns the functions; native calls them). This matches the current internal runtime contract.

Assign **once** per page (or compose your own dispatcher). Use the job **`id`** to correlate concurrent streams. **`onMLError`** includes **`jobId`** so you can route errors to the correct handler.

```js
const jobId = crypto.randomUUID()

window.intelligence = window.intelligence || {}

window.intelligence.onMLToken = function (id, chunk) {
  if (id !== jobId) return
  // chunk is the FULL accumulated response so far - replace UI, do not append
  document.getElementById('output').textContent = chunk
}

window.intelligence.onMLComplete = function (id, fullText) {
  if (id !== jobId) return
  console.log('Complete:', fullText)
}

window.intelligence.onMLError = function (err) {
  console.error(err.jobId, err.errorCode, err.errorMessage)
}
```

#### Fire the call

Use **`intelligence://text`** plus `encodeURIComponent` for every query value (the npm package does this for all keys so `+` is never used for spaces).

```js
window.despia =
  'intelligence://text?' +
  'id=' + encodeURIComponent(jobId) +
  '&prompt=' + encodeURIComponent('What is the capital of France?')
```

With system prompt and model:

```js
window.despia =
  'intelligence://text?' +
  'id=' + encodeURIComponent(jobId) +
  '&model=' + encodeURIComponent('qwen3-0.6b') +
  '&system=' + encodeURIComponent('Reply in three sentences or fewer.') +
  '&prompt=' + encodeURIComponent('What is the difference between TCP and UDP?') +
  '&stream=' + encodeURIComponent('true')
```

#### Parameters (text route)

| Key | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | string | Yes | Job id; echoed on every callback |
| `prompt` | string | Yes | User prompt |
| `system` | string | No | System / instruction context |
| `model` | string | No | Model id, e.g. `qwen3-0.6b` |
| `stream` | string/boolean | No | Passed through when set (`'true'` in examples) |
| `webhook` | string | No | Reserved; parsed by native, not active in public docs |

Additional keys supported by native may be forwarded as query params; the npm package forwards arbitrary keys on the params object except `type`.

#### Callbacks (inference - `window.intelligence`)

Native calls the **`window.intelligence.onMLToken` / `window.intelligence.onMLComplete` / `window.intelligence.onMLError`** functions you assigned.

**`onMLToken(id, chunk)`** - **`chunk`** is the full accumulated text so far, not a delta. Replace the target element’s text; do not append.

**`onMLComplete(id, fullText)`** - Called once when inference finishes. `fullText` matches the final `chunk` from `onMLToken`.

**`onMLError({ jobId, errorCode, errorMessage })`** - `jobId` is present for routing when multiple jobs run.

#### Error codes (streaming / text route)

| Code | Description |
| --- | --- |
| `1` | `appleintelligence://` - missing `prompt` (per legacy one-shot docs) |
| `2` | `intelligence://` text route - missing `id` |
| `3` | Runtime inference error - see `errorMessage` |

#### Flow

```
intelligence://text?id=abc&prompt=...
  → native intercepts scheme
  → streaming session for job abc
  → window.intelligence.onMLToken('abc', accumulatedText)   // repeats
  → window.intelligence.onMLComplete('abc', fullText)       // once
  → window.intelligence.onMLError({ jobId, errorCode, errorMessage }) // on failure
```

#### Multiple concurrent jobs

Use a unique `id` per job and branch inside your `window.onML*` handlers (or maintain a map). The npm package keeps an internal job table so each `intelligence.run()` handler only receives its own events.

---

### Scheme 3 - Model management

The WebView injects **`window.intelligence.availableModels`** and **`window.intelligence.installedModels`** as arrays (read synchronously; native updates them after install/remove). Downloads and removes still use **`intelligence://`** URLs **without** a text job `id`. Event delivery uses **direct native calls** into SDK-assigned `window.intelligence.onDownload*` / `onRemove*` functions.

```js
window.intelligence = window.intelligence || {}
```

#### Available models (scheme + injected variable)

The native layer injects `window.intelligence.availableModels` and may also fire `window.intelligence.onAvailableModelsLoaded(models)`.

The SDK’s `models.available()` triggers a refresh:

```js
// SDK will fire intelligence://models?query=all and resolve once availableModels updates
const models = await intelligence.models.available()
```

#### Installed models (scheme refresh + variable update)

Fire **`intelligence://models?query=installed`**. The WebView then **writes `window.intelligence.installedModels` directly** (same idea as `despia-native` watching `window[variableName]` after a scheme). The npm package does **not** depend on `onInstalledModelsLoaded`; it pre-clears the array, fires the scheme, and **polls** until `installedModels` becomes a “ready” non-empty snapshot or the value’s signature changes - then resolves (or resolves `[]` after a timeout so the promise never hangs).

```js
window.despia = 'intelligence://models?query=installed'
// … later, WebView assigns e.g.:
// window.intelligence.installedModels = [{ id: 'qwen3_0_6b', name: 'Qwen3 0.6b', category: 'text' }, ...]
```

You can still read **`window.intelligence.installedModels`** synchronously when you only need the last snapshot the WebView wrote.

#### Download a model

```js
window.despia =
  'intelligence://download?model=' + encodeURIComponent('qwen3_0_6b')
```

Downloads continue in the background via **NSURLSession** (iOS) and **WorkManager** (Android). Retry behaviour is owned by native code.

**Registrars:**

```js
window.intelligence.onDownloadStart((modelId) => {})
window.intelligence.onDownloadProgress((modelId, pct) => {
  // Native sends pct as a 0-1 float; npm normalises to 0-100 for session callbacks.
})
window.intelligence.onDownloadEnd((modelId) => {})
window.intelligence.onDownloadError((modelId, err) => {
  // err is a string message
})
```

#### Remove models

```js
window.despia =
  'intelligence://remove?model=' + encodeURIComponent('qwen3_0_6b')

window.despia = 'intelligence://remove?model=all'
```

**Registrars:**

```js
window.intelligence.onRemoveSuccess((modelId) => {})
window.intelligence.onRemoveError((modelId, err) => {})
window.intelligence.onRemoveAllSuccess(() => {})
window.intelligence.onRemoveAllError((err) => {})
```

---

### Native app lifecycle (`window.focusout` / `window.focusin`)

Injected on `window` by the Despia runtime from OS lifecycle hooks (not from `visibilitychange`, which is unreliable in WebViews when the JS thread is suspended).

```js
window.focusout = function () {
  // iOS: applicationDidEnterBackground; Android: onPause
  // Called synchronously while JS is still fully alive.
}

window.focusin = function () {
  // iOS: applicationWillEnterForeground; Android: onResume
}
```

The npm package registers its own `focusout` / `focusin` handlers to snapshot active inference jobs and download sessions, then **re-fires** interrupted text jobs on resume. Raw integrators must implement the same policy if they want identical behaviour.

---

### Complete raw example (no npm package)

Minimal HTML page showing the same primitives the SDK uses: runtime gate, callbacks on `window.intelligence`, `intelligence://text` URL, injected model arrays, and optional scheme refresh for installed models. Adjust CDN URLs and error handling for production.

```html
<!DOCTYPE html>
<html>
  <body>
    <div id="output"></div>
    <script src="https://cdn.jsdelivr.net/npm/despia-native/index.min.js"></script>
    <script>
      ;(function () {
        if (window.native_runtime !== 'despia') {
          document.getElementById('output').textContent = 'Not in Despia WebView'
          return
        }

        window.intelligence = window.intelligence || {}

        // Raw pattern: fire refresh, then poll installedModels until WebView updates it
        // (npm models.installed() uses the same observe pattern internally).
        window.intelligence.installedModels = []
        window.despia = 'intelligence://models?query=installed'
        ;(function waitInstalled() {
          var list = window.intelligence.installedModels || []
          if (list.length > 0) {
            var installed = list.some(function (m) {
              return m.id === 'qwen3_0_6b' || m.id === 'qwen3-0.6b'
            })
            if (installed) runInference()
            else downloadModel()
            return
          }
          setTimeout(waitInstalled, 100)
        })()

        function downloadModel() {
          window.intelligence.onDownloadProgress = function (id, pct) {
            var p = typeof pct === 'number' && pct <= 1 ? Math.round(pct * 100) : Math.round(pct)
            document.getElementById('output').textContent = 'Downloading: ' + p + '%'
          }
          window.intelligence.onDownloadEnd = function () {
            runInference()
          }
          window.despia = 'intelligence://download?model=qwen3_0_6b'
        }

        function runInference() {
          var jobId = crypto.randomUUID()

          window.intelligence.onMLToken = function (id, chunk) {
            if (id === jobId) document.getElementById('output').textContent = chunk
          }
          window.intelligence.onMLComplete = function (id, fullText) {
            if (id === jobId) console.log('done', fullText)
          }
          window.intelligence.onMLError = function (err) {
            console.error(err && err.errorCode, err && err.errorMessage)
          }

          window.despia =
            'intelligence://text' +
            '?id=' +
            encodeURIComponent(jobId) +
            '&model=' +
            encodeURIComponent('qwen3_0_6b') +
            '&prompt=' +
            encodeURIComponent('What is the meaning of life?') +
            '&stream=' +
            encodeURIComponent('true')
        }

        window.focusout = function () {
          /* persist in-flight work if you bypass the npm package */
        }
        window.focusin = function () {
          /* re-fire jobs if you bypass the npm package */
        }
      })()
    </script>
  </body>
</html>
```

---

### Scheme and callback tables

#### JS → native (scheme URLs)

From JavaScript, deliver any row below by assigning **`window.despia = url`** (full string, same encoding you would use for a navigation URL). That setter is the bridge surface shipped in the Despia native app project.

The **`despia-intelligence`** npm package builds URLs in **`run`** / **`models`** and sends each through a small **FIFO queue**: **`window.despia = url`**, then **~1ms** before the next, so bursts never assign twice in the same tick.

| URL | Action |
| --- | --- |
| `appleintelligence://?prompt=<text>` | One-shot inference (iOS only) |
| `appleintelligence://?prompt=<text>&instructions=<text>&callback=<fn>` | One-shot with instructions + custom callback name |
| `intelligence://text?id=<uuid>&...` | Streaming text inference (preferred; used by npm) |
| _(injected)_ `window.intelligence.availableModels` | Supported models snapshot (no scheme required for read) |
| `intelligence://models?query=all` | Refresh available models; native updates `window.intelligence.availableModels` |
| `intelligence://models?query=installed` | Refresh installed list; WebView updates `window.intelligence.installedModels` |
| `intelligence://download?model=<id>` | Download a model |
| `intelligence://remove?model=<id>` | Remove one model |
| `intelligence://remove?model=all` | Remove all models |

Older examples may show `intelligence://?id=...` without the `text` segment; the npm package and current native integration use **`intelligence://text`**.

#### Native → JS

| Mechanism | Arguments / shape | When |
| --- | --- | --- |
| `window[callback](response)` | `response: string` | One-shot (`appleintelligence://`) success or error string |
| `window.intelligence.onMLToken(id, chunk)` | `chunk` = full text so far | Streaming token snapshot (assign handler on `window.intelligence`) |
| `window.intelligence.onMLComplete(id, fullText)` | | Streaming complete |
| `window.intelligence.onMLError({ jobId, errorCode, errorMessage })` | | Streaming / job error |
| `window.intelligence.availableModels` | `Model[]` | Injected / updated by WebView |
| `window.intelligence.installedModels` | `Model[]` | Injected / updated after install/remove and `query=installed`; npm `installed()` uses `_observe` on this |
| `window.intelligence.onDownloadStart(modelId)` | | Download started |
| `window.intelligence.onDownloadProgress(modelId, pct)` | `pct` usually 0-1 float | Progress tick |
| `window.intelligence.onDownloadEnd(modelId)` | | Download finished |
| `window.intelligence.onDownloadError(modelId, err)` | `err: string` | Download failed |
| `window.intelligence.onRemoveSuccess(modelId)` | | Remove succeeded |
| `window.intelligence.onRemoveError(modelId, err)` | | Remove failed |
| `window.intelligence.onRemoveAllSuccess()` | | Remove all succeeded |
| `window.intelligence.onRemoveAllError(err)` | | Remove all failed |
| `window.focusout()` | - | App backgrounding (direct `window` hook) |
| `window.focusin()` | - | App foregrounding (direct `window` hook) |

---

### How `despia-intelligence` maps to this

| npm API | Raw bridge equivalent |
| --- | --- |
| `intelligence.run({ type: 'text', ... }, handler)` | Builds URL, enqueues **`window.despia = url`** (same **~1ms** FIFO as **`models.*`**), plus **`window.intelligence.onMLToken` / `onMLComplete` / `onMLError`** assignments; SDK routes by job id |
| `intelligence.models.available()` | Reads `window.intelligence.availableModels` synchronously (no scheme) |
| `intelligence.models.installed()` | Pre-clears `installedModels`, `_observe` polls until it changes, `_fire` `query=installed`; resolves `[]` on timeout |
| `intelligence.models.download(id, callbacks)` | `intelligence://download?model=<id>` + download callbacks / global events |
| `intelligence.models.remove(id)` | `intelligence://remove?model=<id>` + remove callbacks |
| `intelligence.models.removeAll()` | `intelligence://remove?model=all` + remove-all callbacks |
| `intelligence.on('downloadEnd', fn)` etc. | Same native events as `onDownloadEnd`; the package fans out through an internal listener list |
| Auto-resume after background | Package-owned `window.focusout` / `window.focusin` that re-call `run()` for interrupted jobs (each URL goes through the same **`window.despia`** queue) and restore download callback maps |

The package adds: stable **`encodeURIComponent`** query building (no `+` for spaces), UUID generation, per-job handler tables, **`try`/`catch` around user handlers**, `focusout`/`focusin` orchestration, normalised download progress (0-100), a thin **FIFO + ~1ms** spacer before each **`window.despia = url`** inside **`_fire`**, and **`_boot()`** wiring for **`window.intelligence.onML*`** and **`window.intelligence.onDownload*` / `onRemove*`**. Both match native.

---

### Confirm with native before relying on edge behaviour

The bridge contract evolves with the runtime. The following are used in this repository’s JS and tests but should be **verified on real builds** when changing native code:

- Exact shape and timing of `onMLError` and whether `jobId` is always present
- Replay of download completion callbacks when a download finishes while the app is backgrounded
- Any future routes (`intelligence://vision`, `microphone`, etc.) behind feature flags

When native behaviour is confirmed, keep this document in sync with native when the contract changes.

---

## Future ideas (not shipped)

Internal parking lot for features that are spec'd but not yet shipped by the native runtime. Not published on npm; not referenced from the public README. Move a section into **`README.md`** only after the native team confirms the route is live.

The package already passes **`file`** and **`filepicker`** through unchanged. These ideas are about **publishing** usage examples, not about any code changes in **`index.js`**.

### Multi-modal - attach files

Gated on: vision-capable text models shipping + native file ingestion pipeline for `file=` in the `text` route.

```js
intelligence.run({
  type:   'text',
  model:  'lfm2.5-vl-1.6b',
  prompt: 'Describe this image.',
  file:   ['/var/mobile/.../photo.jpg'],
}, {
  stream:   (chunk)  => el.textContent = chunk,
  complete: (result) => save(result),
})
```

#### Multiple mixed sources

Gated on: native URL-fetch and `cdn:<index>` resolver.

```js
intelligence.run({
  type:   'text',
  model:  'lfm2.5-vl-1.6b',
  prompt: 'Compare these images.',
  file:   ['/var/mobile/.../a.jpg', 'https://cdn.example.com/b.jpg', 'cdn:my_index'],
}, {
  stream: (chunk) => el.textContent = chunk,
})
```

### Native file picker

Gated on: native `filepicker=` handler that opens the platform picker, collects user-selected files, and converts them into the equivalent of `file=` before firing inference.

```js
intelligence.run({
  type:       'text',
  model:      'lfm2.5-vl-1.6b',
  prompt:     'What is in this image?',
  filepicker: ['image/*', '.jpg', '.png'],
}, {
  complete: (result) => save(result),
})
```

### Stacking - text to speech per sentence

Gated on: `audio` type enabled in `TYPES` + a TTS model shipped by native.

The pattern works today for any combination of enabled types - fire one call from inside another's `stream` handler, nothing is blocking. Keep this example out of the public README until `audio` ships.

```js
let prev = ''

intelligence.run({
  type:   'text',
  model:  'lfm2.5-1.2b-instruct',
  prompt: 'Tell me three facts about TCP.',
  stream: true,
}, {
  stream: (chunk) => {
    el.textContent = chunk
    const sentence = extractNewSentence(prev, chunk)
    if (sentence) intelligence.run({
      type:     'audio',
      model:    'tts-model',
      prompt:   sentence,
      response: ['speak'],
    })
    prev = chunk
  },
  complete: (result) => save(result),
})
```

### Future model catalogue

Models to advertise in the README once the corresponding `type` flips to `"enabled": true` in `TYPES`.

- **Vision** (`type: 'vision'` or multi-modal `text`) - `lfm2.5-vl-1.6b`, `lfm2-vl-450m`, `qwen3.5-2b`, `qwen3.5-0.8b`, `gemma-4-e2b-it`, `gemma-3n-e2b-it`
- **Transcription** (`type: 'transcription'`) - `parakeet-tdt-0.6b-v3`, `parakeet-ctc-1.1b`, `parakeet-ctc-0.6b`, `whisper-medium`, `whisper-small`, `whisper-base`, `whisper-tiny`, `moonshine-base`
- **Embedding / VAD / Speaker** (`type: 'embed'` and friends) - `qwen3-embedding-0.6b`, `nomic-embed-text-v2-moe`, `silero-vad`, `segmentation-3.0`, `wespeaker-voxceleb-resnet34-lm`

All models ship as `int4` (smaller, faster) or `int8` (higher quality).

#### Transcription model grid (draft for README when `transcription` ships)

| Model                   | Strengths                      | Good use cases                                              |
| ----------------------- | ------------------------------ | ----------------------------------------------------------- |
| `whisper-tiny`          | Fast, real-time                | Live captions, voice commands, push-to-talk                 |
| `moonshine-base`        | Fast, real-time                | Live captions, streaming dictation                          |
| `whisper-base`          | Balanced                       | General dictation, short voice notes                        |
| `whisper-small`         | Higher quality                 | Meetings, longer recordings                                 |
| `whisper-medium`        | High quality                   | Transcribing accented or noisy audio                        |
| `parakeet-ctc-0.6b`     | Streaming-friendly             | Live transcription with partial results                     |
| `parakeet-ctc-1.1b`     | Higher accuracy streaming      | Live transcription where accuracy matters                   |
| `parakeet-tdt-0.6b-v3`  | Highest accuracy               | Offline transcription, archival, closed captioning          |

### Shipping checklist - publishing an idea

- [ ] Native team confirms route/param is live on iOS and Android
- [ ] Spec the result shape (what `complete(result)` receives when files are involved)
- [ ] Move the promoted section from here into **`README.md`**
- [ ] Bump minor version in **`package.json`**
- [ ] If a new `type` is involved, follow [Shipping checklist - new type](#shipping-checklist---new-type) under Package maintenance above

