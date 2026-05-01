# Despia Intelligence

JavaScript SDK for Local AI in Despia Native apps. Keep your UI in React, Vue, Svelte, or plain JavaScript while Despia runs inference, model storage, downloads, and hardware acceleration natively on iOS and Android.

[![npm](https://img.shields.io/npm/v/despia-intelligence)](https://www.npmjs.com/package/despia-intelligence)
[![license](https://img.shields.io/npm/l/despia-intelligence)](LICENSE)
[![source](https://img.shields.io/badge/source-GitHub-181717?logo=github)](https://github.com/despia-native/despia-intelligence)

## Highlights

- **Private by default**: prompts and generated text stay on the device.
- **No backend required**: no API keys, proxy server, CORS setup, or token billing.
- **Offline after download**: installed models keep working without network.
- **Streaming responses**: render output as it is generated.
- **Native model downloads**: progress events in JavaScript, download work handled by iOS/Android.
- **Soft-close resume**: if the user leaves the app and returns while the WebView is still alive, active inference jobs restart automatically.

Current public support is **text inference** through `type: 'text'`.

## Installation

```bash
npm install despia-intelligence
```

```js
import intelligence from 'despia-intelligence';
```

## Runtime Check

Always gate Local AI with `intelligence.runtime.ok`.

```js
if (!intelligence.runtime.ok) {
  showLocalAiUnavailable(intelligence.runtime.message);
  return;
}
```

Runtime status:

```js
intelligence.runtime.ok       // boolean
intelligence.runtime.status   // 'ready' | 'outdated' | 'unavailable'
intelligence.runtime.message  // string | null
```

| Status | Meaning |
| --- | --- |
| `ready` | Local AI is available in the current Despia runtime. |
| `outdated` | The app should be updated before Local AI can be used. |
| `unavailable` | The code is not running in a Local AI-capable Despia runtime. |

Outside Despia, the package is safe to import. `runtime.ok` will be `false`, so you can render a normal web fallback or call your cloud model.

## Quick Start

```js
import intelligence from 'despia-intelligence';

if (!intelligence.runtime.ok) {
  renderWithoutLocalAi();
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
    // chunk is the full accumulated answer so far.
    // Replace UI content; do not append chunks together.
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

Models are device-local. Before inference, check what is installed on the current device. If nothing is installed, load the available catalogue and download a model.

The SDK only requires a model `id`. Other model fields are native-provided metadata and should be treated as optional.

```js
async function getModelForInference() {
  if (!intelligence.runtime.ok) return null;

  const installed = await intelligence.models.installed();
  if (Array.isArray(installed) && installed.length > 0) {
    return installed[0].id;
  }

  const available = await intelligence.models.available();
  const model = available[0];
  if (!model) return null;

  await new Promise((resolve, reject) => {
    intelligence.models.download(model.id, {
      onStart: () => showDownloadUI(model),
      onProgress: (percent) => updateDownloadProgress(percent),
      onEnd: resolve,
      onError: reject,
    });
  });

  return model.id;
}

const model = await getModelForInference();

if (model) {
  intelligence.run({
    type: 'text',
    model,
    prompt: 'Summarize this note.',
  }, handler);
}
```

If inference reports an invalid or unknown model id, refresh `models.installed()` and choose a model from that installed list before calling `run()` again.

## Text Inference

### `intelligence.run(params, handler?)`

Starts one native inference job.

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

Returns a handle:

```ts
{
  ok: true
  intent: Params
  cancel(): void
}
```

When the runtime is not ready, it returns:

```ts
{
  ok: false
  status: 'outdated' | 'unavailable'
  message: string | null
  intent: null
  cancel(): void
}
```

Handler behavior:

- `stream(chunk)` receives the full accumulated response so far.
- `complete(text)` fires once with the final response.
- `error(err)` receives a compact `{ code, message }` object.
- `cancel()` removes the job from SDK routing so future callbacks no longer reach your handler. It does not cancel native inference.

## Models

### `intelligence.models.available()`

Loads the installable model catalogue.

```js
const models = await intelligence.models.available();
```

Returns `Model[]`. If the runtime is unavailable or native does not reply within 10 seconds, it resolves to `[]`.

### `intelligence.models.installed()`

Loads models installed on this device.

```js
const installed = await intelligence.models.installed();
```

When ready, resolves to `Model[]`. If native does not reply within 10 seconds, it resolves to `[]`. When the runtime is unavailable, it resolves to the not-ready object.

### `Model`

The SDK only requires `id`.

```ts
type Model = {
  id: string
  name?: string
  [key: string]: unknown
}
```

Native may include additional metadata. Treat it as optional.

### `intelligence.models.download(modelId, callbacks?)`

Starts a model download.

```js
intelligence.models.download('qwen3-0.6b', {
  onStart: () => showDownloadUI(),
  onProgress: (percent) => updateBar(percent), // integer 0-100
  onEnd: () => markInstalled(),
  onError: (message) => showError(message),
});
```

Downloads are handled by the native app. They can continue while your app is backgrounded. The SDK does not restart downloads on foreground because that would create duplicate transfers.

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

## Download Events

Use per-download callbacks for local UI and global listeners for app-wide state.

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

`off(event, fn)` removes a listener. `once(event, fn)` runs a listener once.

## Soft-Close Resume

Soft close means the user swipes home, switches apps, and later returns while the WebView process is still alive. In that case, JavaScript memory survives, but the native inference session may have been torn down.

The SDK handles this case automatically. Active inference jobs are snapshotted before suspension and started again when the app returns, using the same params and the same handler.

Important details:

- Resume starts a **fresh native inference session**. It does not continue from the exact token where the old session stopped.
- Your original handler is reused, so your UI keeps receiving `stream`, `complete`, and `error` callbacks.
- The restarted job gets a new internal job id; the SDK handles routing.
- Jobs that completed, errored, or were cancelled do not resume.
- If the OS fully kills the WebView process, JavaScript memory is gone and the SDK cannot resume. Restore from your own app state and call `run()` again.
- Downloads are separate. Native owns downloads, so the SDK does not restart them.

## Browser Preview And Fallbacks

You can import the package in SSR, desktop browser previews, or non-Despia environments. Local AI will simply be unavailable.

```js
if (!intelligence.runtime.ok) {
  renderFallbackExperience();
}
```

## Demo And Tests

This repo includes `demo.html`, a standalone page for testing the SDK inside a Despia WebView.

Run tests:

```bash
npm test
```

## License

MIT
