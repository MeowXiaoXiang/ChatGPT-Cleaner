# ChatGPT Message Cleaner

**🌐 Languages:** [English](./README.md) | [繁體中文](./docs/README_zh-TW.md)

> [!WARNING]
> **This project is discontinued and is no longer recommended for use.**
>
> ChatGPT now includes native conversation virtualization. It keeps lightweight
> placeholders for the full conversation, renders only a small window of messages near
> the viewport, and loads older message content again as the user scrolls. Live testing
> confirmed that this built-in behavior now covers the core performance problem this
> extension was created to address.
>
> Because this extension directly hides or removes message elements, it can now compete
> with ChatGPT's own rendering system during scrolling. This may cause repeated work,
> higher main-thread load, unstable scrolling, or failed content rendering. The store
> listings are being withdrawn, and this repository is retained only as an archived
> technical reference.

<!-- markdownlint-disable MD033 -->

<p align="center">
  <img src="src/icons/chat-icon.svg" width="128" height="128" alt="icon" />
</p>
<!-- markdownlint-enable MD033 -->

Former ChatGPT conversation cleaner, retained as an archived technical reference.

![status](https://img.shields.io/badge/status-discontinued-B91C1C)
![branch](https://img.shields.io/badge/branch-unreleased_v2-64748B)
![Manifest v3](https://img.shields.io/badge/Manifest-v3-334155)
![TypeScript](https://img.shields.io/badge/TypeScript-6.0-3178C6?logo=typescript)
![License](https://img.shields.io/badge/License-MIT-10B981)

---

## Project Status

New installations are no longer recommended. The Chrome Web Store and Microsoft Edge
Add-ons listings are being withdrawn as part of the project shutdown.

Everything below is retained as historical documentation for the unreleased v2 branch.

## Historical Features

* **Cleaning Modes:**
  * **Hide**: Remove older messages from view but keep in DOM, restorable anytime
  * **Delete**: Completely remove from DOM (`Element.remove()`), especially helpful for extremely long conversations
* **Load Protection**: Detects high task density and average processing time, automatically pauses when busy
* **Idle Processing**: Uses idle time for processing with dynamic batch size adjustment
* **Auto Speed Control**: Adaptive delays based on average processing time
* **Show Previous**: Quickly restore older content when needed
* **Multi-language**: en / zh-TW / zh-CN

## Screenshot

<!-- markdownlint-disable MD033 -->
<p align="center">
  <img src="docs/demo.png" alt="ChatGPT Message Cleaner Demo" width="800" />
</p>
<!-- markdownlint-enable MD033 -->

---

## Scope & Design Considerations

This tool focuses on "frontend view layer throttling and organization" by reducing visible elements and DOM pressure to improve perceived smoothness, while respecting the site's own mechanisms. The following scenarios are not directly covered, and improvement may vary depending on site design:

* Model/network inherent latency
* Global state, virtual lists, tracking scripts, and other non-DOM costs within the site
* Server-side conversation length, sync/cache, or non-DOM memory usage

**Design Highlights:**

* **Hide**: Nodes remain in DOM but visual and interaction are removed (`aria-hidden`, `inert`), can be quickly restored
* **Delete**: Nodes are removed from DOM (`Element.remove()`), can free DOM memory; actual effect still depends on overall site behavior
* **Load Protection**: Detects busy periods and pauses, resumes and retries after recovery

In short: This tool is a "frontend view layer organizer" that tries not to conflict with complex internal site mechanisms and doesn't touch your account/cloud data. If the conversation itself is extremely large or the site is under heavy load, you may still experience lag.

---

## Historical Development Setup (Do Not Install for Normal Use)

1. Get the code and install dependencies (pnpm via Corepack)

    ```bash
    git clone https://github.com/MeowXiaoXiang/ChatGPT-Message-Cleaner.git
    cd ChatGPT-Message-Cleaner

    # Enable Corepack and install the pnpm version pinned by this repo
    corepack enable
    corepack install
    pnpm install
    ```

2. Build (outputs to dist/)

    ```bash
    pnpm build
    ```

3. Load in Chrome (Extensions → Developer mode → Load unpacked)

    * Open chrome://extensions
    * Enable "Developer mode"
    * Click "Load unpacked", select the `dist/` folder

> This project officially uses pnpm 10 + Corepack and commits `pnpm-lock.yaml`.
>
> For development, use `pnpm dev` to enter watch mode (automatically rebuilds and copies static resources to dist).

---

## Historical Usage

* **Toolbar Button**: Click to toggle enable/disable (badge shows ON/OFF)
* **Floating Ball (bottom right)**: Click to open panel settings for Keep up to / Mode (Hide or Delete) / Notifications
* **Hide Mode**: "Show previous" button appears at the top of conversations to restore older messages

---

## Project Structure

```text
│  .gitignore              # Git ignore rules
│  esbuild.config.mjs      # Esbuild bundling configuration
│  LICENSE                 # License (MIT)
│  package.json            # Package and script definitions
│  README.md               # Project documentation
│  tsconfig.json           # TypeScript compilation settings
│
├─scripts                  # Helper scripts
│      zip.js              # Package dist/ into zip
│
├─src
│  │  manifest.json        # Chrome extension configuration (Manifest v3)
│  │
│  ├─background            # Background service
│  │      background.ts
│  │
│  ├─content               # Frontend injection scripts
│  │      constants.ts     # Centralized tunable parameters
│  │      activity-guard.ts # Delays automatic trims while the composer is active
│  │      dom-utils.ts     # DOM utilities (selectors, styling, marking)
│  │      follow-up-trims.ts # Delayed checks after init and route changes
│  │      idle-utils.ts    # Idle callback wrapper for smooth processing
│  │      load-readiness.ts # Unreleased conversation hydration gate experiment
│  │      long-task-gate.ts # Long Task pressure state and transitions
│  │      main.ts          # Main entry point & orchestration logic
│  │      debug.ts         # Debug-mode console API
│  │      observer.ts      # DOM mutation observer & route detection
│  │      runtime-diagnostics.ts # Read-only selector and virtualization probes
│  │      settings-store.ts # Extension-storage-backed runtime settings
│  │      trim-engine.ts   # Core message hiding/deleting algorithms
│  │      trim-scheduler.ts # Idle scheduling and adaptive debounce
│  │      turn-inventory.ts # Turn visibility/removal tracking
│  │      types.ts         # Shared TypeScript type definitions
│  │      ui.ts            # UI components (floating ball, panel, toast)
│  │
│  ├─icons                 # Extension icons
│  │      chat-icon-*.png / svg
│  │
│  ├─styles                # Injected styles
│  │      content.css
│  │
│  └─_locales              # Multi-language (i18n)
│      ├─en
│      ├─zh_CN
│      └─zh_TW
│
└─tools
        convert-icons.py   # Tool for generating different sized icons
```

---

## Permissions & Privacy

* Manifest v3
* permissions: `scripting`, `storage`, `tabs`
* host_permissions: `https://chat.openai.com/*`, `https://chatgpt.com/*`
* Settings are stored in the extension's own local storage
* Only operates on frontend DOM, does not collect or upload conversation content or personal data

---

## Historical Development

```bash
# Type checking
pnpm typecheck

# Development mode (watch)
pnpm dev

# Generate release files (dist/)
pnpm build

# Compress and package dist as zip
pnpm zip
```

### Debug

Debug mode is stored in the extension's own local storage. In DevTools, select this
extension's content script context on a ChatGPT page, then run:

```js
await __ccxChatCleanerSetDebug(true)
```

The page reloads automatically. After reload, use:

```js
__ccxDebug.explainSelectors()
__ccxDebug.explainActivity()
__ccxDebug.report()
```

`explainSelectors()` reports configured selector matches plus broader page probes
such as `#thread`, `[data-turn-id]`, message-role nodes, and composer candidates.
`explainActivity()` verifies whether the current focused composer and recent typing
activity are being detected.

Turn debug off with:

```js
await __ccxChatCleanerSetDebug(false)
```

## Privacy Policy

This extension respects your privacy and does not collect any personal data. For detailed information, please see the [Privacy Policy](./docs/PRIVACY.md).

## License

[MIT License](./LICENSE)
