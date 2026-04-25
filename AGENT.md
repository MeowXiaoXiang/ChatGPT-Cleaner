# ChatGPT Cleaner - Agent Guide

This file is the fast-start guide for coding agents working in this repo.
It describes the project as a whole, not a single change or release.

## What This Project Is

`ChatGPT Cleaner` is a Chrome Manifest v3 extension that reduces DOM pressure in ChatGPT conversations by hiding or deleting older messages while keeping the page responsive.

The extension operates only on the frontend DOM. It does not touch account data, network payloads, or cloud-side conversation state.

## Tech Stack

- TypeScript
- Chrome Extension Manifest v3
- esbuild
- Yarn 4 + Corepack + Plug'n'Play (PnP)
- Node.js 20+

Primary commands:

```bash
yarn install
yarn typecheck
yarn build
yarn dev
yarn zip
```

Build output goes to `dist/`. Load the unpacked extension from `dist/`, not `src/`.

## Core Structure

The main logic lives in `src/content/`.

- `main.ts`: Runtime owner. Wires together observers, trimmer, UI, storm gate, and debug console setup.
- `constants.ts`: Central place for tunable parameters such as keep count, debounce, long-task gate, and batch sizing.
- `trim-engine.ts`: Core hide / restore / delete behavior.
- `observer.ts`: MutationObserver and route-change handling for ChatGPT's SPA behavior.
- `ui.ts`: Floating control panel, toast UI, and "Show previous" behavior.
- `debug.ts`: Debug-only console API exposed when `ccx_debug=1`.
- `dom-utils.ts`, `idle-utils.ts`, `types.ts`: Supporting utilities and shared types.

Other important files:

- `src/background/background.ts`: Badge toggle behavior.
- `src/manifest.json`: Extension manifest. Keep version aligned with `package.json` when releasing.
- `esbuild.config.mjs`: Build and static-copy pipeline.

## Runtime Model

The extension has two cleanup modes:

- `hide`: Old messages stay in DOM but become visually and interactively hidden.
- `delete`: Old messages are removed from the DOM.

Performance protection is controlled in `main.ts` using:

- Long Task monitoring (`PerformanceObserver`)
- EMA-based adaptive debounce
- Mutation throttling
- Idle-time scheduling

Tune behavior through `constants.ts` first before changing logic.

## Current Debug Design

- Runtime diagnostics are console-only and are not exposed in the normal product UI.
- Debug command registration is owned by `debug.ts`; `main.ts` supplies runtime metrics and actions.
- When `localStorage.ccx_debug === "1"`, the content script exposes `__ccxDebug` in the console context.

Current debug helpers:

- `__ccxDebug.getMetrics()`
- `__ccxDebug.report()`
- `__ccxDebug.forceTrim()`
- `__ccxDebug.dumpInventory()`
- `__ccxDebug.explainSelectors()`
- `__ccxDebug.watchMetrics(seconds?)`
- `__ccxDebug.stopWatch()`

Always-available global helpers:

- `__ccxChatCleanerStop()`
- `__ccxChatCleanerToggle(force?)`

## Project Conventions

- Prefer adjusting values in `constants.ts` before changing scheduling logic.
- Treat `main.ts` as the source of truth for lifecycle and runtime orchestration.
- Keep debug-only command registration in `debug.ts`; do not add debug DOM panels to the normal UI.
- Keep `types.ts` logic-free.
- Do not edit `dist/` by hand.
- If releasing a new version, update both `package.json` and `src/manifest.json`, then rebuild.

## Practical Notes

- This project has been fairly stable against ChatGPT DOM changes, so avoid speculative rewrites.
- Selector changes should be conservative and validated against real ChatGPT pages.
- Debug additions should stay console-only unless a separate plan explicitly introduces a debug page.
- If something can be fixed by simplifying ownership or reducing overlap, prefer that over adding new layers.
