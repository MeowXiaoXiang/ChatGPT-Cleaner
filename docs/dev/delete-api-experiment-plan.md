# Delete API Experiment Plan

Updated: 2026-06-28

> [!IMPORTANT]
> Historical proposal for the unreleased `codex/v2` branch. The fetch/API experiment was
> not completed or released, and project development has been discontinued. Do not treat
> this file as an implementation commitment.

This note defines the optional API/history-limiting experiment for `delete` mode.

The product still has only two cleanup modes:

- `hide`
- `delete`

This experiment is not a third mode. It is an opt-in accelerator for `delete` mode.
Unexpected or ambiguous input must pass through unchanged and disable modification for
the current page session. This is fail-open for ChatGPT and fail-closed for the
experiment.

## Position

The default runtime should stay conservative:

- selector diagnostics
- typing/activity guard
- conversation load-readiness guard
- initial-load and route-change follow-up checks
- DOM hiding or deletion only after readiness is established

API/history limiting depends on private ChatGPT response structures and can affect
frontend conversation semantics. It needs stronger guardrails than DOM hiding. Native
turn virtualization also means DOM deletion is not a safe fallback while hydration is
still active.

## Required Gates

The experiment must be:

- Off by default.
- Debug or experimental only.
- Scoped to `delete` mode.
- Exact-endpoint matched.
- GET-only.
- JSON-only.
- Introduced through observe-only and dry-run phases first.
- Session self-disabling on unexpected or ambiguous shape.
- Manually disableable through a debug hook.
- Logged with clear skip and disable reasons when debug mode is enabled.

It must not:

- Touch streaming responses.
- Touch send-message or mutation requests.
- Make API limiting a normal product promise.
- Run in `hide` mode.
- Continue modifying responses after a validation mismatch.
- Filter mapping nodes solely to `user` and `assistant` roles.

## Compatibility Strategy

The parser should be tolerant of additive official changes:

- Preserve unknown top-level fields.
- Preserve unknown mapping-node fields.
- Accept additional message roles and content types.
- Do not require a fixed top-level key list.
- Do not require a top-level `root` field.

Tolerance applies to reading and preservation. It does not permit guessing when graph
relationships are ambiguous.

## Pre-Transform Validation

Before planning a modification, verify:

- Parsed value is object-like.
- `mapping` is object-like.
- `current_node` is a string key in `mapping`.
- The path from `current_node` toward the root is finite and acyclic.
- The original root can be discovered from mapping relationships.
- Retained nodes can be identified by stable mapping keys.
- Existing parent and child links are sufficiently consistent.
- The retained path includes the configured minimum number of recent conversational
  turns.
- System, tool, developer, hidden, and unknown-role nodes between retained turns can be
  preserved without interpretation.
- Unknown branches can be preserved or removed deterministically without dangling
  references.

Missing nodes, cycles, unsupported payloads, or ambiguous relationships are mismatches.

## Preservation Rule

When a node is retained:

- Start from its complete original object.
- Preserve unknown fields.
- Change only relationship fields required by the validated prune.
- Preserve non-user/assistant nodes on the retained path.
- Preserve the discovered original root identity.

Do not rebuild retained messages from a hand-written subset of known fields.

## Post-Transform Validation

Before constructing a replacement `Response`, verify the transformed payload again:

- `current_node` still resolves.
- The retained current-node path is finite and acyclic.
- Every retained `parent` reference resolves or is null only at the root.
- Every retained `children` reference resolves.
- Parent/child relationships agree in both directions where represented.
- No omitted mapping key remains referenced.
- The retained conversational turn target is satisfied.

If post-transform validation fails, return the original response and self-disable.

## Fallback Behavior

- If request matching fails, do nothing.
- If cloning or parsing fails, return the original response.
- If validation or reconstruction fails, return the original response and self-disable.
- If a later signal suggests ChatGPT loading broke, the manual disable hook remains
  available and subsequent responses pass through unchanged.

## Response Preservation Requirements

When a response is modified:

- Preserve status and status text.
- Preserve headers as closely as possible.
- Remove only body-length/encoding headers invalidated by reconstruction.
- Preserve non-target responses exactly.
- Keep the modified body valid JSON.
- Avoid changing unrelated response fields.

## Runtime State Needed

Add a small experiment-state module before any response replacement:

- enabled
- mode (`observe`, `dry-run`, `modify`)
- disabledForSession
- lastDisableReason
- originalResponsesPassedThrough
- observeOnlyResponses
- dryRunCandidates
- responsesModified
- shapeMismatches
- reconstructionFailures
- postTransformValidationFailures
- selfDisableCount

Suggested debug hooks:

- `getDeleteApiExperimentState()`
- `disableDeleteApiExperiment(reason?)`

## Implementation Order

1. Complete selector and native-wrapper diagnostics.
2. Complete and validate the conversation load-readiness gate.
3. Add experiment state and debug hooks, with no fetch patch yet.
4. Add a page-world observe-only classifier that never replaces responses.
5. Build sanitized structural fixtures from offline sample payloads.
6. Implement pure path analysis and fixture validation.
7. Add dry-run reports showing what would be retained and removed.
8. Implement reconstruction plus post-transform validation.
9. Prototype response replacement behind the opt-in experiment gate.
10. Test short, long, branched, tool-heavy, and streaming conversations.

## Acceptance Criteria

- Default install behavior is unchanged.
- `hide` mode behavior is unchanged.
- Observe-only mode cannot alter ChatGPT responses.
- Additive unknown fields and roles are preserved rather than rejected unnecessarily.
- System, tool, hidden, and unknown-role nodes on the retained path are not discarded.
- Unexpected or ambiguous shape returns the original response and self-disables.
- Debug output explains whether a response was observed, skipped, dry-run planned,
  modified, or caused session disablement.
