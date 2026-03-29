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

- `main.ts`: Runtime owner. Wires together observers, trimmer, UI, storm gate, monitor, and debug hooks.
- `constants.ts`: Central place for tunable parameters such as keep count, debounce, long-task gate, batch sizing, and monitor limits.
- `trim-engine.ts`: Core hide / restore / delete behavior.
- `observer.ts`: MutationObserver and route-change handling for ChatGPT's SPA behavior.
- `ui.ts`: Floating control panel, toast UI, and "Show previous" behavior.
- `monitor.ts`: Pure display panel for runtime metrics. It is not the owner of debug commands.
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

## Current Debug / Monitor Design

- The Monitor panel is a UI-only diagnostics surface opened from the in-page button.
- The Monitor panel does not expose a global API.
- Debug commands are owned by `main.ts`.
- When `localStorage.ccx_debug === "1"`, `main.ts` exposes `__ccxDebug` in the page context.

Current debug helpers:

- `__ccxDebug.getMetrics()`
- `__ccxDebug.forceTrim()`
- `__ccxDebug.forceTrimNow()`
- `__ccxDebug.showMonitor()`
- `__ccxDebug.hideMonitor()`

Always-available global helpers:

- `__ccxChatCleanerStop()`
- `__ccxChatCleanerToggle(force?)`

## Project Conventions

- Prefer adjusting values in `constants.ts` before changing scheduling logic.
- Treat `main.ts` as the source of truth for lifecycle, debug ownership, and runtime orchestration.
- Keep `monitor.ts` focused on display concerns.
- Keep `types.ts` logic-free.
- Do not edit `dist/` by hand.
- If releasing a new version, update both `package.json` and `src/manifest.json`, then rebuild.

## Practical Notes

- This project has been fairly stable against ChatGPT DOM changes, so avoid speculative rewrites.
- Selector changes should be conservative and validated against real ChatGPT pages.
- Monitor additions should be restrained; the panel is meant to stay lightweight.
- If something can be fixed by simplifying ownership or reducing overlap, prefer that over adding new layers.
