# Architecture Assessment

Date: 2026-05-23

This note records the current project architecture and whether it is ready for the v2
track: selector hardening, typing/activity guard, follow-up trims, UI refresh, and an
optional delete-mode API/history-limiting experiment.

## Current Shape

The extension is a compact Manifest V3 project.

- `src/content/main.ts`
  - Owns runtime lifecycle and orchestration.
  - Creates UI, toast, observer, trimmer, debug console, route reset, Long Task gate, and
    stop/toggle globals.
  - Coordinates smaller runtime modules instead of owning their internal state.
- `src/content/settings-store.ts`
  - Owns extension-storage-backed settings reads, persistence, and normalization.
  - Owns the debug flag used by console diagnostics.
- `src/content/turn-inventory.ts`
  - Owns turn visibility/removal tracking and debug inventory reports.
- `src/content/trim-scheduler.ts`
  - Owns idle scheduling, adaptive debounce, cancellation, and pending-after-resume state.
- `src/content/activity-guard.ts`
  - Delays automatic trims while the user is active in the composer.
- `src/content/follow-up-trims.ts`
  - Schedules conservative delayed checks after observer init and route changes.
- `src/content/trim-engine.ts`
  - Owns hide, restore, delete, batch delete, and max-keep trimming.
  - It is already reasonably isolated from UI.
- `src/content/observer.ts`
  - Owns MutationObserver, container discovery, route rebind, and internal UI filtering.
  - It already returns a small handle interface.
- `src/content/ui.ts`
  - Owns floating panel, toast, tooltip, and show-more button.
  - It calls back through `onApply` instead of directly mutating runtime state.
- `src/content/debug.ts`
  - Owns console-only debug API registration.
  - `main.ts` supplies runtime data providers.
- `src/content/dom-utils.ts`
  - Owns DOM marking and query helpers.
- `src/background/background.ts`
  - Owns toolbar badge and enable/disable toggle.
  - It is stable and does not need to participate in v2 runtime refactors.

## What Is Already Good For v2

- The project has a small module graph.
- Hide/delete behavior is mostly contained in `trim-engine.ts`.
- Observer behavior is already separate from trim behavior.
- Debug UI has already been removed from the product surface.
- Constants are centralized.
- The normal product model still has only two modes: `hide` and `delete`.
- The build setup is simple and does not constrain refactoring.

## Main Architecture Risk

The first extraction pass has reduced the original `main.ts` ownership risk.

The runtime now has clearer modules for:

- settings persistence
- inventory tracking
- trim scheduling
- typing/activity delay
- initial-load and route-change follow-up checks

`main.ts` still owns:

- Long Task gate
- route-change reset
- hide-mode baseline tracking
- UI apply behavior
- debug metrics
- lifecycle cleanup

This is a reasonable shape for the current v2 foundation. The remaining risk is adding
future UI status data or API experiment state directly into `main.ts` without a small
data boundary first.

## Recommendation

Do not do a large rewrite before v2.

The small architecture pass has extracted the parts most likely to grow:

1. Runtime settings.
2. Turn inventory.
3. Trim scheduler.
4. Activity guard.
5. Follow-up trim scheduler.

Keep `hide` and `delete` semantics stable. The next architecture boundary should be a
small runtime status snapshot for normal UI use. Optional delete API experiment state can
wait until after selector diagnostics and UI status are stable.

## Suggested Module Boundaries

### `settings-store.ts`

Purpose:

- Read initial settings from `chrome.storage.local`.
- Persist applied settings.
- Normalize invalid values.

Should own:

- `maxKeep`
- `mode`
- `notify`
- `enabled`
- `debug`

Should not own:

- UI rendering.
- Trim execution.

### `turn-inventory.ts`

Purpose:

- Track known turn IDs, hidden state, visible count, hidden count, and delete-mode removed
  count.
- Provide resync and mutation tracking helpers.

Should own current logic from `main.ts`:

- `knownTurnIds`
- `turnHidden`
- `visibleCount`
- `hiddenCount`
- `deleteModeRemovedCount`
- `getTurnKey`
- `trackAddedTurn`
- `trackRemovedTurn`
- `trackTurnHidden`
- `trackTurnRestored`
- `trackTurnDeleted`
- `dumpInventory`

### `trim-scheduler.ts`

Purpose:

- Own scheduled trim state, idle callback, debounce, max timeout, pending-after-resume
  behavior, and adaptive debounce.

Should accept:

- `runTrim`
- `isSuspended`
- `isInWakeCooldown`
- `log`

Should expose:

- `scheduleTrim(reason, opts)`
- `cancel()`
- `queueAfterResume(opts)`
- `flushAfterResume()`
- `getTrimAverageMs()`

### `activity-guard.ts`

Purpose:

- Detect recent composer activity and tell automatic trim scheduling to wait.

Should own:

- input/composition/paste/focus events
- cooldown timestamp
- `isActive()`
- `explain()`

Manual apply and `__ccxDebug.forceTrim()` should bypass the guard.

### `follow-up-trims.ts`

Purpose:

- Schedule conservative delayed checks after observer init and route changes.

Should own:

- delay sequence
- cancellation on route change or stop
- debug-only logging

### `delete-api-experiment-state.ts`

Purpose:

- Track whether API/history limiting is enabled, disabled, or self-disabled for the
  current page session.

Should own:

- disable reasons
- counters
- debug state export
- manual disable hook

The actual fetch patch should remain separate if it is ever prototyped.

## What Should Not Change Yet

- Do not add a third user-facing cleanup mode.
- Do not make API/history limiting part of normal `delete` behavior yet.
- Do not rewrite `trim-engine.ts` until selector and scheduling evidence shows a need.
- Do not move background badge logic into the content runtime.
- Do not redesign UI and runtime behavior in the same change.

## Mode Strategy

The product can keep the same two modes:

- `hide`
  - Keep current semantics.
  - Add typing guard and follow-up trim safety.
- `delete`
  - Keep current DOM delete semantics.
  - Later allow an experimental API/history limiter as an extra delete-mode accelerator.
  - The experiment must be opt-in and self-disabling.

This avoids mode explosion while still allowing aggressive behavior where it makes sense.

## Suggested Next Steps

1. Add selector stability notes from real ChatGPT pages.
2. Decide whether selector changes are needed based on that evidence.
3. Define a runtime status snapshot for normal UI use.
4. Add data plumbing for that snapshot before changing visible UI.
5. Revisit the main panel status refresh after the runtime data shape is stable.
6. Prototype delete-mode API/history limiting only after the default runtime and UI status
   path are clean.
