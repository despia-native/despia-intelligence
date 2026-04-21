# Despia Intelligence

### Local AI Models in Hybrid Mobile Apps using the Despia Native Runtime

On-device LLM inference for iOS and Android hybrid apps, straight from your existing web codebase. Private by default, offline after first download, zero per-token cost. Call one JavaScript function and stream tokens back as they generate on the device's Neural Engine or GPU, with no API keys, no cloud billing, and no user data leaving the phone.

[![npm](https://img.shields.io/npm/v/despia-intelligence)](https://www.npmjs.com/package/despia-intelligence)
[![license](https://img.shields.io/npm/l/despia-intelligence)](LICENSE)
[![source](https://img.shields.io/badge/source-GitHub-181717?logo=github)](https://github.com/despia-native/despia-intelligence)

**[Learn about Despia Native](https://despia.com)** · **[Source on GitHub](https://github.com/despia-native/despia-intelligence)**

### Why this exists

Shipping an AI feature in a web app today means piping every prompt, every piece of user text, and every conversation history to somebody else's server. You pay per token. You wait for a network round-trip. You run a backend proxy to hide your API key. You renegotiate your privacy policy. That is the right trade-off for a ChatGPT clone, and the wrong one for 90% of the AI features people actually want to build: summarising a note, classifying a tag, rewriting a paragraph, extracting structured JSON from a form, generating a reply suggestion, drafting a title, rephrasing for tone.

**Web apps and plain PWAs cannot run a real local LLM.** Browsers have no access to Apple's Neural Engine, Core ML, Android NNAPI, or the device GPU as a tensor target. They cannot persist hundreds of megabytes of quantised model weights on disk across sessions. WebGPU and the emerging Web Prompt API get closer every year, but they are sandboxed, slower than native, unavailable on large parts of the device fleet your users are on today, and years away from running a 1B+ parameter model inside a tab without shredding battery.

**Despia Native fixes this.** Despia is the native runtime that wraps your web codebase into a real iOS and Android hybrid mobile app, and `despia-intelligence` is the bridge from that web code into the phone's AI hardware. Inference runs through the device's native AI acceleration stack - Metal, Core ML, and the Apple Neural Engine on iOS; GPU, NNAPI, and the CPU fast-path on Android - with the Despia runtime picking the best path per model automatically. Models load into the native process, not your JS heap. Your code stays the React / Vue / Svelte / vanilla JavaScript you already wrote; the execution is fully native, on-device, and private.

### What you get

| | |
| --- | --- |
| **Private by default** | Prompts, user text, and generated tokens never leave the device. Nothing to log, retain, or train on. |
| **Unlimited and 100% free** | Inference runs inside Despia's Local AI System in the Despia Native Runtime. No per-token pricing, no quotas, no rate limits, no usage caps. Ever. |
| **Offline** | Works on a plane, in a tunnel, in airplane mode, after first download. |
| **Low latency** | No network hop. First token in tens of milliseconds on flagship silicon. |
| **No backend** | No API keys to guard, no proxy server, no CORS, no bill-shock from a leaked key. |
| **Compliance-friendly** | On-device inference naturally fits HIPAA, GDPR, and "data never leaves the device" audit requirements, because it actually doesn't. |

### What the SDK does

- `intelligence.run({ type: 'text', model, prompt }, handler)` - one call, streaming tokens back to your handler.
- Automatic model download with progress events. Downloads continue while the app is closed via `NSURLSession` on iOS and `WorkManager` on Android.
- Zero-config background and foreground resume. Pressing the home button mid-generation is not a bug; every in-flight job re-fires automatically when the user comes back.
- No `init()`, no config file, no bundler plugin, no native install step.
- Same code on iOS and Android.

### Scope and status

This release enables `text` inference. Open-weights text models from Qwen, Liquid LFM, Google Gemma, and Tencent Youtu are securely downloaded on demand from [Hugging Face](https://huggingface.co) into the Despia container and run entirely on-device.

Included for free in every Despia app. This package is a separate project with its own release cycle; adding it to a Despia build enables Local AI on that build, nothing else changes.

> **Local AI in Despia is unlimited and 100% free.** Every inference runs on the user's device inside Despia's Local AI System, part of the Despia Native Runtime. There is no per-token billing, no monthly quota, no rate limit, and no usage cap - because there is no server in the loop. Run as many completions as the device can handle, for as long as your users have your app installed.

---

## Requirements

- The app must be running inside the Despia Native Runtime on iOS or Android, on a build that has Local Intelligence enabled.
- Outside the Despia Native Runtime (for example, a desktop browser preview of the same code or a server-side render), every API is a no-op that returns a not-ready shape. `intelligence.runtime.ok` is the single source of truth; gate behind it and provide a fallback for those environments.
- No native install step on the developer side, no `init()`, no config file, no bundler plugin.

---

## Table of Contents

- [Requirements](#requirements)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Runtime Detection](#runtime-detection)
- [AI Agent Rules](#ai-agent-rules)
- [API Reference](#api-reference)
- [Text Inference](#text-inference)
- [Background and Return](#background-and-return)
- [Concurrent Jobs](#concurrent-jobs)
- [Models](#models)
- [Download Events](#download-events)
- [Available Models](#available-models)
- [Support](#support)
- [License](#license)

---

## Installation

```bash
npm install despia-intelligence
# pnpm add despia-intelligence
# yarn add despia-intelligence
```

```js
import intelligence from 'despia-intelligence';
```

> CDN alternative: `https://cdn.jsdelivr.net/npm/despia-intelligence/+esm` (ESM) or `https://cdn.jsdelivr.net/npm/despia-intelligence/index.js` (UMD, global `intelligence`)

---

## Quick Start

```js
import intelligence from 'despia-intelligence';

if (!intelligence.runtime.ok) {
  // Display intelligence.runtime.message, or fall back to a cloud model
  return;
}

intelligence.run({
  type:   'text',
  model:  'qwen3-0.6b',
  prompt: 'How does TCP handle packet loss?',
  system: 'Three sentences max.',
  stream: true,
}, {
  stream:   (chunk) => output.textContent = chunk, // full accumulated text - replace, do not append
  complete: (text)  => save(text),                 // final complete response string
  error:    (err)   => console.error(err.code, err.message),
});
```

No initialization. No setup. No `init()` call. Open your app in a Despia runtime with a Local Intelligence build and it works.

**How it works**

Calling `intelligence.run()` hands your params to the Despia Native Runtime with a fresh job ID. The native layer loads the model onto whichever acceleration path is fastest for that model on the current device (Metal or Core ML on iOS, GPU or NNAPI on Android, CPU fast-path as a universal fallback), runs inference, and streams tokens back into your JavaScript handler as they are generated. The SDK routes each token to the correct handler by job ID, so running many concurrent jobs in the same page is safe.

Values you pass (prompts, system strings, arrays) are percent-encoded end-to-end, so spaces, newlines, quotes, ampersands, and unicode all survive the bridge intact. New parameters added on the native side flow through without an SDK upgrade - any extra key you put on the params object is forwarded as-is.

---

## Runtime Detection

The SDK only activates inside the Despia native runtime on a build with Local Intelligence enabled. Runtime state is resolved once at import time and exposed synchronously:

```js
intelligence.runtime.ok       // boolean
intelligence.runtime.status   // 'ready' | 'runtime_incompatible' | 'outdated' | 'unavailable'
intelligence.runtime.message  // string | null - safe to render directly in your UI
```

| Status                 | Meaning                                                                                 |
| ---------------------- | --------------------------------------------------------------------------------------- |
| `ready`                | Despia runtime active and Local Intelligence is supported. Call the API.                |
| `runtime_incompatible` | Running in Despia, but this build predates Local Intelligence. Ask user to update Despia. |
| `outdated`             | Despia-like UA detected but runtime missing. Ask user to install the latest version.    |
| `unavailable`          | Not running in Despia. Fall back to a cloud model or a web-only flow.                   |

When `ok` is `false`, every API call is a no-op that returns the same runtime shape. You never need to wrap calls in a try/catch.

```js
if (!intelligence.runtime.ok) {
  showBanner(intelligence.runtime.message); // null-safe
  return;
}
```

Local Intelligence availability is injected at launch by the native runtime via `window.native_runtime` and `window.intelligence_available`. No feature detection delay, no round-trip.

---

## AI Agent Rules

If you are an AI coding agent generating code against this SDK, follow these rules:

- Import as a default: `import intelligence from 'despia-intelligence'`
- Gate calls with `intelligence.runtime.ok`. Display `intelligence.runtime.message` when it is false. Do not invent your own status strings.
- Do not implement your own `visibilitychange`, `pagehide`, or `beforeunload` persistence for inference. The SDK already auto-resumes every active job via `window.focusout` and `window.focusin` called by the native layer. Any number of concurrent jobs resume.
- Do not use `handler.interrupted(intent)` to implement resume. Resume is automatic. `interrupted` is only a notification hook for UI affordances like "Resuming..." toasts or analytics.
- `stream(chunk)` receives the full accumulated text so far, not a delta. Replace the DOM content, do not append.
- Use `intelligence.models.available()` to discover installable models at runtime. Do not hardcode model lists; new models ship over the air without an SDK upgrade.
- For a model that is not yet installed, call `intelligence.models.download(id, callbacks)` first. The `onProgress` callback delivers percentage updates. Downloads survive backgrounding.
- Only `type: 'text'` is enabled in the current release. Any other value throws a clear error at runtime. Do not add fallbacks that silently ignore the error; surface it to the developer.
- Any key in the params object is forwarded to the native layer as-is. Arrays become comma-separated after URL encoding. You do not need to encode values yourself.

---

## API Reference

### `intelligence.run(params, handler?)`

Fires an inference job and wires callbacks for streaming tokens and final result.

| Parameter | Type                     | Description                                                                 |
| --------- | ------------------------ | --------------------------------------------------------------------------- |
| `params`  | `object`                 | Plain params object. `type` routes the call. All other keys pass through.   |
| `handler` | `object` (optional)      | Callbacks. Any subset of `stream`, `complete`, `error`, `interrupted`.      |

Returns a call handle: `{ ok: true, intent, interrupted, cancel() }`. When the runtime is not ready, returns a compatible not-ready handle: `{ ok: false, status, message, intent: null, interrupted: false, cancel() }` where `cancel()` is a no-op. The same destructure works in both cases.

```js
const call = intelligence.run({ type: 'text', model: 'qwen3-0.6b', prompt: 'Hi' }, {
  stream:   (chunk) => {},
  complete: (text)  => {}, // full final response string
  error:    (err)   => {}, // err.code: 2 = missing id, 3 = runtime inference error
});

call.intent;  // original params object, storable, re-firable
call.cancel(); // remove this job from the SDK. No further callbacks for this job.
```

### `intelligence.models`

| Method                              | Returns                  | Description                                                           |
| ----------------------------------- | ------------------------ | --------------------------------------------------------------------- |
| `available()`                       | `Promise<Model[]>`       | All models the runtime can install.                                   |
| `installed()`                       | `Promise<Model[]>`       | Models currently on device.                                           |
| `download(id, { onStart, onProgress, onEnd, onError })` | `void`                   | Start a background download. Fire-and-forget; results via callbacks. |
| `remove(id)`                        | `Promise<void>`          | Remove a specific model from the device.                              |
| `removeAll()`                       | `Promise<void>`          | Remove every downloaded model. Useful for "clear cache" affordances.  |

Each `Model` is `{ id: string; name: string; category: string }`.

### `intelligence.on / off / once`

Global listeners for download events. Fires for every download on the device, independent of per-call callbacks. Useful for status bars, toasts, or badge counts outside the component that triggered the download.

```js
const off = intelligence.on('downloadProgress', (modelId, pct) => updateBar(modelId, pct));
off(); // unsubscribe
```

Events: `downloadStart`, `downloadProgress`, `downloadEnd`, `downloadError`.

---

## Text Inference

```js
const call = intelligence.run({
  type:   'text',
  model:  'qwen3-0.6b',
  prompt: 'Summarise this article.',
  system: 'Be concise.',
  stream: true,
}, {
  stream:   (chunk) => output.textContent = chunk,
  complete: (text)  => save(text),
  error:    (err)   => console.error(err.code, err.message),
});
```

**Any key passes through.** The SDK does not validate or gate parameter names. Anything you add to the params object is forwarded to the native layer.

```js
intelligence.run({
  type:        'text',
  model:       'qwen3-0.6b',
  prompt:      'Hello.',
  temperature: 0.7,
  top_p:       0.95,
  max_tokens:  256,
}, handler);
```

**Cancel an in-flight call.**

```js
const call = intelligence.run(params, handler);
call.cancel(); // SDK drops the job. No further stream or complete callbacks for this call.
```

---

## Background and Return

Inference sessions do not survive backgrounding. The native inference context is torn down when iOS or Android suspend the WebView. **The SDK handles this for you.** When the user hits home, opens another app, and comes back, every in-flight job is re-fired automatically with the same params and the same handler. Zero developer code, any number of concurrent jobs.

```js
intelligence.run({
  type:   'text',
  model:  'qwen3-0.6b',
  prompt: 'Write me a long essay on TCP.',
  stream: true,
}, {
  stream:   (chunk) => output.textContent = chunk,
  complete: (text)  => save(text),
});
```

User hits home, pays a friend in their banking app, comes back. Stream restarts. No button, no resume logic, no state to serialise.

**How it works under the hood**

The native layer fires `window.focusout` directly from `applicationDidEnterBackground` (iOS) and `onPause` (Android). The JS thread is fully alive at that point, before any WebView suspension. The SDK uses that window to copy every active job into an internal `_pending` map. When the app returns, the native layer fires `window.focusin` and the SDK drains `_pending` by re-firing `run()` for each entry with a fresh native session and a new job ID. The standard `visibilitychange` event is unreliable on both platforms in this scenario because it competes with the OS's process suspension; the native lifecycle hooks run synchronously before suspension begins.

**Rules**

- Jobs that **complete normally** never re-fire. Auto-resume only kicks in for genuinely interrupted streams.
- Jobs that **error out** never re-fire. Failed jobs are removed from `_pending` by `onMLError`.
- Jobs you **explicitly `.cancel()`** never re-fire.
- **Any number of concurrent jobs** all resume. Seven streams in flight at background? All seven come back.
- **Downloads** follow a different rule - they continue natively while the app is closed, and the SDK keeps their session callbacks alive across background so the progress bar and `onEnd` in the component that started the download still fire on return. See [Download Events](#download-events).

---

## Concurrent Jobs

Concurrent inference is a single-line API. Fire as many `run()` calls as you need. Each one has its own handler, its own job ID, its own entry in the SDK's active-job registry, and its own slot in `_pending` if the user backgrounds before it finishes.

```js
const sections = ['intro', 'history', 'handshake', 'loss', 'congestion', 'vs-udp', 'conclusion'];

sections.forEach((section) => {
  intelligence.run({
    type:   'text',
    model:  'qwen3-0.6b',
    prompt: `Write the ${section} section of a TCP explainer.`,
    stream: true,
  }, {
    stream:   (chunk) => document.getElementById(section).textContent = chunk,
    complete: (text)  => document.getElementById(section).textContent = text,
  });
});
```

User backgrounds mid-generation. All seven jobs are saved. User returns. All seven re-fire with fresh native sessions and new IDs, each one streaming back into the correct DOM element because the handlers still capture their own `section`. Developer writes nothing for that.

`handler.interrupted(intent)` is still available as a notification hook if you want to surface a "Resuming..." toast or log interrupted jobs to analytics. It fires for every active job on `focusout`. It is no longer needed to implement resume - the SDK does that.

Whether the native layer actually runs N streams in parallel or queues them internally is a native-side concern and probably device-dependent. From the JS side, the contract is simple: every job you fire is tracked, every interrupted job comes back.

---

## Models

```js
// Full catalogue the runtime can install
const all       = await intelligence.models.available();

// Currently downloaded to this device
const installed = await intelligence.models.installed();

// Start a download. Fire-and-forget. Results arrive via the callback object.
intelligence.models.download('qwen3-0.6b', {
  onStart:    ()      => showDownloadUI(),
  onProgress: (pct)   => bar.style.width = pct + '%',  // 0-100 integer
  onEnd:      ()      => hideDownloadUI(),
  onError:    (err)   => showError(err),
});

// Check whether a specific model is installed
const ready = installed.some(m => m.id === 'qwen3-0.6b');

// Remove one model
await intelligence.models.remove('qwen3-0.6b');

// Clear everything (affordance for a "free up space" button)
await intelligence.models.removeAll();
```

Each model object:

```ts
{ id: string; name: string; category: 'text' }
```

Only `'text'` is enabled in the current release.

**How models work**

Model weights are securely downloaded from [Hugging Face](https://huggingface.co) once, stored in the device's Application Support directory inside the Despia container, and reused across launches with no re-download. After download, inference runs entirely on-device with no network connection required.

Transfers are performed by the native OS: `NSURLSession` on iOS, `WorkManager` on Android. They continue when the app is fully closed, resume across connectivity changes, and retry on transient network failures without any logic on your side.

Each model is published in two quantizations:

- **`int4`** - smaller file, faster inference, lower memory. Start here.
- **`int8`** - higher output quality, larger download, slightly slower.

The runtime picks the quantization based on device capability and what has been downloaded. Small text models typically land around 200-400 MB (`int4`); medium text models 600 MB to 1.2 GB. Prompt users to download on Wi-Fi.

---

## Download Events

Two layers. Per-call callbacks for the component that started the download. Global events for persistent app state that needs to survive anything - including the user force-quitting the app mid-download.

```js
const offStart    = intelligence.on('downloadStart',    (modelId)      => markDownloading(modelId));
const offProgress = intelligence.on('downloadProgress', (modelId, pct) => updateBar(modelId, pct));  // pct = 0-100 integer
const offEnd      = intelligence.on('downloadEnd',      (modelId)      => markReady(modelId));
const offError    = intelligence.on('downloadError',    (modelId, err) => showError(modelId, err));

offProgress();

intelligence.once('downloadEnd', (modelId) => showFirstDownloadBadge());
```

`pct` is a `0-100` integer in both the global `downloadProgress` event and the per-call `onProgress` callback. The SDK normalises the native value once so every listener receives the same percentage.

**In-session callbacks vs global events**

The per-call `download(id, callbacks)` handlers are scoped to that specific download in that specific session - ideal for the progress bar and loading state on the settings page. Global events (`intelligence.on(...)`) fire for every download regardless of who started it - ideal for app-wide state like a badge in the tab bar or flipping a model from "downloading" to "installed" in your state store.

**Backgrounding is handled for you.** The user can hit home mid-download, switch to another app, come back, and the progress bar keeps moving. Downloads run natively via `NSURLSession` on iOS and `WorkManager` on Android, so the transfer itself never pauses when the app goes inactive. The SDK keeps the session callbacks registered across the background/foreground cycle, so:

- If the download is still in progress on return, `onProgress` resumes firing on the same handler you passed to `download()`.
- If the download finished while the app was away, `onEnd` fires on return - routed to the original session handler.
- If it failed while the app was away, `onError` fires on return with the reason.

One caveat: `onProgress` is not replayed for time spent backgrounded. The bar freezes at whatever percentage it was when the user left, and resumes from the next real progress tick after return. This is correct and expected; there is no event to fake in between.

**If the app is fully killed.** Session callbacks live in JS memory, so a force-quit clears them. The download itself keeps going natively (that is the whole point of `NSURLSession` and `WorkManager`), and on relaunch the native layer replays `onDownloadEnd` / `onDownloadError`. Session handlers from the previous process are gone, but global events still fire - which is why they are the right place for persistent state.

```js
intelligence.on('downloadEnd', (modelId) => markInstalled(modelId));

intelligence.models.download('qwen3-0.6b', {
  onStart:    ()    => showDownloadUI(),
  onProgress: (pct) => updateBar(pct),
  onEnd:      ()    => hideDownloadUI(),
  onError:    (err) => showError(err),
});
```

The pattern: session callbacks for in-session UX, global events for permanent state.

---

## Available Models

Text models, available now. Pick by size first, quality second. Smaller models load faster, use less RAM, and work on older devices; larger models give higher quality at the cost of latency and memory.

**Device tiers**

- **Any** runs on anything Despia supports, including older phones (roughly iPhone XR+, mid-range Android 2020+).
- **Modern** needs a recent mid-range or better (iPhone 12+, Pixel 6+, Galaxy S21+, ~4 GB RAM).
- **Flagship** targets NPU/ANE-accelerated SoCs with 8 GB+ RAM (iPhone 14 Pro+, Pixel 8 Pro+, high-end Galaxy).

**Model grid**

| Model                     | Size               | Family         | Strengths                                | Good use cases                                                              | Device tier         |
| ------------------------- | ------------------ | -------------- | ---------------------------------------- | --------------------------------------------------------------------------- | ------------------- |
| `lfm2.5-350m`             | 350M               | Liquid LFM2.5  | Ultra-fast, tiny memory footprint         | Autocomplete, intent classification, short replies, keyboard-style helpers | Any                 |
| `qwen3-0.6b`              | 600M               | Alibaba Qwen3  | Balanced default, best size-to-quality    | Chat, Q&A, summarisation, first-time integrations                          | Any                 |
| `lfm2-700m`               | 700M               | Liquid LFM2    | Low-latency general chat                  | Quick on-device assistant, inline rewrites, tone adjust                    | Any                 |
| `gemma-3-1b-it`           | 1B                 | Google Gemma 3 | Strong instruction tuning, safety-tuned   | General assistant, content rewriting, safe-for-consumer apps               | Modern              |
| `lfm2.5-1.2b-instruct`    | 1.2B               | Liquid LFM2.5  | Follows structured instructions well      | Tool-style prompts, JSON output, form extraction, templated generation     | Modern              |
| `lfm2.5-1.2b-thinking`    | 1.2B               | Liquid LFM2.5  | Chain-of-thought reasoning                | Math, multi-step planning, problem decomposition, logic                    | Modern              |
| `qwen3-1.7b`              | 1.7B               | Alibaba Qwen3  | Stronger reasoning, code-aware            | Longer conversations, coding help, analysis, extraction                    | Modern              |
| `youtu-llm-2b`            | 2B                 | Tencent Youtu  | Strong multilingual (CN/EN) coverage      | Bilingual chat, translation-style tasks, cross-language extraction         | Modern              |
| `lfm2-2.6b`               | 2.6B               | Liquid LFM2    | Higher-quality general chat               | Assistant replacements, long-form rewriting, content generation            | Modern to Flagship  |
| `gemma-3n-e4b-it`         | 4B effective       | Google Gemma 3n | Mobile-optimised per-layer embeddings    | Premium on-device assistant, longer context, nuanced instruction handling  | Flagship            |
| `lfm2-8b-a1b`             | 8B MoE (1B active) | Liquid LFM2    | Highest quality available on-device       | Near-cloud quality when quality matters more than speed                    | Flagship            |

**How to choose**

- **Not sure where to start?** Use `qwen3-0.6b`. It runs everywhere, answers well, and is a good baseline before you ship anything bigger.
- **Need speed above all?** `lfm2.5-350m` or `lfm2-700m` for micro-interactions like autocomplete, labels, and classification.
- **Need structured output (JSON, forms, tool calls)?** `lfm2.5-1.2b-instruct`.
- **Need reasoning or step-by-step thinking?** `lfm2.5-1.2b-thinking`, stepping up to `qwen3-1.7b` if you need more capability.
- **Shipping a premium app on flagship devices?** `gemma-3n-e4b-it` or `lfm2-8b-a1b` give the highest quality you can run on-device today.
- **Multi-lingual or Chinese-first?** `youtu-llm-2b`.

Device capability varies widely across the Android ecosystem. If you are unsure, start with the smaller model and let users opt into larger ones via a settings toggle.

All text models are published in `int4` (smaller, faster) and `int8` (higher quality) quantizations.

Discover what is actually installable on the current runtime via `intelligence.models.available()`. New models ship over the air from [Hugging Face](https://huggingface.co) and do not require an SDK upgrade.

---

## Support

For questions or concerns regarding this package, contact the Despia team at [npm@despia.com](mailto:npm@despia.com).

---

## License

MIT
