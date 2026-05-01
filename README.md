# Despia Intelligence

JavaScript SDK for Local AI in Despia Native apps. Use the same web code you already ship, while Despia handles model downloads, on-device inference, and native acceleration on iOS and Android.

[![npm](https://img.shields.io/npm/v/despia-intelligence)](https://www.npmjs.com/package/despia-intelligence)
[![license](https://img.shields.io/npm/l/despia-intelligence)](LICENSE)
[![source](https://img.shields.io/badge/source-GitHub-181717?logo=github)](https://github.com/despia-native/despia-intelligence)

> **Beta / experimental:** This SDK is currently experimental. APIs and behavior may change before the stable public release. The final stable version will ship with Despia V4.

## Capabilities

- Run text generation on-device from JavaScript.
- Stream the full accumulated response into your UI.
- List available and installed local models.
- Download and remove models with progress callbacks.
- Resume the active inference job after a soft app close.
- Safely import in browser previews and SSR paths.

Current public support is `type: 'text'`.

## Install

```bash
npm install despia-intelligence
```

```js
import intelligence from 'despia-intelligence';
```

## Core Principle

`despia-intelligence` is the public JavaScript API for Despia Local AI. App code should treat it like a normal SDK: import it, check availability, load models, start one generation, and render the callback results.

The mental model is:

```txt
your app -> intelligence.run(...) -> Despia Local AI -> handler.stream(...)
```

The SDK owns the Despia integration details. Application code should not create a second Local AI integration or manually wire callback plumbing. Doing that is the most common cause of model lists not resolving or streaming callbacks disappearing in React apps.

Correct integration:

```js
const call = intelligence.run({
  type: 'text',
  model: 'qwen3-0.6b',
  prompt: 'Write a short welcome message.',
}, {
  stream: (chunk) => {
    // chunk is a string with the full response so far.
    // Example: "Hello" then "Hello there" then "Hello there!"
    // Use the value directly; replace your displayed text with chunk.
  },
  complete: (text) => {
    // text is the final response string.
    // Example: "Hello there!"
  },
  error: (error) => {
    // error is an object: { code: number, message: string }
    // Access the message with error.message.
  },
});
```

Keep app code at this level. The only supported surface is the exported `intelligence` object and its methods.

## Check Availability

Local AI is only available inside a Despia app with Local AI support. Always gate feature entry points with `intelligence.runtime.ok`.

```js
if (!intelligence.runtime.ok) {
  // Local AI is not available in this environment.
  return;
}
```

```js
intelligence.runtime.ok       // boolean
intelligence.runtime.status   // 'ready' | 'outdated' | 'unavailable'
intelligence.runtime.message  // string | null
```

| Status | Meaning |
| --- | --- |
| `ready` | Local AI is available. |
| `outdated` | The app should be updated before Local AI can be used. |
| `unavailable` | Local AI is not available in the current environment. |

The package is safe to import outside Despia. In that case, `runtime.ok` is `false` and model/inference APIs return not-ready values instead of throwing.

## First Inference

```js
import intelligence from 'despia-intelligence';

if (!intelligence.runtime.ok) {
  // Local AI is not available in this environment.
  return;
}

const call = intelligence.run({
  type: 'text',
  model: 'qwen3-0.6b',
  system: 'Answer in three sentences or fewer.',
  prompt: 'How does TCP handle packet loss?',
  stream: true,
}, {
  stream: (chunk) => {
    // chunk is a string with the full accumulated response so far.
    // Example chunks: "TCP", "TCP handles", "TCP handles packet loss..."
    // Replace rendered text with chunk; do not append chunks together.
  },
  complete: (text) => {
    // text is the final response string.
    // Example: "TCP handles packet loss by retransmitting missing data..."
  },
  error: (error) => {
    // error is an object: { code: number, message: string }
    // Access the message with error.message.
  },
});

if (!call.ok) {
  // Show call.message in your UI.
}
```

Example `run()` params:

```json
{
  "type": "text",
  "model": "qwen3-0.6b",
  "system": "Answer in three sentences or fewer.",
  "prompt": "How does TCP handle packet loss?",
  "stream": true
}
```

Example callback payloads:

```js
// stream receives strings like:
"TCP"
"TCP handles"
"TCP handles packet loss by retransmitting missing data."

// complete receives the final string:
"TCP handles packet loss by retransmitting missing data."

// error receives an object like:
{
  code: 7,
  message: "Invalid model id"
}
```

Access values like normal JavaScript:

```js
const handler = {
  stream: (chunk) => {
    // chunk is the text string.
  },
  complete: (text) => {
    // text is the final text string.
  },
  error: (error) => {
    // error.code is the numeric error code.
    // error.message is the readable error message.
  },
};
```

## Model Selection

Models are installed per device. Do not assume a model id is usable until `models.installed()` confirms it.

The SDK only requires `model.id`. Any other model properties are native-provided metadata and should be treated as optional.

```js
async function getModelId() {
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
      onStart: () => {
        // Show download UI for model.
      },
      onProgress: (percent) => {
        // Update download progress with percent.
      },
      onEnd: resolve,
      onError: reject,
    });
  });

  return model.id;
}
```

If inference reports an invalid or unknown model id, reload `models.installed()` and choose from the installed list before calling `run()` again.

## One Generation At A Time

Despia Local AI intentionally supports one active inference job at a time. Running multiple local generations in parallel can overload the device, so the SDK rejects a second `run()` while another job is active or pending soft-close resume.

```js
const first = intelligence.run({
  type: 'text',
  model: 'qwen3-0.6b',
  prompt: 'First prompt',
});

const second = intelligence.run({
  type: 'text',
  model: 'qwen3-0.6b',
  prompt: 'Second prompt',
});

if (!second.ok && second.status === 'busy') {
  // Wait for the first job to complete/error, or cancel it, then try again.
}
```

If a second call provides `handler.error`, it receives:

```js
{ code: 409, message: 'Another inference job is already running...' }
```

JSON shape:

```json
{
  "code": 409,
  "message": "Another inference job is already running. Wait for it to finish or cancel it before starting a new one."
}
```

For user interfaces, disable the send button while generation is active. Re-enable it after `complete`, `error`, or an explicit `cancel()`.

## API Reference

### `intelligence.run(params, handler?)`

Starts one text inference job.

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
  error?: (error: { code: number; message: string }) => void
}
```

Successful return:

```ts
type CallHandle = {
  ok: true
  intent: Params
  cancel(): void
}
```

Rejected return:

```ts
type RunRejected = {
  ok: false
  status: 'outdated' | 'unavailable' | 'busy'
  message: string | null
  intent: null
  cancel(): void
}
```

`cancel()` removes the job from SDK routing. It prevents future callbacks from reaching your handler. It does not guarantee that an already-started generation stops immediately.

Example rejected return:

```json
{
  "ok": false,
  "status": "busy",
  "message": "Another inference job is already running. Wait for it to finish or cancel it before starting a new one.",
  "intent": null
}
```

The actual return object also includes `cancel()`. Function fields are omitted from JSON examples because JSON cannot represent functions.

Common `handler.error` payloads:

```json
{
  "code": 7,
  "message": "Invalid model id"
}
```

```json
{
  "code": 409,
  "message": "Another inference job is already running. Wait for it to finish or cancel it before starting a new one."
}
```

### `intelligence.models.available()`

Loads the installable model catalogue.

```js
const models = await intelligence.models.available();
```

Returns `Promise<Model[]>`. If a cached catalogue is already available, the SDK returns it immediately. If Local AI is unavailable, or the model list does not load within 10 seconds, it resolves to `[]`.

Example response:

```json
[
  {
    "id": "qwen3-0.6b",
    "name": "Qwen 3 0.6B"
  },
  {
    "id": "gemma-3n-e2b-it",
    "name": "Gemma 3n E2B"
  }
]
```

Native may include extra metadata. Treat everything except `id` as optional:

```json
[
  {
    "id": "qwen3-0.6b",
    "name": "Qwen 3 0.6B",
    "sizeBytes": 420000000,
    "quantization": "int4"
  }
]
```

### `intelligence.models.installed()`

Loads models installed on the current device.

```js
const installed = await intelligence.models.installed();
```

Returns `Promise<Model[]>`. If a cached installed-model list is already available, the SDK returns it immediately. If Local AI is unavailable, or the installed list does not load within 10 seconds, it resolves to `[]`.

Example response:

```json
[
  {
    "id": "qwen3-0.6b",
    "name": "Qwen 3 0.6B"
  }
]
```

No models installed:

```json
[]
```

Not-ready response:

```json
{
  "ok": false,
  "status": "unavailable",
  "message": null,
  "intent": null
}
```

The actual not-ready object also includes `cancel()`. Function fields are omitted from JSON examples because JSON cannot represent functions.

### `Model`

```ts
type Model = {
  id: string
  name?: string
  [key: string]: unknown
}
```

Only `id` is required by the SDK.

### `intelligence.models.download(modelId, callbacks?)`

Starts a model download.

```js
intelligence.models.download('qwen3-0.6b', {
  onStart: () => {
    // Show download UI.
  },
  onProgress: (percent) => {
    // percent is an integer from 0 to 100.
  },
  onEnd: () => {
    // Mark the model as installed in your UI.
  },
  onError: (message) => {
    // Show message in your UI.
  },
});
```

Downloads are handled by Despia. They can continue while your app is backgrounded. The SDK does not restart downloads on foreground, because doing so could create duplicate transfers.

Callback meaning:

```js
// onStart: the download started.
// onProgress: percent is an integer from 0 to 100.
// onEnd: the download finished.
// onError: message explains why the download failed.
```

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

Registers a global download listener.

```js
const off = intelligence.on('downloadProgress', (modelId, percent) => {
  // Update shared download state for modelId.
});

off();
```

Supported events:

- `downloadStart(modelId)`
- `downloadProgress(modelId, percent)`
- `downloadEnd(modelId)`
- `downloadError(modelId, message)`

Use `off(event, fn)` to remove a listener, or `once(event, fn)` to run a listener once.

## Soft-Close Resume

Soft close means the user leaves the app and returns while the page is still alive. JavaScript memory survives, but the active generation may need to be restarted.

The SDK handles this case automatically for the single active inference job:

1. The active job is snapshotted before suspension.
2. When the app returns, the SDK starts that job again with the same params and handler.
3. The restarted job uses the same params and continues delivering results to the same handler.

Important details:

- Resume restarts generation. It does not continue from the exact token where the previous attempt stopped.
- The same handler receives `stream`, `complete`, and `error` callbacks after resume.
- Jobs that completed, errored, or were cancelled do not resume.
- A new `run()` while a job is active or pending resume returns `status: 'busy'`.
- If the OS fully closes the page, JavaScript memory is gone and the SDK cannot resume. Restore from your app state and call `run()` again.
- Downloads are separate. Despia owns downloads, so the SDK does not restart them.

## Production Guidance

- Gate all Local AI UI with `intelligence.runtime.ok`.
- Use `models.installed()` before inference.
- Disable generation controls while a job is active.
- Treat `stream(chunk)` as a full snapshot, not a delta.
- Handle `busy` returns from `run()`.
- Handle empty arrays from model APIs.
- Keep your own app state if you need recovery after the OS fully closes the page.

## Guidance For AI-Generated Apps

When asking an AI app builder to use Despia Local AI, give it these constraints:

- Import `despia-intelligence` and use `intelligence.run`, `intelligence.models.available`, `intelligence.models.installed`, `intelligence.models.download`, and `intelligence.models.remove`.
- Do not create another Local AI integration. The SDK is the integration.
- Do not use globals, browser navigation, network requests, workers, or custom callback plumbing for local inference.
- Do not start multiple generations at once. Wait for `complete`, `error`, or call `cancel()` before starting another `run()`.
- Use only model ids returned by `await intelligence.models.installed()` for inference.
- Treat `stream(chunk)` as the full text so far and replace the UI text with it.

Prompt snippet:

```txt
Use the despia-intelligence npm package only. Gate UI with
intelligence.runtime.ok. Load installed models with
intelligence.models.installed(). Start at most one intelligence.run(...) at a
time. In stream(chunk), replace the displayed text; do not append chunks.
```

## Demo And Tests

This repository includes `demo.html`, a standalone page for testing the SDK inside Despia.

Run tests:

```bash
npm test
```

## License

MIT
