# Changelog

All notable changes to this project are documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.3] - 2026-04-21

### Changed

- **`_fire()`** in [`index.js`](./index.js) now queues scheme URLs the same way as **despia-native**: sequential **`window.despia = command`** with a **1ms** gap between deliveries, **try/catch** per assignment, so bursts (for example resume + download) align with Despia's npm bridge instead of hammering the WebView in one stack. [`README.md`](./README.md), [`RAW_BRIDGE.md`](./RAW_BRIDGE.md), and [`MAINTENANCE.md`](./MAINTENANCE.md) describe the queue for app developers and raw integrators.

## [1.0.2] - 2026-04-21

### Changed

- **`_fire()`** assigns **`window.despia = url`** instead of **`window.location.href`**, matching the Despia minimal bridge (SPA-friendly, easier to trace). [`README.md`](./README.md), [`RAW_BRIDGE.md`](./RAW_BRIDGE.md), and [`MAINTENANCE.md`](./MAINTENANCE.md) updated accordingly.
- README, [`RAW_BRIDGE.md`](./RAW_BRIDGE.md), [`MAINTENANCE.md`](./MAINTENANCE.md), and JSDoc/comments in [`index.d.ts`](./index.d.ts) / [`index.js`](./index.js) now consistently describe ML streaming callbacks on **`window`** (`onMLToken`, `onMLComplete`, `onMLError`), model lifecycle on **`window.intelligence`**, and **`window.native_runtime === 'despia'`** as the sole runtime gate.
- **MAINTENANCE**: per-release WebView QA checklist for verifying the native bridge in a real WebView.
- **README**: link to the [Despia Native introduction](https://setup.despia.com/introduction); requirements, runtime, and API table copy aligned with current behaviour.
- Documentation typography: ASCII hyphen and punctuation instead of Unicode em dash in project markdown and comments.

## [1.0.1] - 2026-04-21

### Added

- [`RAW_BRIDGE.md`](./RAW_BRIDGE.md) - internal reference for the raw scheme + callback bridge.
- [`_safeSig`](./index.js) / [`_observe`](./index.js) - variable observer for `window.intelligence.installedModels` after `intelligence://models?query=installed`, avoiding races with `onInstalledModelsLoaded`.

### Changed

- Runtime detection uses **`window.native_runtime === 'despia'`** only; removed `intelligence_available` and **`runtime_incompatible`** status ([`index.d.ts`](./index.d.ts), [`index.js`](./index.js)).
- **`models.available()`** reads **`window.intelligence.availableModels`** synchronously; returns **`[]`** when not in the Despia WebView (no scheme round-trip).
- **`models.installed()`** pre-clears **`installedModels`**, observes updates, fires the installed query scheme; times out to **`[]`** instead of hanging.
- Download/remove handlers registered via **`window.intelligence.on*(fn)`** in **`_boot()`** ([`index.js`](./index.js)).
- README and MAINTENANCE updated for the above behaviour.

### Removed

- **`window.__resInst`** and **`onInstalledModelsLoaded`** wiring for installed-model list resolution (replaced by **`_observe`**).

## [1.0.0] - 2026-04-21

### Added

- Initial npm-ready package: UMD entry [`index.js`](./index.js), types [`index.d.ts`](./index.d.ts), [`exports`](./package.json) map, **`prepublishOnly`** tests, GitHub Actions CI (Node 18 / 20 / 22), repository metadata.
