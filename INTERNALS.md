# INTERNALS

Internal documentation for maintainers and native integrators. Not published on npm (`package.json` `files`).

## Contents

- [Package maintenance](#package-maintenance)
  - [What this package is](#what-this-package-is)
  - [How the native bridge works](#how-the-native-bridge-works)
  - [Runtime detection](#runtime-detection)
  - [App lifecycle (suspend / resume)](#app-lifecycle-suspend--resume)
  - [TYPES config](#types-config---single-source-of-truth)
  - [Internal state reference](#internal-state-reference)
  - [Rules](#rules---non-negotiable)
  - [Per-release WebView QA](#per-release-webview-qa-native-build)
  - [Shipping checklist - new type](#shipping-checklist---new-type)
- [Raw WebView bridge reference](#raw-webview-bridge-reference)
- [Future ideas (not shipped)](#future-ideas-not-shipped)

---

## Package maintenance

### What this package is

A thin wrapper around the Despia Local Intelligence WebView bridge. It does four things and nothing else:

1. Serialises params to an `intelligence://` URL and assigns it to **`window.despia`** in `_fire`. One assignment per call. No queue, no `iframe`, no `location.href`.
2. Generates and manages job IDs invisibly.
3. Wires native callbacks on **`window.intelligence.*`** at module load and routes them to per-call handlers / event listeners.
4. Auto-resumes every interrupted inference job on app return via `window.focusout` / `window.focusin` (suspend case; JS context alive).

It does not restrict what the native runtime can do. Adding a new scheme route requires zero changes to any function — only the `TYPES` config at the top of `index.js`.

---

### How the native bridge works

**JS → native:** `_fire(url)` does a single `window.despia = url`. Native intercepts the assignment (iOS `decidePolicyFor`, Android `shouldOverrideUrlLoading`).

**Native → JS:** native calls functions on `window.intelligence` directly (e.g. `window.intelligence.onMLToken(id, chunk)`). The SDK assigns those functions **eagerly at module load** — never lazily inside the first `run()` call — so unsolicited pushes (catalogue at app start, etc.) are never dropped.

The UMD wrapper merges the API onto `window.intelligence` instead of overwriting it, so the native callback functions installed during factory execution remain in place after the module finishes loading. Anything that mutates `window.intelligence` directly must do the same.

Full scheme list and callback signatures are in [Raw WebView bridge reference](#raw-webview-bridge-reference).

---

### Runtime detection

```
window.native_runtime = 'despia'   // Despia WebView runtime is active
```

Resolved once at import time. There is no `intelligence_available` flag.

| `native_runtime` | `runtime.status` | `ok` |
|---|---|---|
| `'despia'` | `'ready'` | `true` |
| not set, UA includes `'despia'` | `'outdated'` | `false` |
| not set, UA clean | `'unavailable'` | `false` |

---

### App lifecycle (suspend / resume)

Inference sessions do not survive backgrounding — native tears the inference context down before the OS suspends the WebView. The SDK auto-resumes them on return.

**Mechanism.** Native invokes `window.focusout` / `window.focusin` synchronously from `applicationDidEnterBackground` / `applicationWillEnterForeground` (iOS) and `onPause` / `onResume` (Android), while the JS thread is still alive. We do not use `visibilitychange` — it competes with OS suspension and can be delayed or dropped on real devices.

**On `focusout`:** every entry in `_jobs` is copied into `_pending`, then `_jobs` is cleared. Each entry already carries `{ handler, intent }` from the original `run()` call.

**On `focusin`:** `_pending` is swapped to a local and cleared in a single step (so a `cancel()` landing during the resume loop cannot re-queue itself), then each saved entry is re-fired via `run(intent, handler)`. The new call gets a fresh native session and a new job id; the same handler receives the new tokens.

**Three things remove a job from `_pending`:**

1. `onMLComplete` — already removed from `_jobs` before `focusout` would copy it.
2. `onMLError` — same.
3. `call.cancel()` — explicitly clears both `_jobs[id]` and `_pending[id]`.

**Scope.** This covers the suspend case only (process alive, JS paused). If the OS fully kills the WebView process, JS memory is gone and the SDK has nothing to resume from on relaunch — that case is the consumer app's responsibility. We do not persist `_pending` to storage.

**Downloads are different.** They continue natively via `NSURLSession` / `WorkManager`, so we do not snapshot `_downloads` and we do not re-fire downloads on `focusin`. Re-firing would start a duplicate download. The original session callbacks remain registered and resume firing on return; `onProgress` is not replayed for time spent backgrounded (no source of truth for the percentage between the last real tick and the next one).

---

### TYPES config - single source of truth

Lives at the top of `index.js`. Adding or enabling a route only touches this object.

```js
var TYPES = {
  text:          { route: 'text',       enabled: true,  params: ['model', 'prompt', 'system', 'stream', 'file', 'filepicker'] },
  transcription: { route: 'microphone', enabled: false, params: ['model'] },
  audio:         { route: 'audio',      enabled: false, params: ['model', 'prompt', 'voice', 'response', 'file', 'filepicker'] },
  vision:        { route: 'vision',     enabled: false, params: ['model', 'prompt', 'file', 'filepicker'] },
  embed:         { route: 'embed',      enabled: false, params: ['model', 'input'] },
};
```

| Field | Description |
|---|---|
| `route` | The `intelligence://` route segment |
| `enabled` | `false` = throws a clear error. `true` = live |
| `params` | Informational only — not validated. Any key still passes through |

**To enable a type when native ships it:** flip `enabled` to `true`, update the `type` union in `index.d.ts`, add a usage example to `README.md`, bump minor version.

**Error messages:**

```
[despia-intelligence] Unknown type: "xyz". Supported: text
→ type not in TYPES at all

[despia-intelligence] Type "audio" is not yet supported in this release. Supported: text
→ type in TYPES but enabled is false
```

---

### Internal state reference

| Variable | Type | Purpose |
|---|---|---|
| `_jobs` | `{}` | `jobId → { handler, intent }`. Active inference jobs. Deleted on complete, error, cancel. Cleared on `focusout` (entries copied to `_pending` first). |
| `_pending` | `{}` | `jobId → { handler, intent }`. Jobs interrupted by app background. Populated on `focusout`, drained and re-fired on `focusin`. Also cleared by `cancel()`. |
| `_downloads` | `{}` | `modelId → session callbacks`. Active downloads. Deleted on `onDownloadEnd` / `onDownloadError`. **Not** cleared on `focusout` (downloads keep running natively). |
| `_removes` | `{}` | `modelId → { resolve, reject }`. Pending remove promises. |
| `_removeAll` | `null \| object` | Pending removeAll promise. One at a time. |
| `_availableWaiters` | `[]` | Resolvers waiting for `onAvailableModelsLoaded`. Drained on each callback fire. |
| `_installedWaiters` | `[]` | Resolvers waiting for `onInstalledModelsLoaded`. Drained on each callback fire. |
| `_ev` | `{}` | `event → fn[]`. Internal emitter for `downloadStart` / `downloadProgress` / `downloadEnd` / `downloadError`. |
| `TYPES` | `{}` | Config. Single source of truth for type support. |

---

### Rules - non-negotiable

- No dependencies. No build step. No bundler. No ESM-only exports.
- JS → native is **only** `window.despia = url`. No `iframe`, no `location.href`, no `setTimeout` queue.
- Wire native callbacks on `window.intelligence` **eagerly** at module load. Never lazily inside `run()` / `models.*` (the unsolicited catalogue push at app start is what breaks if you delay).
- The UMD browser-global path **merges** the API into `window.intelligence`. It must not overwrite existing keys (the factory already attached `onML*`, `onDownload*`, etc.).
- Runtime `ready` requires **`window.native_runtime === 'despia'`**. Do not gate on the presence of `window.despia` (it is a setter trap; reading it can return anything or nothing).
- No `console.log` in normal paths. The only allowed log is `console.error('[despia-intelligence] Despia command failed:', e)` when the `window.despia` assignment throws.
- No retry logic — the native layer handles retries.
- No `init()`, `setup()`, or `configure()`.
- Do not add `visibilitychange` / `pagehide` / `beforeunload` listeners. Lifecycle is handled by native-injected `window.focusout` / `window.focusin`.
- Do not collapse `_pending` back to a single slot — the map is load-bearing; concurrent jobs must all resume.
- Do not clear `_downloads` on `focusout`. The download is still in progress natively and callbacks must keep routing if the app returns quickly.
- Do not try to re-fire downloads on `focusin` the way inference jobs are re-fired. NSURLSession / WorkManager own the transfer; re-firing would start a duplicate.
- Do not persist `_pending` to storage to cover the WebView-killed case. The consumer app already has the prompt and UI state to re-call `run()` on relaunch.
- Do not stub future types. They live in `TYPES` with `enabled: false`.

---

### Per-release WebView QA (native build)

Run on a real Despia iOS and Android build that includes Local Intelligence before treating an SDK + native combo as shippable. Node tests do not replace this.

**Environment**

- [ ] `window.native_runtime === 'despia'`
- [ ] `intelligence.runtime.ok === true` and `status === 'ready'` after import
- [ ] After import, `typeof window.intelligence.onMLToken === 'function'` (and `onMLComplete`, `onMLError`, `onDownload*`, `onRemove*`, `onAvailableModelsLoaded`, `onInstalledModelsLoaded`) — eager wiring is present **before** any SDK call

**Inference (`run`, `type: 'text'`)**

- [ ] Single job: tokens stream; `stream` handler receives the **full accumulated text** each time (replace, not append in UI)
- [ ] `complete` fires once with final string; `error` payload is `{ code, message }`
- [ ] Two concurrent jobs with different prompts: each handler only receives its own job’s events (routing by `jobId`)

**Models**

- [ ] `await intelligence.models.available()` matches the native catalogue (ids, names, categories)
- [ ] `await intelligence.models.installed()` resolves after `onInstalledModelsLoaded`; empty array is valid
- [ ] Download: `onStart` / `onProgress` (0-100) / `onEnd` or `onError`
- [ ] `remove` / `removeAll`: promise resolves; `installedModels` updates after a fresh `installed()`

**Lifecycle**

- [ ] Home button mid-generation: on return, interrupted jobs **resume** without app code re-calling `run` for those intents
- [ ] Multiple concurrent jobs: all resume after a single suspend/foreground cycle
- [ ] `call.cancel()` called while in BG: that job does not resume on return

**Release hygiene**

- [ ] Bump `package.json` version; tag Git with version and date in the message or GitHub Release notes; `npm publish` after `npm test`

---

### Shipping checklist - new type

- [ ] Native team confirms route name and callback shape
- [ ] Entry exists in `TYPES` with `enabled: false`
- [ ] `enabled` flipped to `true`
- [ ] `params` array updated
- [ ] `index.d.ts` — `type` union updated
- [ ] `README.md` — usage example added
- [ ] `package.json` — minor version bumped
- [ ] Tested against a Despia build with the native route active

---

## Raw WebView bridge reference

This section describes the native WebView bridge as a direct contract: scheme URLs fired from JavaScript, and callbacks invoked in the JS context. It is the conceptual source of truth that [`despia-intelligence`](https://www.npmjs.com/package/despia-intelligence) is built on.

### How the bridge works

Despia runs the web app inside a native WebView shell. The bridge is bidirectional.

**JS → native:** assign the scheme URL string to `window.despia`. Despia routes it as an intercepted navigation **without** assigning `window.location.href`, which avoids SPA router clashes and keeps bridge traffic easy to log or breakpoint.

- iOS: `WebViewController.swift` → `decidePolicyFor navigationAction`
- Android: `MainActivity.java` → `shouldOverrideUrlLoading`

**Native → JS:** callbacks are invoked on `window.intelligence` directly. Streaming inference calls `onMLToken` / `onMLComplete` / `onMLError`. Model lifecycle calls `onDownload*` / `onRemove*`. The catalogue is delivered via `onAvailableModelsLoaded` / `onInstalledModelsLoaded`.

### Scheme 1 - Streaming inference (`intelligence://text`)

iOS and Android. Used by `intelligence.run({ type: 'text', ... })`.

Raw fire (without the SDK):

```js
const jobId = crypto.randomUUID()

window.intelligence = window.intelligence || {}
window.intelligence.onMLToken    = (id, chunk)   => { /* chunk is FULL accumulated text */ }
window.intelligence.onMLComplete = (id, fullText) => { /* once */ }
window.intelligence.onMLError    = (err)         => { /* { jobId, errorCode, errorMessage } */ }

window.despia =
  'intelligence://text?' +
  'id=' + encodeURIComponent(jobId) +
  '&model=' + encodeURIComponent('qwen3-0.6b') +
  '&system=' + encodeURIComponent('Reply in three sentences or fewer.') +
  '&prompt=' + encodeURIComponent('What is the difference between TCP and UDP?') +
  '&stream=' + encodeURIComponent('true')
```

**Parameters (text route)**

| Key | Type | Required | Description |
|---|---|---|---|
| `id` | string | Yes | Job id; echoed on every callback |
| `prompt` | string | Yes | User prompt |
| `system` | string | No | System / instruction context |
| `model` | string | No | Model id, e.g. `qwen3-0.6b` |
| `stream` | string/boolean | No | Pass `'true'` to stream |

**Callbacks**

- `onMLToken(id, chunk)` — `chunk` is the **full accumulated text so far**, not a delta. Replace UI; do not append.
- `onMLComplete(id, fullText)` — once when inference finishes. `fullText` matches the final `chunk`.
- `onMLError({ jobId, errorCode, errorMessage })` — `jobId` is present so callers can route errors when multiple jobs run.

**Error codes (text route)**

| Code | Description |
|---|---|
| `2` | Missing `id` |
| `3` | Runtime inference error — see `errorMessage` |
| `7` | Model not installed (`invalid model id` / `unknown model id`) |

### Scheme 2 - Model management

```js
window.intelligence = window.intelligence || {}
```

**Available models** — fire `intelligence://models?query=all`. Native delivers via `window.intelligence.onAvailableModelsLoaded(models)` (no variable write). The SDK mirrors the payload onto `window.intelligence.availableModels` for any consumer that prefers reading the snapshot.

**Installed models** — fire `intelligence://models?query=installed`. Native both writes `window.intelligence.installedModels` and calls `window.intelligence.onInstalledModelsLoaded(models)`. The SDK resolves the promise on the callback and mirrors the payload onto `installedModels`.

**Download** — `intelligence://download?model=<id>`. Native calls `onDownloadStart(modelId)` → `onDownloadProgress(modelId, fraction0to1)` → `onDownloadEnd(modelId)` (or `onDownloadError(modelId, errString)`). The SDK normalises progress to 0-100 before invoking the per-call `onProgress` callback. Downloads continue natively via NSURLSession (iOS) and WorkManager (Android).

**Remove** — `intelligence://remove?model=<id>` and `intelligence://remove?model=all`. Native calls `onRemoveSuccess(modelId)` / `onRemoveError(modelId, err)` for single-model removals, and `onRemoveAllSuccess()` / `onRemoveAllError(err)` for the all variant.

### Scheme and callback tables

#### JS → native (scheme URLs)

| URL | Action |
|---|---|
| `intelligence://text?id=<uuid>&...` | Streaming text inference |
| `intelligence://models?query=all` | Refresh available models; native calls `onAvailableModelsLoaded(models)` |
| `intelligence://models?query=installed` | Refresh installed list; native writes `installedModels` and calls `onInstalledModelsLoaded(models)` |
| `intelligence://download?model=<id>` | Download a model |
| `intelligence://remove?model=<id>` | Remove one model |
| `intelligence://remove?model=all` | Remove all models |

#### Native → JS

| Mechanism | Arguments / shape | When |
|---|---|---|
| `window.intelligence.onMLToken(id, chunk)` | `chunk` = full text so far | Streaming token snapshot |
| `window.intelligence.onMLComplete(id, fullText)` | | Streaming complete |
| `window.intelligence.onMLError({ jobId, errorCode, errorMessage })` | | Streaming / job error |
| `window.intelligence.onAvailableModelsLoaded(models)` | `Model[]` | Sole delivery for `query=all` |
| `window.intelligence.availableModels` | `Model[]` | Mirror written by the SDK after `onAvailableModelsLoaded` |
| `window.intelligence.onInstalledModelsLoaded(models)` | `Model[]` | Fired for `query=installed` |
| `window.intelligence.installedModels` | `Model[]` | Mirror written by native and by the SDK |
| `window.intelligence.onDownloadStart(modelId)` | | Download started |
| `window.intelligence.onDownloadProgress(modelId, fraction)` | `fraction` is 0-1 float | Progress tick |
| `window.intelligence.onDownloadEnd(modelId)` | | Download finished |
| `window.intelligence.onDownloadError(modelId, err)` | `err: string` | Download failed |
| `window.intelligence.onRemoveSuccess(modelId)` | | Remove succeeded |
| `window.intelligence.onRemoveError(modelId, err)` | | Remove failed |
| `window.intelligence.onRemoveAllSuccess()` | | Remove all succeeded |
| `window.intelligence.onRemoveAllError(err)` | | Remove all failed |

---

### How `despia-intelligence` maps to this

| npm API | Raw bridge equivalent |
|---|---|
| `intelligence.run({ type: 'text', ... }, handler)` | Builds URL, fires `window.despia = url`, routes `onMLToken` / `onMLComplete` / `onMLError` by `jobId` to `handler` |
| `intelligence.models.available()` | Fires `intelligence://models?query=all`, resolves on `onAvailableModelsLoaded` |
| `intelligence.models.installed()` | Fires `intelligence://models?query=installed`, resolves on `onInstalledModelsLoaded` |
| `intelligence.models.download(id, callbacks)` | Fires `intelligence://download?model=<id>`, fans `onDownload*` to `callbacks` and to `intelligence.on('download*')` |
| `intelligence.models.remove(id)` | Fires `intelligence://remove?model=<id>`, resolves on `onRemoveSuccess` / rejects on `onRemoveError` |
| `intelligence.models.removeAll()` | Fires `intelligence://remove?model=all`, resolves on `onRemoveAllSuccess` / rejects on `onRemoveAllError` |

The package adds: stable `encodeURIComponent` query building (no `+` for spaces), UUID generation, per-job handler tables, `try`/`catch` around user handlers, and normalised download progress (0-100). Nothing else.

### Confirm with native before relying on edge behaviour

The bridge contract evolves with the runtime. Verify on real builds when changing native code:

- Exact shape and timing of `onMLError` and whether `jobId` is always present
- Replay of download completion callbacks when the app was backgrounded mid-download
- Any future routes (`intelligence://vision`, `microphone`, etc.) behind feature flags

Keep this document in sync with native when the contract changes.

---

## Future ideas (not shipped)

Internal parking lot for features that are spec'd but not yet shipped by the native runtime. Not published on npm; not referenced from the public README. Move a section into `README.md` only after the native team confirms the route is live.

The package already passes `file` and `filepicker` through unchanged. These ideas are about **publishing** usage examples, not about any code changes in `index.js`.

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

```js
let prev = ''
intelligence.run({
  type: 'text', model: 'lfm2.5-1.2b-instruct', prompt: 'Tell me three facts about TCP.', stream: true,
}, {
  stream: (chunk) => {
    el.textContent = chunk
    const sentence = extractNewSentence(prev, chunk)
    if (sentence) intelligence.run({ type: 'audio', model: 'tts-model', prompt: sentence, response: ['speak'] })
    prev = chunk
  },
})
```

### Future model catalogue

Models to advertise in the README once the corresponding `type` flips to `enabled: true` in `TYPES`.

- **Vision** — `lfm2.5-vl-1.6b`, `lfm2-vl-450m`, `qwen3.5-2b`, `qwen3.5-0.8b`, `gemma-4-e2b-it`, `gemma-3n-e2b-it`
- **Transcription** — `parakeet-tdt-0.6b-v3`, `parakeet-ctc-1.1b`, `parakeet-ctc-0.6b`, `whisper-medium`, `whisper-small`, `whisper-base`, `whisper-tiny`, `moonshine-base`
- **Embedding / VAD / Speaker** — `qwen3-embedding-0.6b`, `nomic-embed-text-v2-moe`, `silero-vad`, `segmentation-3.0`, `wespeaker-voxceleb-resnet34-lm`

All models ship as `int4` (smaller, faster) or `int8` (higher quality).

### Shipping checklist - publishing an idea

- [ ] Native team confirms route/param is live on iOS and Android
- [ ] Spec the result shape (what `complete(result)` receives when files are involved)
- [ ] Move the promoted section from here into `README.md`
- [ ] Bump minor version in `package.json`
- [ ] If a new `type` is involved, follow [Shipping checklist - new type](#shipping-checklist---new-type) under Package maintenance above
