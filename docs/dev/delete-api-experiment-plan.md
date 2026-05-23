# Delete API Experiment Plan

Date: 2026-05-23

This note defines the optional API/history-limiting experiment for `delete` mode.

The normal product still has only two cleanup modes:

- `hide`
- `delete`

This experiment is not a third mode. It is a future opt-in accelerator for `delete`
mode, and it must fail closed by returning ChatGPT responses unchanged whenever the
private response shape is not exactly understood.

## Position

The default runtime should stay conservative:

- selector diagnostics
- typing/activity guard
- initial-load and route-change follow-up trims
- DOM hiding or DOM deletion through the existing trim engine

API/history limiting should be explored only after the default runtime is easier to
reason about. It depends on private ChatGPT response structures and can affect frontend
conversation loading semantics, so it needs stronger guardrails than DOM hiding.

## Required Gates

The experiment must be:

- Off by default.
- Debug or experimental only.
- Scoped to `delete` mode.
- Exact-endpoint matched.
- GET-only.
- JSON-only.
- Session self-disabling on unexpected shape.
- Manually disableable through a debug hook.
- Logged with clear disable reasons when debug mode is enabled.

It must not:

- Touch streaming responses.
- Touch send-message or mutation requests.
- Make API limiting a normal product promise.
- Run in `hide` mode.
- Continue after a validation mismatch.

## Response Validation Contract

Before modifying any response, the parser must verify:

- Parsed value is a plain object.
- `mapping` is a plain object.
- `current_node` is a string key in `mapping`.
- The path from `current_node` toward the root can be walked without cycles.
- Retained nodes can be identified by stable keys.
- Parent and child links are internally consistent enough to reconstruct safely.
- The retained path includes at least the configured minimum number of recent message
  nodes.
- Unknown branches, missing nodes, cycles, unsupported payloads, or ambiguous structures
  are treated as mismatches.

Any mismatch returns the original response and disables the experiment for the current
page session.

## Fallback Behavior

- If request matching fails, do nothing.
- If cloning the response fails, return the original response.
- If parsing JSON fails, return the original response.
- If validation fails, return the original response and self-disable for the session.
- If reconstruction fails, return the original response and self-disable for the session.
- If a later debug signal suggests ChatGPT loading broke after a modified response, the
  manual disable hook must remain available.

## Response Preservation Requirements

When a response is modified:

- Preserve status.
- Preserve status text.
- Preserve headers as closely as possible.
- Preserve non-target responses exactly.
- Keep the modified body valid JSON.
- Avoid changing unrelated response fields.

## Runtime State Needed

Add a small experiment-state module before any fetch patch:

- enabled
- disabledForSession
- lastDisableReason
- originalResponsesPassedThrough
- responsesModified
- shapeMismatches
- reconstructionFailures
- selfDisableCount

Suggested debug hooks:

- `getDeleteApiExperimentState()`
- `disableDeleteApiExperiment(reason?)`

## Implementation Order

1. Finish selector diagnostics and any selector baseline decision.
2. Extract turn inventory from `main.ts`.
3. Add typing/activity guard.
4. Add initial-load and route-change follow-up trims.
5. Add experiment state and debug hooks, with no fetch patch yet.
6. Build fixture-based parser tests or fixture smoke scripts from captured response
   samples.
7. Prototype the fetch patch behind the experiment gate.
8. Manually test on long conversations with debug logging enabled.

## Acceptance Criteria

- Default install behavior is unchanged.
- `hide` mode behavior is unchanged.
- `delete` mode DOM deletion still works when the experiment is disabled.
- The experiment can self-disable without breaking ChatGPT page loading.
- Unexpected response shape returns the original response.
- Debug output clearly explains whether the experiment modified, skipped, or disabled
  itself.

