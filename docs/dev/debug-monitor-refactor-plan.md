# Debug / Monitor Refactor Plan

This is a temporary development plan for separating developer diagnostics from the user-facing extension UI.

## Goal

Move performance/debug diagnostics out of the normal product surface.

The extension should keep lightweight diagnostic tools for development, but users should not need to see or maintain a separate monitor panel during normal use.

## Current Problem

- `monitor.ts` owns its own floating DOM panel and styles.
- The main UI exposes a monitor button, which makes the product feel like a debug dashboard.
- Useful runtime numbers are split between product UI, monitor UI, and console hooks.
- Maintaining monitor DOM adds extra UI surface area without helping the core hide/delete behavior.

## Proposed Direction

Create a dedicated `src/content/debug.ts` module for developer-only diagnostics.

The normal UI should not expose monitor controls. Debug tools should be enabled only when `ccx_debug=1`.

## Proposed Debug API

Expose a single console object in debug mode:

```ts
window.__ccxDebug
```

Suggested methods:

| Method | Purpose |
| --- | --- |
| `getMetrics()` | Return the current metrics object. |
| `report()` | Print a one-time human-readable summary to the console. |
| `forceTrim()` | Run a trim immediately and print the result. |
| `dumpInventory()` | Print visible/hidden/known turn inventory state. |
| `explainSelectors()` | Print selector match counts and sample nodes. |
| `watchMetrics(seconds?: number)` | Print metrics periodically for a short diagnostic window. |
| `stopWatch()` | Stop an active metrics watcher. |

## Implementation Steps

1. Add `src/content/debug.ts`.
2. Move debug hook setup out of `main.ts`.
3. Use a neutral `getDebugMetrics()` provider for console diagnostics.
4. Register `__ccxDebug` only when `DEBUG === true`.
5. Remove the monitor button from the normal panel.
6. Stop mounting `monitor.ts` from the normal runtime path.
7. Delete `monitor.ts`; diagnostics are console-only after this refactor.

## Non-Goals

- Do not redesign the main UI in this refactor.
- Do not change hide/delete behavior.
- Do not add fetch/API limiting.
- Do not broaden selectors in this same change.
- Do not add new user-facing settings.

## Acceptance Criteria

- With `ccx_debug` disabled, no monitor button appears in the main UI.
- With `ccx_debug=1`, `__ccxDebug` is available in the content script console.
- `__ccxDebug.report()` prints the current mode, visible/hidden/removed counts, trim average, and suspended state.
- `__ccxDebug.forceTrim()` still works.
- `__ccxDebug.dumpInventory()` prints internal inventory counts and consistency state.
- `__ccxDebug.explainSelectors()` prints selector counts and limited element samples.
- The extension builds successfully.

## Follow-Up Work

After this refactor, use console diagnostics to evaluate future stability improvements:

- selector fallback validation
- typing guard
- initial-load follow-up trim waves
- more accurate visible/hidden/removed status for the main UI

This file can be deleted after the refactor is implemented, or folded into a permanent debugging document if the console API becomes part of the development workflow.
