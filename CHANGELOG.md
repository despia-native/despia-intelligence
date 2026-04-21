# Changelog

All notable changes to this project are documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Inference callbacks are assigned on **`window`** (`window.onMLToken`, `window.onMLComplete`, `window.onMLError`) to match the native WebView contract. Model lifecycle callbacks remain registrar calls on **`window.intelligence`**.

### Changed

- Internal docs ([`RAW_BRIDGE.md`](./RAW_BRIDGE.md), [`MAINTENANCE.md`](./MAINTENANCE.md)) describe the dual bridge surface (flat `window` for ML vs `window.intelligence` for downloads/removes).

## [1.0.1] - 2026-04-21

### Added

- [`RAW_BRIDGE.md`](./RAW_BRIDGE.md) — internal reference for the raw scheme + callback bridge.
- [`_safeSig`](./index.js) / [`_observe`](./index.js) — variable observer for `window.intelligence.installedModels` after `intelligence://models?query=installed`, avoiding races with `onInstalledModelsLoaded`.

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
