# Monitor Redesign Notes

> Archived note: the in-page monitor panel was removed in the v2 cleanup track.
> Runtime diagnostics now live behind the console-only `__ccxDebug` API.
> Keep this file only as historical design context.

## Goal

Simplify the current monitor panel into a lightweight status panel.

The old monitor behaves too much like a mini analytics dashboard:

- dynamic chart
- hover loop
- legend toggles
- resize handling
- richer rendering cost than needed

For this project, the monitor should help answer:

- Is the page currently under pressure?
- Is the cleaner currently running or suspended?
- Roughly how expensive is trimming itself?
- How much content has been processed so far?

It should **not** try to be a long-range analysis tool.

---

## Direction

Replace the current chart-heavy monitor with a compact translucent panel.

Keep:

- translucent floating panel style
- close button
- live numeric updates
- status chip
- processed-count chip

Remove:

- canvas chart
- hover tooltip
- legend
- trend/history visualization
- chart redraw loop
- hover `requestAnimationFrame` loop
- resize handle
- threshold details section
- extra settings/stat blocks

---

## Proposed Layout

```text
┌──────────────────────────────────────────────────────────┐
│ Chat Cleaner                                       [×]  │
│                                                          │
│ ┌──────────────┐  ┌──────────────┐  ┌──────────────┐    │
│ │ LT Avg       │  │ LT Rate      │  │ Trim Avg     │    │
│ │ 24.0 ms      │  │ 0.18 /s      │  │ 12.4 ms      │    │
│ └──────────────┘  └──────────────┘  └──────────────┘    │
│                                                          │
│ [ Removed 128 ]                         [ ✨ RUNNING ]   │
└──────────────────────────────────────────────────────────┘
```

---

## Information Architecture

### Top row: three metric cards

Keep these three values visible:

1. `LT Avg`
   - Meaning: average duration of detected long tasks
   - Purpose: indicates severity of page-side main-thread pressure

2. `LT Rate`
   - Meaning: number of long tasks per second
   - Purpose: indicates pressure frequency / density

3. `Trim Avg`
   - Meaning: average cost of the cleaner's own trim work
   - Purpose: shows whether the extension itself is becoming expensive

Reason to keep all three:

- `LT Avg` and `LT Rate` describe page pressure
- `Trim Avg` describes extension cost
- removing `Trim Avg` would hide the most direct signal of self-overhead

---

## Bottom row: two chips

### Left chip

Single processed-count chip.

Default label:

- `Removed 128`

Notes:

- Use one wording only
- Do not switch between `Removed` / `Deleted` / `Hidden`
- Purpose is cumulative result visibility, not mode explanation

### Right chip

Single runtime status chip.

States:

- `Running`
- `Suspend`

Optional icon style:

- `✨ Running`
- `⚡ Suspend`

Purpose:

- communicate current gate/runtime state at a glance

---

## What should not be shown

Do not show these in the redesigned default monitor:

- mode (`hide` / `delete`)
- max keep
- debounce delay
- threshold values
- enter/exit gate numbers
- historical trend graph

Reason:

- these are implementation/debug details
- they increase cognitive load
- they are not essential for day-to-day status checking

If needed later, such information can be exposed only in debug mode, not in the main monitor UI.

---

## Design Principles

1. Status-first, not analytics-first
2. Readable in one glance
3. Low rendering overhead
4. No interaction that creates continuous redraw pressure
5. Keep visual style, remove diagnostic excess

---

## Implementation Intent

When rebuilding `src/content/monitor.ts`, prefer:

- plain DOM updates
- no canvas
- no hover-driven loops
- no resize subsystem
- minimal event listeners
- fixed compact layout

This redesign should make the monitor feel like a lightweight runtime badge panel rather than a mini performance console.
