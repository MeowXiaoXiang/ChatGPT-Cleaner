# v2 Roadmap

This document tracks the v2 cleanup and improvement line on `codex/v2`.

The goal of v2 is to improve runtime stability, diagnostics, and maintainability before making visible UI changes. UI redesign and any fetch/API-level experiment are intentionally placed late because they require separate product decisions.

## Guiding Rules

- Keep `main` stable; v2 work happens on `codex/v2`.
- Prefer small commits directly on `codex/v2` for low-risk internal cleanup.
- Use feature branches and PRs into `codex/v2` for behavior changes, UI changes, or high-risk runtime work.
- Do not add fetch/API response limiting in early phases.
- Do not broaden selectors without diagnostic evidence.
- Avoid UI changes until runtime stability work has a clear baseline.

## Branch / PR Policy

Use commits directly on `codex/v2` for documentation, diagnostics, and low-risk internal cleanup.

Use a feature branch plus PR into `codex/v2` when the change affects runtime behavior, user-visible UI, selector behavior, scheduling, or any experiment that may need review or rollback.

Suggested feature branch format:

```text
codex-v2-selector-stability
codex-v2-typing-guard
codex-v2-initial-load-trims
codex-v2-status-ui
```

Only open a PR into `main` when the v2 track is ready to become the release line.

## Phase 0 - Diagnostics Foundation

Status: Done.

Integration policy: direct commits on `codex/v2`.

Purpose: remove the old monitor UI and establish console-only diagnostics.

Completed:

- Removed the in-page monitor panel.
- Added `src/content/debug.ts`.
- Exposed `__ccxDebug` only when `ccx_debug=1`.
- Added runtime reports:
  - `getMetrics()`
  - `report()`
  - `forceTrim()`
  - `dumpInventory()`
  - `explainSelectors()`
  - `watchMetrics()`
  - `stopWatch()`
- Updated agent and development docs.

Acceptance baseline:

- `yarn typecheck` passes.
- `yarn build` passes.
- Manual debug API smoke test passes on ChatGPT.

## Phase 1 - Selector Stability Baseline

Purpose: understand current selector behavior before changing selectors.

Integration policy: documentation and observation notes can be direct commits on `codex/v2`; any selector code change requires a feature branch and PR into `codex/v2`.

Work:

- Use `__ccxDebug.explainSelectors()` on representative ChatGPT pages.
- Record which selector path is active:
  - primary selector count
  - fallback selector count
  - combined selector count
  - sample element shape
- Confirm sampled nodes are full conversation turn roots, not inner message bubbles.
- Define criteria for accepting any new fallback selector.

Expected output:

- A short selector stability note in `docs/dev/`.
- No runtime selector changes unless the evidence shows a concrete problem.

Non-goals:

- Do not add broad fallback selectors yet.
- Do not change trim/delete units yet.

## Phase 2 - Runtime Interaction Guard

Purpose: reduce interference while the user is actively typing or interacting with the composer.

Integration policy: feature branch and PR into `codex/v2`.

Candidate work:

- Add a lightweight typing/activity guard.
- Delay automatic trim while recent text input is detected.
- Keep manual actions working:
  - Apply should still schedule trim.
  - `__ccxDebug.forceTrim()` should still run immediately.
- Keep the guard independent from LongTask suspension.

Design questions to resolve before implementation:

- Typing cooldown duration.
- Which input surfaces count as composer activity.
- Whether paste/composition events need explicit handling.

Non-goals:

- Do not change delete/hide semantics.
- Do not add UI settings for this guard in the first pass.

## Phase 3 - Initial Load Follow-Up Trims

Purpose: handle long conversations that render in waves after initial load or route changes.

Integration policy: feature branch and PR into `codex/v2`.

Candidate work:

- Schedule a small number of follow-up trim checks after observer init and route changes.
- Keep the schedule conservative and cancellable.
- Respect existing LongTask suspension and wake cooldown behavior.
- Log scheduling only under debug mode.

Design questions to resolve before implementation:

- Exact delay sequence.
- Whether delete mode and hide mode should share the same follow-up schedule.
- How follow-up trims interact with `maxObservedTurnCount` in hide mode.

Non-goals:

- Do not add fetch/API limiting.
- Do not force immediate bulk delete during heavy page load.

## Phase 4 - Runtime Metrics For Product UI

Purpose: prepare stable status data before changing the visible UI.

Integration policy: feature branch and PR into `codex/v2` if runtime data flow changes; direct commit is acceptable only for design notes.

Candidate work:

- Define a small internal status snapshot for user-facing display later.
- Reuse existing inventory and metrics where possible.
- Keep this as data plumbing only; do not redesign the panel yet.

Potential snapshot fields:

- mode
- maxKeep
- visibleCount
- hiddenCount
- removedCount
- suspended
- lastTrim result or timestamp, if already available cheaply

Non-goals:

- Do not redesign the panel in this phase.
- Do not introduce new user settings.

## Phase 5 - Main UI Status Refresh

Purpose: make the cleaner's result visible without using debug tools.

Integration policy: feature branch and PR into `codex/v2`.

Reason for late placement: UI direction needs separate product decisions and should use stable runtime status data from earlier phases.

Candidate work:

- Add a compact status area to the main panel.
- Show the minimum useful result:
  - visible
  - hidden or removed
  - running or paused
- Replace the mode select with a clearer control only if the broader panel direction is settled.

Non-goals:

- Do not reintroduce a monitor panel.
- Do not show developer metrics such as LongTask rate in normal UI.

## Phase 6 - UI Style Refresh

Purpose: make the extension feel quieter and closer to ChatGPT's native utility surfaces.

Integration policy: feature branch and PR into `codex/v2`.

Reason for late placement: visual direction has more subjective tradeoffs and should not block runtime hardening.

Candidate work:

- Reduce explanatory text in the panel.
- Use compact controls and clearer hierarchy.
- Keep advanced/debug information out of normal UI.

Non-goals:

- Do not change core cleanup behavior as part of visual styling.

## Phase 7 - Optional Fetch/API Experiment

Purpose: evaluate whether API-level history limiting is worth a separate experimental track.

Integration policy: feature branch and PR into `codex/v2`; never direct commit to `codex/v2` without a separate design note first.

Reason for last placement: this is the highest-risk area because it depends on ChatGPT's private response shape and can affect conversation loading semantics.

Default decision:

- Do not implement fetch/API response limiting in v2 foundation work.
- If explored later, it must be:
  - off by default
  - debug or experimental only
  - delete-mode scoped
  - easy to disable
  - documented as affecting frontend-loaded history only

Non-goals:

- Do not make fetch/API limiting a default product promise.
- Do not mix it with selector, typing guard, or UI work.

## Current Next Step

Recommended next action:

1. Run selector diagnostics on several real ChatGPT conversations.
2. Record findings in a `docs/dev/selector-stability-notes.md` file.
3. Decide whether selector changes are actually needed.

If runtime behavior feels stable, the next code change should likely be Phase 2: typing/activity guard.
