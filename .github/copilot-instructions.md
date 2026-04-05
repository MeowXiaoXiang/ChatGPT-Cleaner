# ChatGPT Cleaner - AI Coding Agent Instructions

## Project Overview

**ChatGPT Message Cleaner** is a Chrome Manifest v3 extension that reduces DOM pressure on ChatGPT conversations by hiding or removing older messages. It uses idle-time processing, adaptive throttling, and load protection to maintain smooth UX.

## Architecture

### Core Modules (all in `src/content/`)

-   **constants.ts**: Centralized tunable parameters. All timing thresholds, batch sizes, debounce delays, and UI limits defined here for easy tuning.
-   **main.ts**: Entry orchestrator. Manages lifecycle, performance gating (Long Task detection), adaptive scheduling (EMA-based delays), and coordinates all modules.
-   **trim-engine.ts**: Implements hide/restore/delete operations. Features adaptive batch deletion using idle callbacks with dynamic chunk sizing (6-20ms target).
-   **observer.ts**: MutationObserver wrapper with route change detection, internal UI filtering, and rAF batching to coalesce mutations within a single frame.
-   **ui.ts**: Pure UI components—floating ball control panel, toast notifications (with deduplication/accumulation), tooltip system, and "Show More" button.
-   **monitor.ts**: Lightweight monitoring panel with real-time metrics. Pure display panel, opened from the in-page UI button.
-   **dom-utils.ts**: Low-level DOM utilities for marking/unmarking hidden elements, safe selectors, and style injection.
-   **idle-utils.ts**: `requestIdleCallback` ponyfill for cross-browser compatibility.
-   **types.ts**: Centralized TypeScript definitions—no logic, just interfaces.

### Background Script

-   **background.ts**: Badge management only. Toggles `ccx_enabled` in localStorage (ISOLATED world) and reloads tabs. No content coordination.

### Build & Development

-   **esbuild.config.mjs**: Custom build script with watch mode. Uses `afterBuildPlugin.onEnd` to copy statics (`manifest.json`, `_locales`, `icons`, `styles`) after each build. Outputs to `dist/`.
-   **TypeScript**: ES2023 target, strict mode, bundled via esbuild as IIFE for content/background.

## Key Patterns & Conventions

### 1. LocalStorage Feature Flags

All user settings stored in `localStorage`:

-   `ccx_enabled`: `"0"` disables the extension (default: enabled)
-   `ccx_debug`: `"1"` enables console logging only (Monitor panel is always available)
-   `ccx_max_keep`: Number of recent messages to keep (default: 25)
-   `ccx_notify`: `"0"` disables toast notifications
-   `ccx_mode`: `"hide"` (restorable) or `"delete"` (permanent DOM removal)

**Background** writes these via ISOLATED world; **content script** reads them at startup.

### 2. Performance & Throttling

-   **StormGate** (main.ts): Monitors Long Tasks via PerformanceObserver. Tracks task density (tasks/second) and average duration (EMA α=0.25). Suspends deletion when system is busy.
-   **Adaptive Debouncing**: `debounce.delay` ranges from 80-600ms based on trim operation average time. Steps up/down dynamically:
    -   `> 32ms avg` → increase delay (約 2 幀@60fps)
    -   `< 8ms avg` → decrease delay
    -   Threshold for "slow": `> 16ms` (約 1 幀@60fps)
-   **Batch Deletion**: Uses `requestIdleCallback` with adaptive chunk size (5-100 nodes):
    -   Target: 6-20ms per chunk
    -   Dynamically adjusts based on actual slice timing
-   **Mutation Throttling**: Minimum 300ms interval between trim operations to prevent excessive processing during scroll loading.

### 3. DOM Marking (not Mutation)

-   **Hide mode**: Elements get `aria-hidden="true"`, `inert`, and classes `.HIDDEN`, `.INERT` but remain in DOM. **No automatic restoration** - only user-triggered via "Show More" button.
-   **Delete mode**: Elements are removed via `.remove()` after marking (defensive coding).
-   **Restoration**: Only works in hide mode—calls `unmarkHidden()` to reverse attributes/classes. Triggered explicitly by user action.

### 4. Internal UI Filtering

Observer ignores mutations within `.ccx-ui`, `.ccx-toast-container`, `.ccx-showmore-wrap`, `#ccx-monitor` to prevent self-triggering. Filter applied in `observer.ts` via `recordIsInternalOnly()`.

### 5. Internationalization

-   Uses Chrome i18n API via `chrome.i18n.getMessage(key)` with fallback in `createI18n()`.
-   Messages stored in `src/_locales/{en,zh_CN,zh_TW}/messages.json`.
-   Extension name/description use `__MSG_extName__` placeholders in manifest.

### 6. Route Change Detection

`observer.ts` installs multiple watchers:

-   `history.pushState` / `history.replaceState` monkey-patching
-   `hashchange` / `popstate` events
-   MutationObserver on `<title>` and URL-related meta tags
-   All trigger rebind with 80ms throttle to handle SPA navigation.

## Development Workflow

### Setup & Build

> **Recommended**: Use **Yarn 4 + Corepack + PnP** for dependency management:
>
> ```bash
> corepack enable
> corepack prepare yarn@4.12.0 --activate
> ```

```bash
# Install dependencies
yarn install

# Development (watch mode)
yarn dev

# Production build
yarn build

# Type checking only
yarn typecheck

# Package for distribution
yarn zip
```

### Loading Extension

1. Build project: `yarn build`
2. Open `chrome://extensions`
3. Enable "Developer mode"
4. Click "Load unpacked", select `dist/` folder

### Debugging

Enable debug logging:

```javascript
localStorage.setItem("ccx_debug", "1");
location.reload();
```

Logs appear as `[chat-cleaner] ...` in console.

**Performance Monitor Panel**: Always available via the 📊 button in the UI panel. Shows real-time performance stats, trimmer state, and thresholds. The panel itself exposes no global API.

**Debug Commands**: Only available when `ccx_debug=1`. Use `__ccxDebug.getMetrics()` and `__ccxDebug.forceTrim()`.

### Testing Changes

-   **Content Scripts**: Modify source → `yarn dev` auto-rebuilds → reload ChatGPT tab
-   **Background**: Requires extension reload at `chrome://extensions`
-   **Manifest/Statics**: Auto-copied by build script's `afterBuildPlugin.onEnd`

## Critical Implementation Details

### Why IIFE Format?

esbuild config specifies `format: "iife"` because Chrome extensions don't support ES modules in service workers/content scripts (Manifest v3 limitation).

### Why No Direct DOM Selector Constants?

ChatGPT's DOM structure changes frequently. Selectors in `main.ts`:

```typescript
const SELECTORS = {
	LIST: '[data-testid^="conversation-turn-"]',
	ALL: '[data-testid^="conversation-turn-"], article[data-turn-id][data-turn]',
};
```

Use resilient prefix matching (`^=`) instead of exact matches. The backup selector `article[data-turn-id][data-turn]` uses the UUID-based `data-turn-id` attribute introduced in 2025.

### ChatGPT DOM Structure Reference (2025/12)

Each conversation turn is an `<article>` element:

```html
<article
	data-testid="conversation-turn-3"
	data-turn-id="bbb213ee-c303-4d81-..."
	<!--
	UUID,
	new
	in
	2025
	--
>
	data-turn="user|assistant" data-scroll-anchor="false" >
</article>
```

-   Parent container: `div.flex.flex-col.text-sm.pb-25`
-   Message content: `div[data-message-author-role]`, `div[data-message-id]`

### Why requestAnimationFrame in Observer?

MutationObserver can fire hundreds of times per second during heavy DOM updates. rAF batching (in `observer.ts`) ensures upstream `onMutation` callback fires at most once per frame, reducing scheduling overhead.

### Why Separate Hide/Delete Modes?

-   **Hide**: Fast, reversible, good for casual cleanup. Messages stay in memory.
-   **Delete**: Frees DOM memory, essential for 1000+ message conversations. Irreversible within session.

User can toggle via UI panel. Settings persist to localStorage.

## Common Tasks

### Adding a New Locale

1. Create `src/_locales/{locale}/messages.json` (copy from `en/`)
2. Translate all message values
3. Rebuild—esbuild copies to `dist/_locales/`

### Adjusting Tunable Parameters

All tunable constants are centralized in `constants.ts`. Key sections:

```typescript
// Debounce delays (adaptive scheduling)
DEBOUNCE.DELAY_MIN = 80;   // minimum delay between trim ops
DEBOUNCE.DELAY_MAX = 600;  // maximum delay under load

// Trim thresholds (performance gating)
TRIM_THRESHOLD.SLOW_MS = 16;     // ~1 frame @ 60fps
TRIM_THRESHOLD.STEP_UP_MS = 32;  // increase delay if avg > this
TRIM_THRESHOLD.STEP_DOWN_MS = 8; // decrease delay if avg < this

// Batch deletion (idle-time chunking)
BATCH.CHUNK_MIN = 5;         // minimum nodes per batch
BATCH.CHUNK_MAX = 100;       // maximum nodes per batch
BATCH.SLICE_UPPER_MS = 20;   // slow → reduce batch size
BATCH.SLICE_LOWER_MS = 6;    // fast → increase batch size
```

### Modifying UI Panel

All UI lives in `ui.ts`. Panel structure:

-   `.ccx-ui-container`: floating ball trigger
-   `.ccx-panel`: settings panel (keep count, mode, notify toggle)
-   `.ccx-toast-container`: notification area (max 4 visible)
-   `.ccx-showmore-wrap`: "Show More" button (only visible in hide mode)

**Show More Button Design**: Uses GPT-inspired pill shape with light green background (#e8f5e9), distinguishable from official GPT buttons. Includes ▲ arrow icon for clarity.

CSS in `src/styles/content.css`.

## Code Style

-   **Comments**: Bilingual headers (Chinese + English) at top of each file
-   **Naming**: camelCase for functions/variables, SCREAMING_SNAKE_CASE for constants
-   **Types**: Prefer explicit types from `types.ts` over inline definitions
-   **Logging**: Use `log()` function (only fires if `DEBUG` flag set)
-   **Error Handling**: Wrap risky operations in try-catch, fail silently with log

## Files to Never Edit Directly

-   `dist/**`: Generated by build process
-   `build-info.json`: Auto-written by esbuild config
-   `node_modules/**`: Managed by package manager

## External Dependencies

None at runtime. DevDependencies:

-   `esbuild`: Bundler
-   `typescript`: Type checking
-   `@types/chrome`: Chrome API types
-   `cross-env`, `archiver`, `rimraf`: Build utilities

## Gotchas

1. **Manifest must be in `dist/`**: Extension loads from `dist/`, not `src/`. Always build before testing.
2. **Background service worker limitations**: Can't use DOM APIs. Communicate via `chrome.scripting.executeScript`.
3. **ISOLATED world**: Background scripts inject code in ISOLATED world to access localStorage. Content scripts run in MAIN world by default.
4. **ChatGPT DOM volatility**: Test selector changes frequently. Use DevTools to verify current structure.
5. **Long Task API**: Not all browsers expose PerformanceObserver for longtask. Graceful degradation in `main.ts`.

---

**For questions on architecture decisions, check inline comments in `src/content/main.ts` (Chinese/English headers).**
