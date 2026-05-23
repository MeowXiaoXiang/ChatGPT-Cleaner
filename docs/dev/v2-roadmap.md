# v2 Roadmap

This document tracks the v2 cleanup and improvement line on `codex/v2`.

The goal of v2 is to improve runtime stability, diagnostics, and maintainability before making visible UI changes. UI redesign and any fetch/API-level experiment are intentionally placed late because they require separate product decisions.

Architecture note:

- See `docs/dev/architecture-assessment.md`.

## V2 Design Scope

V2 should clarify what this extension wants to be before adding new behavior.

The product scope stays small:

- Keep only two user-facing cleanup modes:
  - `hide`
  - `delete`
- Keep `hide` conservative and restorable.
- Keep current DOM deletion as the baseline `delete` behavior.
- Improve runtime safety around the existing behavior:
  - selector evidence
  - typing/activity guard
  - initial-load and route-change follow-up trims
  - clearer debug diagnostics
- Refresh the normal UI after runtime status data is stable.
- Consider delete-mode API/history limiting only as an opt-in experiment.

Reference implementations may inspire design choices, but they are not part of the
product plan and should not become implementation dependencies.

Explicit non-goals:

- Do not add a third cleanup mode.
- Do not make API/history limiting default behavior.
- Do not add scroll-driven history reveal behavior.
- Do not adopt external extension code or architecture wholesale.
- Do not redesign UI and runtime behavior in the same change.

## Guiding Rules

- Keep `main` stable; v2 work happens on `codex/v2`.
- Prefer small, focused commits directly on `codex/v2`.
- Keep behavior changes isolated in their own commits so regressions are easy to trace.
- Do not add fetch/API response limiting in early phases.
- Do not broaden selectors without diagnostic evidence.
- Avoid UI changes until runtime stability work has a clear baseline.

## Commit Policy

Use focused commits directly on `codex/v2` for documentation, diagnostics, internal
cleanup, and planned v2 runtime work.

Separate commits by responsibility:

- documentation and planning
- behavior-preserving architecture extraction
- selector behavior changes
- scheduling behavior changes
- UI behavior or styling changes
- optional experiments

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

- `pnpm typecheck` passes.
- `pnpm build` passes.
- Manual debug API smoke test passes on ChatGPT.

## Phase 1 - Selector Stability Baseline

Purpose: understand current selector behavior before changing selectors.

Integration policy: documentation and observation notes can be committed directly on
`codex/v2`; any selector code change should be isolated in its own focused commit.

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

Integration policy: focused commit on `codex/v2`.

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

Integration policy: focused commit on `codex/v2`.

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

Integration policy: focused commit on `codex/v2` if runtime data flow changes; direct
documentation commit is acceptable only for design notes.

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

Integration policy: focused commit on `codex/v2`.

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

Integration policy: focused commit on `codex/v2`.

Reason for late placement: visual direction has more subjective tradeoffs and should not block runtime hardening.

Candidate work:

- Reduce explanatory text in the panel.
- Use compact controls and clearer hierarchy.
- Keep advanced/debug information out of normal UI.

Non-goals:

- Do not change core cleanup behavior as part of visual styling.

## Phase 7 - Optional Fetch/API Experiment

Purpose: evaluate whether API-level history limiting is worth a separate experimental track.

Integration policy: focused commit on `codex/v2`; never implement this experiment without
a separate design note first.

Reason for last placement: this is the highest-risk area because it depends on ChatGPT's private response shape and can affect conversation loading semantics.

Design note:

- See `docs/dev/delete-api-experiment-plan.md`.

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

1. Commit the current planning docs.
2. Run selector diagnostics on several real ChatGPT conversations.
3. Record findings in a `docs/dev/selector-stability-notes.md` file.
4. Decide whether `section[data-turn-id]` should join the supported selector set.
5. Do a small behavior-preserving architecture extraction, starting with turn inventory.
6. Implement the Phase 2 typing/activity guard.

After Phase 2 and Phase 3 are stable, revisit the optional delete-mode API/history
limiting experiment in `docs/dev/delete-api-experiment-plan.md`.
