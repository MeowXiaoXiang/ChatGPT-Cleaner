# Selector Stability Notes

Date: 2026-05-29

This note records the current selector evidence for the v2 runtime line. It uses the
local ChatGPT capture under `research/` first, because that folder includes both rendered
HTML and downloaded bundle chunks from the current page shape.

## Sources

- `research/chatgpt.com.html`
- `research/bundle/*.js`
- `research/chatgpt-bundle-research-notes.md`

## Local HTML Evidence

The captured HTML includes rendered conversation turns, not only the SSR shell.

Observed counts from `research/chatgpt.com.html`:

- `section[data-turn-id]`: 8
- `article[data-turn-id]`: 0
- `data-testid="conversation-turn-*"`: 8
- `data-turn="user"`: 4
- `data-turn="assistant"`: 4
- `data-message-author-role="user"`: 4
- `data-message-author-role="assistant"`: 5
- `[content-visibility:auto]`: 8
- `id="thread"`: 1

The current turn root shape is:

```html
<section
  data-turn-id="..."
  data-turn-id-container="..."
  data-testid="conversation-turn-..."
  data-turn="user|assistant"
>
```

This means the current primary selector still works, but the existing fallback that only
matched `article[data-turn-id][data-turn]` did not cover this captured page shape.

## Bundle Evidence

The strongest bundle signal is in
`research/bundle/8b34dbc2-juezr0qyl4clei09.65818bdfe768.js`.

The bundle constructs turn roots as React `section` elements with these attributes:

- `data-turn-id`
- `data-turn-id-container`
- `data-testid`
- `data-scroll-anchor`
- `data-turn`

The same bundle also contains:

- direct lookup by `[data-turn-id="${CSS.escape(id)}"]`
- generated `conversation-turn-${...}` test IDs
- `document.getElementById("thread")`
- `[data-turn="user"]` lookups under the thread
- conditional `[content-visibility:auto]` and intrinsic-size classes

## Decision

Keep the primary selector unchanged:

```ts
[data-testid^="conversation-turn-"]
```

Update the fallback selector to include both current and older plausible turn roots:

```ts
section[data-turn-id][data-turn], article[data-turn-id][data-turn]
```

The fallback remains conservative because it requires both a stable turn ID and an
explicit `data-turn` role marker. It does not add broad selectors such as every
`[data-turn-id]`, so inner message or utility nodes should not be pulled into the trim
unit accidentally.

## Debug Follow-Up

`__ccxDebug.explainSelectors()` now reports:

- primary, fallback, and combined match counts
- broader page probes such as `#thread`, `[data-turn-id]`, `[data-turn]`,
  `[data-message-author-role]`, and conversation-related test IDs
- hidden and visible counts
- author distribution
- content-visibility signal count
- sampled turn attributes and candidate attributes when configured selectors miss

Use this on real pages before any broader selector work:

```js
__ccxDebug.explainSelectors()
```

If configured selector counts are `0`, inspect `probeCounts`:

- `turnIdCount` or `messageRoleCount` greater than `0` means ChatGPT still exposes
  usable conversation anchors, but the configured turn-root selector may need a
  narrower update.
- `threadCount` greater than `0` with no turn/message counts usually means the route
  shell is present but turns are not loaded or hydrated yet.
- all conversation probes at `0` usually means the current page is not a loaded
  conversation view, the page is still loading, or ChatGPT changed the DOM more
  substantially than the local capture shows.

Typing/activity validation is separate:

```js
__ccxDebug.explainActivity()
```

Focus the composer, type or start IME composition, and run the command immediately.
`active` or `composing` should become `true`, and `activeElementIsComposer` should
be `true` while focus is in ChatGPT's editor.

Recommended real-page spot checks:

- short conversation
- long conversation
- route navigation without full reload
- active or recently streaming conversation

No additional selector broadening should happen unless these debug reports show a
concrete mismatch.
