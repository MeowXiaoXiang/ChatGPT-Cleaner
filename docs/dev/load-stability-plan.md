# Conversation Load Stability Plan

Updated: 2026-06-28

> [!IMPORTANT]
> Historical experiment note for the unreleased `codex/v2` branch. The readiness work
> reduced initial-load risk but did not prevent conflicts during native virtualized
> scrolling. The implementation was not released.

This note defines the public runtime direction for preventing automatic cleanup from
interfering with ChatGPT conversation hydration and native turn virtualization.

## Problem

`document_idle` only means the document is idle enough for a content script. It does not
mean that conversation fetch, hydration, streamed state restoration, or turn
virtualization has finished.

The previous observer started work as soon as the first configured turn appeared and
attached to that turn's immediate parent. On the current page shape this could be a
single per-turn wrapper, so sibling hydration was not observed reliably.

Direct DOM deletion is the highest-risk operation. Hiding is less destructive, but can
still change layout while ChatGPT is measuring placeholder heights.

## Safety Rule

Automatic trim must pass a conversation load-readiness gate in addition to the existing
activity, Long Task, and wake gates.

The gate applies to both modes:

- `delete`: never mutate React-owned turn DOM while loading is uncertain.
- `hide`: wait for stable turn/wrapper geometry before changing visibility.

Manual Apply should queue until ready. A debug-only force command may bypass the gate,
but must report that it is overriding hydration safety.

## Candidate Readiness Signals

Use observable, version-tolerant signals rather than one exact class name:

- conversation route remains unchanged
- thread surface exists
- composer surface exists
- latest turn is mounted
- relevant turn/wrapper mutations have been quiet for a bounded interval
- logical wrapper count is stable across consecutive samples when native wrappers exist
- mounted turn count is stable across consecutive samples on older page shapes

Recommended initial policy:

- sample every 250 ms
- require three consecutive stable samples
- require 750-1000 ms of relevant mutation quiet time
- keep retrying after the initial timeout instead of declaring the page permanently
  ready

These values are starting points for diagnostics, not final product constants.

## Timeout Behavior

A timeout must fail safely:

- do not run automatic trim
- keep a pending request
- retry readiness after later mutations or follow-up checks
- expose the waiting reason through debug metrics

The timeout must not silently fall through to DOM deletion.

## Native Virtualization Awareness

When native turn wrappers are detected:

- treat wrapper count as logical rendered-history evidence
- treat inner configured selector count as mounted content only
- do not interpret inner unmount as conversation deletion
- do not automatically change the trim unit to the wrapper
- resync inventory after stable remount waves instead of on every intersection change

The runtime must distinguish:

1. logical turn wrapper added or removed
2. inner turn content mounted or unmounted
3. extension-hidden state
4. extension-deleted state

## Implemented Module Boundary

`load-readiness.ts` owns readiness state rather than growing `main.ts`.

It should own:

- readiness state
- relevant mutation timestamps
- stable sample counters
- native virtualization detection
- pending reason and timeout reason
- route reset and disposal

It should expose:

- `observeMutationBatch(...)`
- `requestCheck(reason)`
- `whenReady(callback, reason)`
- `getSnapshot()`
- `reset(reason)`
- `dispose()`

It must not execute trim or own UI.

## Current Implementation

- Observer attachment uses the route-scoped `#thread` surface.
- Route changes ignore stale turns and accept a new turn ID even if ChatGPT reuses the
  same thread element.
- Runtime tuning values and the v2 page contract are centralized in `constants.ts`.
- Empty virtualized turn shells are excluded from mounted-turn trimming.
- Turn-descendant hydration mutations reset the quiet window.
- Automatic and manual Apply trims queue until readiness.
- Show More restoration also queues until readiness.
- `hide → delete` no longer has a direct deletion path around the gate.
- Debug-only `forceTrim()` remains an explicit bypass and warns when readiness is false.

## Diagnostics And Validation

Add debug output for:

- readiness state and reason
- first turn/wrapper timestamp
- last relevant mutation timestamp
- stable sample count
- mounted turn count
- wrapper/intersection/placeholder counts
- queued trim reason

The code path is implemented. It still requires real-page validation on short, long,
route-changed, background-resumed, and streaming conversations before the load-stability
work is considered complete.

## Acceptance Criteria

- No automatic trim runs during initial conversation hydration.
- Route changes reset readiness and cancel stale callbacks.
- Native offscreen unmount/remount does not inflate removed counts.
- Manual Apply waits safely instead of deleting during hydration.
- Debug output explains why trimming is waiting.
- Existing activity and Long Task gates continue to work independently.
