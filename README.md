# Despia Intelligence

On-device LLM inference for Despia Native apps. Use the JavaScript you already ship in your hybrid app, while Despia runs the model natively on iOS and Android.

[![npm](https://img.shields.io/npm/v/despia-intelligence)](https://www.npmjs.com/package/despia-intelligence)
[![license](https://img.shields.io/npm/l/despia-intelligence)](LICENSE)
[![source](https://img.shields.io/badge/source-GitHub-181717?logo=github)](https://github.com/despia-native/despia-intelligence)

## What You Get

- Private, on-device inference. Prompts and generated text stay on the device.
- Streaming text generation with one JavaScript call.
- Installable local models with progress events.
- Works offline after the model is downloaded.
- Auto-resume for in-flight inference when the app is suspended and reopened while the JS context is still alive.
- No API keys, backend proxy, per-token billing, init step, or build step.

This package currently enables **text inference** (`type: 'text'`). Other route names are reserved internally until the native runtime ships them.

## Requirements

Your app must run inside the Despia Native Runtime. The native runtime must set:

```js
window.native_runtime === 'despia'
```

The SDK reads this once when it is imported. In Despia apps, load/import this package after the runtime flag exists.

Outside Despia, `intelligence.runtime.ok` is `false`. You should show a fallback UI or use a cloud model in that case.

## Install

```bash
npm install despia-intelligence
```

```js
import intelligence from 'despia-intelligence';
```

For a script tag demo, load `index.js` directly:

```html
<script src="./index.js"></script>
<script>
  const intelligence = window.intelligence;
</script>
```

## Quick Start

```js
import intelligence from 'despia-intelligence';

if (!intelligence.runtime.ok) {
  showLocalAiUnavailable(intelligence.runtime.message);
  return;
}

intelligence.run({
  type: 'text',
  model: 'qwen3-0.6b',
  system: 'Answer in three sentences or fewer.',
  prompt: 'How does TCP handle packet loss?',
  stream: true,
}, {
  stream: (chunk) => {
    // chunk is the full accumulated text so far. Replace UI, do not append.
    output.textContent = chunk;
  },
  complete: (text) => {
    saveResult(text);
  },
  error: (err) => {
    console.error(err.code, err.message);
  },
});
```

## Recommended Model Flow

Use installed models for inference. If no model is installed, load the catalogue and let the user download one.

```js
async function ensureTextModel() {
  if (!intelligence.runtime.ok) return null;

  const installed = await intelligence.models.installed();
  if (Array.isArray(installed) && installed.length > 0) {
    return installed[0].id;
  }

  const available = await intelligence.models.available();
  const model = available.find((m) => m.category === 'text') || available[0];
  if (!model) return null;

  await new Promise((resolve, reject) => {
    intelligence.models.download(model.id, {
      onProgress: (percent) => updateDownloadProgress(percent),
      onEnd: resolve,
      onError: reject,
    });
  });

  return model.id;
}
```

If native returns `error.code === 7` or an "invalid/unknown model id" message, the selected model is not installed or the native catalogue is stale. Refresh `models.installed()` and pick an installed model before calling `run()`.

## Runtime Status

```js
intelligence.runtime.ok       // boolean
intelligence.runtime.status   // 'ready' | 'outdated' | 'unavailable'
intelligence.runtime.message  // string | null
```

| Status | Meaning |
| --- | --- |
| `ready` | `window.native_runtime === 'despia'`; Local AI can be used. |
| `outdated` | The user agent looks like Despia, but the runtime flag is missing. Ask the user to update the app. |
| `unavailable` | Not running inside Despia. Use a fallback path. |

Runtime readiness is intentionally strict. The SDK does not check `window.despia` for readiness; it only uses `window.native_runtime === 'despia'`.

## API

### `intelligence.run(params, handler?)`

Starts one inference job.

```ts
type Params = {
  type: 'text'
  model?: string
  prompt?: string
  system?: string
  stream?: boolean
  [key: string]: unknown
}

type Handler = {
  stream?: (chunk: string) => void
  complete?: (text: string) => void
  error?: (err: { code: number; message: string }) => void
}
```

Returns:

```ts
{ ok: true, intent: Params, cancel(): void }
```

When the runtime is not ready, it returns:

```ts
{ ok: false, status: 'outdated' | 'unavailable', message: string | null, intent: null, cancel(): void }
```

`cancel()` removes the job from the SDK routing table. It does not ask native to stop inference; it only prevents more callbacks from reaching your handler.

### `intelligence.models.available()`

Returns the installable model catalogue.

```js
const models = await intelligence.models.available();
```

When ready, the SDK fires `intelligence://models?query=all` and resolves when native calls `window.intelligence.onAvailableModelsLoaded(models)`. If native does not reply within 10 seconds, it resolves to `[]`. Outside Despia, it resolves to `[]`.

### `intelligence.models.installed()`

Returns models currently installed on the device.

```js
const installed = await intelligence.models.installed();
```

When ready, the SDK fires `intelligence://models?query=installed` and resolves when native calls `window.intelligence.onInstalledModelsLoaded(models)`. If native does not reply within 10 seconds, it resolves to `[]`. Outside Despia, it resolves to the not-ready object.

### `intelligence.models.download(modelId, callbacks?)`

Starts a native model download.

```js
intelligence.models.download('qwen3-0.6b', {
  onStart: () => showDownload(),
  onProgress: (percent) => updateBar(percent), // 0-100
  onEnd: () => markInstalled(),
  onError: (message) => showError(message),
});
```

Downloads are owned by native (`NSURLSession` on iOS, `WorkManager` on Android). They can continue while the app is backgrounded. The SDK does not re-fire downloads on foreground.

### `intelligence.models.remove(modelId)`

Removes one installed model.

```js
await intelligence.models.remove('qwen3-0.6b');
```

### `intelligence.models.removeAll()`

Removes all installed models.

```js
await intelligence.models.removeAll();
```

### `intelligence.on(event, fn)`

Global download event listeners. Useful for app-wide state outside the component that started the download.

```js
const off = intelligence.on('downloadProgress', (modelId, percent) => {
  updateGlobalDownloadState(modelId, percent);
});

off();
```

Events:

- `downloadStart(modelId)`
- `downloadProgress(modelId, percent)`
- `downloadEnd(modelId)`
- `downloadError(modelId, message)`

`off(event, fn)` removes a listener. `once(event, fn)` runs once.

## Background And Return

When the user swipes home or switches apps, native inference sessions can be torn down before the OS suspends the WebView. The SDK handles the common suspend case:

1. Native calls `window.focusout` while JS is still alive.
2. The SDK snapshots active inference jobs.
3. The app is suspended.
4. Native calls `window.focusin` when the app returns.
5. The SDK re-runs each interrupted job with the same params and handler.

This creates a new native session and a new internal job id. Your handler stays the same, so your UI continues receiving `stream`, `complete`, and `error` callbacks.

Important limits:

- This only covers suspend/foreground where the JS context stays alive.
- If the OS fully kills the WebView process, JS memory is gone and the SDK cannot know what was running. In that case, restore from your own app state and call `run()` again.
- Jobs that complete, error, or are cancelled do not resume.
- Downloads are different. Native owns the transfer, so the SDK does not snapshot or re-fire downloads.

## Browser Preview And Fallbacks

This package is safe to import in a desktop browser or SSR path, but Local AI will be unavailable:

```js
if (!intelligence.runtime.ok) {
  // Render normal web UI, hide Local AI, or call a cloud fallback.
}
```

Do not hardcode model ids as "available" unless `models.installed()` confirms they are installed on the current device.

## Native Bridge Summary

App developers normally do not need this section, but it helps when debugging native integrations.

The SDK sends commands to native by assigning a URL string:

```js
window.despia = 'intelligence://text?...';
```

Native calls back into JavaScript through functions on `window.intelligence`:

- `onMLToken(id, chunk)`
- `onMLComplete(id, fullText)`
- `onMLError({ jobId, errorCode, errorMessage })`
- `onAvailableModelsLoaded(models)`
- `onInstalledModelsLoaded(models)`
- `onDownloadStart(modelId)`
- `onDownloadProgress(modelId, fraction0to1)`
- `onDownloadEnd(modelId)`
- `onDownloadError(modelId, message)`
- `onRemoveSuccess(modelId)`
- `onRemoveError(modelId, message)`
- `onRemoveAllSuccess()`
- `onRemoveAllError(message)`

The full internal bridge contract lives in [`INTERNALS.md`](INTERNALS.md).

## Testing A Local Build

This repo includes a standalone demo page:

```text
demo.html
```

Load it in a Despia WebView with `index.js` next to it. It exercises runtime detection, available models, installed models, downloads, removals, and streaming inference through the SDK.

Run the Node tests:

```bash
npm test
```

## License

MIT
