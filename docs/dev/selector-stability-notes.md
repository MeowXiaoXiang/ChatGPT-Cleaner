# Selector Stability Notes

Updated: 2026-06-28

> [!IMPORTANT]
> Historical selector note for the unreleased `codex/v2` branch. It records the page
> shape that led to discontinuing the project and is not an active compatibility target.

This note records the public selector decisions for the v2 runtime and omits private
evidence detail.

## Development Scope

The development docs should contain:

- stable DOM conclusions
- selector acceptance criteria
- diagnostic procedures
- implementation decisions

## Mounted Turn Root

Current local evidence still shows mounted conversation turns as `section` elements
with all of these attributes:

```html
<section
  data-turn-id="..."
  data-turn-id-container="..."
  data-testid="conversation-turn-..."
  data-turn="user|assistant"
>
```

Keep the primary selector unchanged:

```ts
[data-testid^="conversation-turn-"]
```

Keep the conservative fallback:

```ts
section[data-turn-id][data-turn]
```

v2 does not retain the older `article` compatibility branch. The fallback intentionally
requires both a stable turn ID and an explicit turn role. Do not broaden it to every
`[data-turn-id]`, generic `section`, `article`, or `div`.

## Native Turn Virtualization

Current ChatGPT builds can wrap logical turns in an outer element with:

- `data-turn-id-container`
- `data-is-intersecting`

Older offscreen turn content can be unmounted while the outer wrapper preserves an
estimated height. Recent, intersecting, or forced turns remain mounted.

Consequences:

- Configured selector counts describe mounted turn sections, not total logical history.
- A normal scroll can remove and later recreate a matching turn section.
- A mounted-section removal is not necessarily a conversation deletion.
- The outer wrapper is evidence for diagnostics and load readiness, but it is not yet an
  accepted trim/delete unit.

Do not switch the trim selector to the outer wrapper until load stability, scroll
geometry, restoration semantics, and React ownership have been tested separately.

## Native Content Visibility

Assistant turns may also receive conditional native `content-visibility:auto` and an
intrinsic-size class. This signal is feature- and state-dependent, so it may be present
in one build while absent from a particular rendered DOM sample.

Extension CSS should coexist with native optimization. Do not blanket-override native
content visibility or intrinsic sizing.

## Composer Activity Surface

The v2 page contract uses the current prompt surfaces:

- `#prompt-textarea`
- `textarea[name="prompt-textarea"]`
- editable content inside `form[data-type="unified-composer"]`

Generic text/search inputs are intentionally excluded so sidebar search does not satisfy
conversation readiness or activity detection.
- IME composition
- paste, input, keydown, and focus activity

## Debug Follow-Up

`__ccxDebug.explainSelectors()` currently reports mounted selector matches and broader
page probes. Interpret those counts as mounted DOM inventory only.

The diagnostics additionally report:

- native wrapper count
- intersecting wrapper count
- placeholder wrapper count
- mounted configured-turn count
- whether native turn virtualization is detected
- current load-readiness state

Use the current helpers on representative pages:

```js
__ccxDebug.explainSelectors()
__ccxDebug.explainActivity()
__ccxDebug.dumpInventory()
```

Recommended spot checks:

- short conversation
- long conversation at the bottom
- scrolling far enough to unmount and remount old turns
- route navigation without full reload
- active or recently streaming conversation
- hide mode and delete mode separately

No selector broadening should happen unless diagnostics show a concrete mismatch. A
load-readiness problem must not be solved by matching more nodes.
