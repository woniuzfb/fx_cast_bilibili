# AGENTS.md — AI Agent Guide for fx_cast_bilibili

This document provides architectural guidance, core invariants, common pitfalls, and development protocols for AI assistants working in this repository.

---

## 1. Project Overview & Architecture

`fx_cast_bilibili` is a Firefox browser extension and native messaging companion app providing Chromecast and Roku casting capabilities, with specialized support for Bilibili and CCTV live streaming.

### Key Components

-   **`extension/`**: Firefox WebExtension (Manifest V3 Gecko, TypeScript, Svelte UI, ESBuild).
    -   `background/`: Extension background event page/service scripts (device discovery, cast session management, whitelist, capture relays).
    -   `cast/`: Cast sender shims, Bilibili/CCTV extractors, media coordinators, content scripts.
    -   `ui/`: Svelte-based popups (`popup/`), options page (`options/`), and screen mirroring UI (`mirroring/`).
-   **`bridge/`**: Native Messaging Host binary (Node.js packaged via `pkg` as a standalone binary in `/Library/Application Support/fx_cast_bilibili/`).
    -   Handles mDNS / Bonjour discovery, Castv2 protocol, Roku DIAL / ECP protocol, DASH/HLS remuxing HTTP server (`mediaServer.ts`), and CCTV live decryption.
-   **`shared/`**: Shared TypeScript interfaces and message types across extension and bridge.
-   **`test/`**: Integration test suites, playback state machine verification, and interleaving model tests.
-   **`.memory/`**: Persistent codebase memory, architectural invariants, and dated investigation notes.

### Multi-Process Bridge Model

-   Each call to `browser.runtime.connectNative()` in `extension/src/lib/bridge.ts` spawns an **independent OS process** for the bridge.
-   Device discovery (`RokuRemote`) and active casting sessions (`RokuSession`, `mediaServer`) run in **separate OS processes**.
-   **Rule**: Never rely on module-level singletons or in-memory caches inside `bridge/` across connections. Cross-process state must be explicitly routed via `main:*` messages relayed through the extension background script.

---

## 2. Core Invariants & Architectural Pitfalls

### 2.1 Dynamic Content Script Registration (`whitelist.ts`)

-   **Dual-ID Atomic Rotation**: To prevent an invalid user pattern from wiping the live script (leaving all sites without cast SDK shims), the extension rotates between `whitelist-content-a` and `whitelist-content-b`.
-   **Minimal Deadlock Guard**: When browser sessions restore or unregistrations fail, both IDs can exist in the registry simultaneously. If both are registered, the code must proactively unregister `nextId` before registering the replacement (leaving the other alive for continuity). Do NOT wrap registrations in complex async queuing (like `syncSiteWhitelist`) or promise queues, which introduce race conditions and execution stalls.
-   **No WebRequest Listener Cycling**: Never cycle `webRequest.removeListener` / `addListener` during whitelist updates. Cycling listeners on `<all_urls>` disrupts in-flight requests and content script contexts in open tabs.
-   **Background Initialization Isolation**: `initWhitelist()` in `background.ts` must be guarded with a `try / catch` so dynamic registration exceptions never crash the core `init()` flow. If `init()` crashes, message listeners (`action:castCurrentTab`) will fail to register, breaking the popup with `"Couldn't open the receiver selector."`.

### 2.2 Chromecast DMR Remuxing & Timeline (`mediaServer.ts`)

-   **Pad Segment (`pad.ts`)**: Default Chromecast receiver (DMR) joins live/EVENT playlists without `EXT-X-ENDLIST` at the window midpoint. Startup pad (`padBaseSeconds = max(contentBaseSeconds, 32)`) provides a safe runway so DMR does not seek backward before buffer start.
-   **Window Tail Truncation (`limitChromecastDashPlaylist`)**: During remuxing, rapid segment generation expands the playlist and slides the midpoint forward past the playback position. Dynamic window truncation bounds visible end until `ENDLIST` is written.
-   **Discontinuity Tag**: `#EXT-X-DISCONTINUITY` is required between `pad.ts` and the first real segment so decoder timestamps reset properly.
-   **Timeline Translation**: Chromecast presentation clock already accounts for the runway. Page time is `raw - offset` (do NOT add `dashStart`). For Roku capture, page time is `dashStart + raw - offset`.
-   **ffmpeg `-ignore_editlist 1`**: Bilibili m4s edit lists cause ffmpeg to discard the initial audio fragment in mpegts muxing (yielding segment-000000 with 0 audio packets). Both audio and video ffmpeg inputs must specify `-ignore_editlist 1`.
-   **Audio/Video Sync**: Video `-ss` cuts at the previous keyframe (`contentBaseSeconds = probedKeyframeSeconds`). Audio `-ss` must be aligned to the exact same keyframe, never to an arbitrary sub-second point.

### 2.3 Video Transitions & Item Switching

-   **Keep Page Playing on Transition**: On video switch or quality change, do NOT call `pause()` on the webpage (except for the initial cast). Pausing the page on Roku starves the native relay capture. Use `prepareUpdatedMediaElement` to idempotently mute the element instead.
-   **Transition Guard Window**: Use `beginDashItemTransition()` to ignore stale receiver `PAUSED` and position reports until the new session's first real position arrives.
-   **Byte Lifecycle in SPA Navigation**: In Bilibili SPA page switching, URL changes lag media representations by ~100ms. Do NOT wipe captured byte chunks on URL identity change; only teardown on real page unload or explicit stop.

### 2.4 Roku ECP Remote Control

-   **Single Command Slot**: In `extension/src/background/playbackCommand.ts`, `commands` is a single slot per device representing the actively executing command. When a command terminates, `terminate()` MUST clear the slot; leaving stale completed commands breaks subsequent LOAD comparisons.
-   **Physical Screen Requirement**: Roku ECP `/keypress` only delivers app-level keys when the TV screen is active/on. When the TV display is powered off, Roku directs keypresses to system space.

---

## 3. Development, Linting & Testing Workflows

### Build & Package Commands

```bash
# Build extension
npm run build:extension

# Build bridge
npm run build:bridge

# Full build (bridge + extension)
npm run build
```

### Code Quality & Formatting

-   **Linter**:
    ```bash
    npm run lint            # Lint both bridge and extension
    npm run lint:extension  # Lint extension only
    ```
-   **Prettier**:
    -   Configuration: `.prettierrc.json` (Prettier 2, 4 spaces, double quotes, no trailing commas, `arrowParens: "avoid"`).
    -   Note: Prettier 2 does NOT automatically read `.gitignore`. Check `.prettierignore` before formatting.
    ```bash
    npm run format:check    # Verify formatting
    npm run format          # Format files
    ```

### Test Suites

-   **Unit & State Machine Tests (Offline, Fast)**:
    ```bash
    npm run test:senders    # Sender synchronization, time domain, DASH seek, Roku transition
    npm run test:playback   # Coordinator observation, presentation time, status pipeline, page capture
    ```
-   **Bridge Network Tests (Require Local Hardware/Mocks)**:
    ```bash
    npm run test:bridge
    ```

---

## 4. Memory Maintenance Protocol (`.memory/`)

This project maintains persistent institutional memory under the [`.memory/`](file:///.memory/) directory:

1. **`MEMORY.md`**: Contains long-term architectural rules, cross-process invariants, and verified hardware constraints.
2. **`YYYY-MM-DD.md`**: Chronological log documenting specific investigations, bug reproductions, root cause proofs, and verified solutions.

### Working with Memory:

-   **Before making non-trivial architectural changes**: Read [`.memory/MEMORY.md`](file:///.memory/MEMORY.md) to check existing constraints and previous failed experiments.
-   **After resolving a bug or altering core mechanisms**:
    1. Record the detailed root cause, log fingerprints, and fix logic in `.memory/YYYY-MM-DD.md`.
    2. If the finding introduces a long-term invariant or architectural rule, add a concise summary bullet to [`.memory/MEMORY.md`](file:///.memory/MEMORY.md).
