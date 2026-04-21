# Despia Local Intelligence — Raw Bridge API

**Internal reference.** This document describes the native WebView bridge as a direct contract: scheme URLs fired from JavaScript and callbacks invoked on `window`. It is the conceptual source of truth that [`despia-intelligence`](https://www.npmjs.com/package/despia-intelligence) (the npm package) is built on.

Every public behaviour of the npm package maps to something here. The package does not add capabilities the bridge does not expose; it adds routing, encoding, lifecycle glue, and safety. If you are forking the package, porting to another language, or collaborating on native changes, start here and confirm details with the iOS/Android teams.

---

## How the bridge works

Despia runs your web app inside a native WebView shell. The bridge is bidirectional.

**JS → native:** assign a URL to `window.location.href`. The native runtime intercepts the navigation before it completes.

- **iOS:** `WebViewController.swift` → `decidePolicyFor navigationAction`
- **Android:** `MainActivity.java` → `shouldOverrideUrlLoading`

**Native → JS:** the native layer invokes **handlers you registered** on `window.intelligence` via registrar calls such as `window.intelligence.onMLToken(handler)` (not by assigning `window.onMLToken = …`). Lifecycle hooks `window.focusout` / `window.focusin` remain direct `window` assignments from native. There is no variable injection and no promise-based handoff from native for inference tokens.

Examples below sometimes use `despia(url)` from the [`despia-native`](https://www.npmjs.com/package/despia-native) package; that helper ultimately sets `window.location.href`. You can set `window.location.href` directly.

---

## Runtime detection

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

## Scheme 1 — One-shot inference (`appleintelligence://`)

**iOS only (documented contract).** Fires via `appleintelligence://`. Runs the prompt to completion and invokes a named global function with the full response string. No streaming and no job ID.

### Fire the call

```js
window.location.href =
  'appleintelligence://?prompt=' + encodeURIComponent('What is the capital of France?')
```

### Parameters

| Key | Type | Required | Description |
| --- | --- | --- | --- |
| `prompt` | string | Yes | User prompt |
| `instructions` | string | No | System-style instruction context |
| `callback` | string | No | Name of a global function on `window` to receive the result. Defaults to `handleAIResponse` |

### Callback

Native calls `window[callback](response)` on success. On failure, the same callback may receive an error message string (there is no separate error callback in this scheme).

```js
function handleAIResponse(response) {
  document.getElementById('output').textContent = response
}

window.location.href =
  'appleintelligence://?prompt=' + encodeURIComponent('Explain TCP in one sentence.')
```

Custom callback and instructions:

```js
function myCallback(response) {
  console.log(response)
}

window.location.href =
  'appleintelligence://?' +
  'instructions=' + encodeURIComponent('Reply in one sentence.') +
  '&prompt=' + encodeURIComponent('What is TCP?') +
  '&callback=myCallback'
```

### Flow

```
appleintelligence://?prompt=...&callback=handleAIResponse
  → native intercepts scheme
  → native runs one-shot completion
  → window.handleAIResponse(response)   // success
  → window.handleAIResponse(message)    // failure (string)
```

---

## Scheme 2 — Streaming inference (`intelligence://text`)

**iOS and Android.** Text streaming uses the **`intelligence://`** host with a **`text`** path segment and a query string. The npm package always uses this route for `type: 'text'` (see `TYPES.text.route` in `index.js`).

### Set up callbacks before firing

Register handlers **once** per page lifetime by **calling** the native registrar functions on `window.intelligence`. Native invokes the registered handler per event; use `jobId` to correlate concurrent streams.

```js
const jobId = crypto.randomUUID()

window.intelligence.onMLToken((id, chunk) => {
  if (id !== jobId) return
  // chunk is the FULL accumulated response so far — replace UI, do not append
  document.getElementById('output').textContent = chunk
})

window.intelligence.onMLComplete((id, fullText) => {
  if (id !== jobId) return
  console.log('Complete:', fullText)
})

window.intelligence.onMLError((err) => {
  console.error(err.jobId, err.errorCode, err.errorMessage)
})
```

### Fire the call

Use **`intelligence://text`** plus `encodeURIComponent` for every query value (the npm package does this for all keys so `+` is never used for spaces).

```js
window.location.href =
  'intelligence://text?' +
  'id=' + encodeURIComponent(jobId) +
  '&prompt=' + encodeURIComponent('What is the capital of France?')
```

With system prompt and model:

```js
window.location.href =
  'intelligence://text?' +
  'id=' + encodeURIComponent(jobId) +
  '&model=' + encodeURIComponent('qwen3-0.6b') +
  '&system=' + encodeURIComponent('Reply in three sentences or fewer.') +
  '&prompt=' + encodeURIComponent('What is the difference between TCP and UDP?') +
  '&stream=' + encodeURIComponent('true')
```

### Parameters (text route)

| Key | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | string | Yes | Job id; echoed on every callback |
| `prompt` | string | Yes | User prompt |
| `system` | string | No | System / instruction context |
| `model` | string | No | Model id, e.g. `qwen3-0.6b` |
| `stream` | string/boolean | No | Passed through when set (`'true'` in examples) |
| `webhook` | string | No | Reserved; parsed by native, not active in public docs |

Additional keys supported by native may be forwarded as query params; the npm package forwards arbitrary keys on the params object except `type`.

### Callbacks (registrar API)

After you call `window.intelligence.onMLToken(fn)` (and the other registrars), native delivers events by invoking those handlers.

**`onMLToken(jobId, chunk)`**  
**`chunk`** is the full accumulated text so far, not a delta. Replace the target element’s text; do not append.

**`onMLComplete(jobId, fullText)`**  
Called once when inference finishes. `fullText` matches the final `chunk` from `onMLToken`.

**`onMLError({ jobId, errorCode, errorMessage })`**

### Error codes (streaming / text route)

| Code | Description |
| --- | --- |
| `1` | `appleintelligence://` — missing `prompt` (per legacy one-shot docs) |
| `2` | `intelligence://` text route — missing `id` |
| `3` | Runtime inference error — see `errorMessage` |

### Flow

```
intelligence://text?id=abc&prompt=...
  → native intercepts scheme
  → streaming session for job abc
  → registered onMLToken handler('abc', accumulatedText)   // repeats
  → registered onMLComplete handler('abc', fullText)       // once
  → registered onMLError handler({ jobId, errorCode, errorMessage }) // on failure
```

### Multiple concurrent jobs

Use a unique `id` per job and branch inside your registered handlers (or maintain a map). The npm package keeps an internal job table so each `intelligence.run()` handler only receives its own events.

---

## Scheme 3 — Model management

The WebView injects **`window.intelligence.availableModels`** and **`window.intelligence.installedModels`** as arrays (read synchronously; native updates them after install/remove). Downloads and removes still use **`intelligence://`** URLs **without** a text job `id`. Event delivery uses the same **registrar** pattern as inference.

```js
window.intelligence = window.intelligence || {}
```

### Available models (no scheme)

```js
// Injected on boot — no round-trip
const models = window.intelligence.availableModels || []
```

The npm package’s `models.available()` resolves to this array (or `[]` when not in the Despia WebView).

### Installed models (scheme refresh + variable update)

Fire **`intelligence://models?query=installed`**. The WebView then **writes `window.intelligence.installedModels` directly** (same idea as `despia-native` watching `window[variableName]` after a scheme). The npm package does **not** depend on `onInstalledModelsLoaded`; it pre-clears the array, fires the scheme, and **polls** until `installedModels` becomes a “ready” non-empty snapshot or the value’s signature changes — then resolves (or resolves `[]` after a timeout so the promise never hangs).

```js
window.location.href = 'intelligence://models?query=installed'
// … later, WebView assigns e.g.:
// window.intelligence.installedModels = [{ id: 'qwen3_0_6b', name: 'Qwen3 0.6b', category: 'text' }, ...]
```

You can still read **`window.intelligence.installedModels`** synchronously when you only need the last snapshot the WebView wrote.

### Download a model

```js
window.location.href =
  'intelligence://download?model=' + encodeURIComponent('qwen3_0_6b')
```

Downloads continue in the background via **NSURLSession** (iOS) and **WorkManager** (Android). Retry behaviour is owned by native code.

**Registrars:**

```js
window.intelligence.onDownloadStart((modelId) => {})
window.intelligence.onDownloadProgress((modelId, pct) => {
  // Native sends pct as a 0–1 float; npm normalises to 0–100 for session callbacks.
})
window.intelligence.onDownloadEnd((modelId) => {})
window.intelligence.onDownloadError((modelId, err) => {
  // err is a string message
})
```

### Remove models

```js
window.location.href =
  'intelligence://remove?model=' + encodeURIComponent('qwen3_0_6b')

window.location.href = 'intelligence://remove?model=all'
```

**Registrars:**

```js
window.intelligence.onRemoveSuccess((modelId) => {})
window.intelligence.onRemoveError((modelId, err) => {})
window.intelligence.onRemoveAllSuccess(() => {})
window.intelligence.onRemoveAllError((err) => {})
```

---

## Native app lifecycle (`window.focusout` / `window.focusin`)

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

## Complete raw example (no npm package)

Minimal HTML page showing the same primitives the npm layer uses: runtime gate, registrar callbacks on `window.intelligence`, `intelligence://text` URL, injected model arrays, and optional scheme refresh for installed models. Adjust CDN URLs and error handling for production.

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
        window.location.href = 'intelligence://models?query=installed'
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
          window.intelligence.onDownloadProgress(function (id, pct) {
            var p = typeof pct === 'number' && pct <= 1 ? Math.round(pct * 100) : Math.round(pct)
            document.getElementById('output').textContent = 'Downloading: ' + p + '%'
          })
          window.intelligence.onDownloadEnd(function () {
            runInference()
          })
          window.location.href = 'intelligence://download?model=qwen3_0_6b'
        }

        function runInference() {
          var jobId = crypto.randomUUID()

          window.intelligence.onMLToken(function (id, chunk) {
            if (id === jobId) document.getElementById('output').textContent = chunk
          })
          window.intelligence.onMLComplete(function (id, fullText) {
            if (id === jobId) console.log('done', fullText)
          })
          window.intelligence.onMLError(function (err) {
            console.error(err && err.errorCode, err && err.errorMessage)
          })

          window.location.href =
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

## Scheme and callback tables

### JS → native (scheme URLs)

| URL | Action |
| --- | --- |
| `appleintelligence://?prompt=<text>` | One-shot inference (iOS only) |
| `appleintelligence://?prompt=<text>&instructions=<text>&callback=<fn>` | One-shot with instructions + custom callback name |
| `intelligence://text?id=<uuid>&...` | Streaming text inference (preferred; used by npm) |
| _(injected)_ `window.intelligence.availableModels` | Supported models snapshot (no scheme required for read) |
| `intelligence://models?query=all` | Optional native scheme (may still exist for tooling) |
| `intelligence://models?query=installed` | Refresh installed list; WebView updates `window.intelligence.installedModels` |
| `intelligence://download?model=<id>` | Download a model |
| `intelligence://remove?model=<id>` | Remove one model |
| `intelligence://remove?model=all` | Remove all models |

Older examples may show `intelligence://?id=...` without the `text` segment; the npm package and current native integration use **`intelligence://text`**.

### Native → JS

| Mechanism | Arguments / shape | When |
| --- | --- | --- |
| `window[callback](response)` | `response: string` | One-shot (`appleintelligence://`) success or error string |
| `window.intelligence.onMLToken(fn)` then native calls `fn(jobId, chunk)` | `chunk` = full text so far | Streaming token snapshot |
| `window.intelligence.onMLComplete(fn)` then native calls `fn(jobId, fullText)` | | Streaming complete |
| `window.intelligence.onMLError(fn)` then native calls `fn({ jobId, errorCode, errorMessage })` | | Streaming / job error |
| `window.intelligence.availableModels` | `Model[]` | Injected / updated by WebView |
| `window.intelligence.installedModels` | `Model[]` | Injected / updated by WebView |
| `window.intelligence.installedModels` | `Model[]` | Updated by WebView after `query=installed` (and install/remove); npm polls this |
| `window.intelligence.onDownloadStart(fn)` → `fn(modelId)` | | Download started |
| `window.intelligence.onDownloadProgress(fn)` → `fn(modelId, pct)` | `pct` usually 0–1 float | Progress tick |
| `window.intelligence.onDownloadEnd(fn)` → `fn(modelId)` | | Download finished |
| `window.intelligence.onDownloadError(fn)` → `fn(modelId, err)` | `err: string` | Download failed |
| `window.intelligence.onRemoveSuccess(fn)` → `fn(modelId)` | | Remove succeeded |
| `window.intelligence.onRemoveError(fn)` → `fn(modelId, err)` | | Remove failed |
| `window.intelligence.onRemoveAllSuccess(fn)` → `fn()` | | Remove all succeeded |
| `window.intelligence.onRemoveAllError(fn)` → `fn(err)` | | Remove all failed |
| `window.focusout()` | — | App backgrounding (direct `window` hook) |
| `window.focusin()` | — | App foregrounding (direct `window` hook) |

---

## How `despia-intelligence` maps to this

| npm API | Raw bridge equivalent |
| --- | --- |
| `intelligence.run({ type: 'text', ... }, handler)` | `window.location.href = 'intelligence://text?id=<uuid>&...'` plus registrars `onMLToken` / `onMLComplete` / `onMLError` on `window.intelligence`, routed by job id inside the SDK |
| `intelligence.models.available()` | Reads `window.intelligence.availableModels` synchronously (no scheme) |
| `intelligence.models.installed()` | Pre-clears `installedModels`, `_observe` polls until it changes, `_fire` `query=installed`; resolves `[]` on timeout |
| `intelligence.models.download(id, callbacks)` | `intelligence://download?model=<id>` + download callbacks / global events |
| `intelligence.models.remove(id)` | `intelligence://remove?model=<id>` + remove callbacks |
| `intelligence.models.removeAll()` | `intelligence://remove?model=all` + remove-all callbacks |
| `intelligence.on('downloadEnd', fn)` etc. | Same native events as `onDownloadEnd`; the package fans out through an internal listener list |
| Auto-resume after background | Package-owned `window.focusout` / `window.focusin` that re-assign `location.href` for interrupted jobs and restore download callback maps |

The package adds: stable **`encodeURIComponent`** query building (no `+` for spaces), UUID generation, per-job handler tables, **`try`/`catch` around user handlers**, `focusout`/`focusin` orchestration, and normalised download progress (0–100). `_boot()` registers SDK-internal handlers exclusively via **`window.intelligence.on*(fn)`** — no `window.onMLToken = …` assignments.

---

## Confirm with native before relying on edge behaviour

The bridge contract evolves with the runtime. The following are used in this repository’s JS and tests but should be **verified on real builds** when changing native code:

- Exact shape and timing of `onMLError` and whether `jobId` is always present
- Replay of download completion callbacks when a download finishes while the app is backgrounded
- Any future routes (`intelligence://vision`, `microphone`, etc.) behind feature flags

When native behaviour is confirmed, update this file and **MAINTENANCE.md** together so internal and package docs stay aligned.
