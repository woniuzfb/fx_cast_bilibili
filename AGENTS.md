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

### 2.5 严格禁止任何形式的硬编码 (Zero-Hardcoding Invariant)

-   **生产代码零凭据与零路径硬编码 (Zero Hardcoding in Production)**：
    -   **鉴权凭证零字典**：严禁在生产代码中硬编码鉴权 Token/Cookie 键名列表（如 `["openid", "vusession", "accesstoken"]` 或 `["uinfo_vuid"]`）或凭证值；所有会话捕获、生命周期、Domain 剥离与跨域受管补发机制必须纯粹由网络协议属性（`HttpOnly`、`domainStripped`、RFC 6265 作用域匹配）与端上下文动态驱动。
    -   **环境路径零硬编码**：严禁硬编码任何开发机、临时或测试目录绝对路径（如 `/tmp/...`、`/Users/...`、`dist/test/...`）。
    -   **构建依赖全量遍历**：原生动态库打包必须动态遍历全量 `NATIVE_BINDING_NAMES`，严禁硬编码单一动态库文件名。
-   **测试套件封闭自包含与零外部文件依赖 (Hermetic Test Suites & Zero External File Dependencies)**：
    -   **零 `.har` 外部文件依赖**：严禁在测试套件中硬编码外部抓包文件路径（如任何 `.har` 文件、`dist/test/*.har`、临时网络归档）。
    -   **测试用例封闭自包含 (Self-Contained)**：测试所需的 HTTP 报文、Set-Cookie、URL 等必须作为内存常量（Fixtures）内嵌于测试文件中，且时间戳需动态刷新为未来有效时间，确保测试在任何干净检出环境、断网环境及长期未来均能无条件稳定执行并保证全部断言生效。
    -   **严禁条件跳过断言**：严禁通过 `fs.existsSync(harPath)` 等条件分支包裹关键回归测试；缺少外部文件时绝不能静默跳过或假绿，必须无条件执行并断言全量覆盖。

### 2.6 严格禁止任何页面级 Hook (Zero Page/DOM Hook Invariant)

-   **纯粹网络层实现 (Pure Network-Layer Invariant)**：
    严禁向任何网页注入 MAIN world 脚本或修改 `window`、`document`、`Storage.prototype`、`setInterval` 等浏览器原生对象及原型；所有突破限制（如央视频 5 分钟试看限制）、画质锁定与跨域凭据处理必须 100% 封闭在 WebExtension 纯网络层（`webRequest.onBeforeRequest` 查询参数改写、`webRequestFilterResponse` 响应体流改写、`onBeforeSendHeaders` / `onHeadersReceived` 会话隔离）处理，保证网页执行环境零入侵、零副作用。

### 2.7 央视频 PC / 移动端会话隔离不变量（`extension/src/background/yangshipinSession.ts`）

设计定稿见 [`.memory/方案修订.md`](file:///.memory/方案修订.md)，改造时逐条对齐，不得「大致参照」：

-   **共享 API 主机零落盘 (Zero-Jar)**：凡 `*.yangshipin.cn` 中的非文档主机（`h5access`、`ucenter-api`、`liveinfo` 等）下发的 `Set-Cookie` 一律整条剥除，只登记进本端分区；文档主机（`www` / `w` / `m`）的 `Set-Cookie` 才允许落盘，且必须剥掉 `Domain` 属性。
-   **单端权威（绝对禁止对端查询）**：`source: "server" | "client"` 是唯一来源依据；出向准入只允许读【本端分区 + 本请求原始头】两个输入。模块内不得出现指向另一端的变量、参数、序列化字段或比对逻辑（验收：`peer` 子串零命中、`\bother\b` 词边界零命中）。
-   **墓碑 = 值指纹 + TTL + 容量**（带指纹 7 天 / 无指纹 24 小时 / 上限 256 FIFO），按 `(name, scope, isHostOnly, path)` 复合键裁决，出向既要剥离原始头残渣，也要过滤分区候选。
-   **降级由文档主机响应完成**：共享 API 响应只把待降级名字并入分区级集合（任务不丢，但父域副本的删除以下一次文档主机响应为边界），排空取【响应当刻】最新值、逐名提交、purge-only 名字只拔不建。
-   **按主机清洗只跳过「准入」，绝不跳过「补发」**：未清洗的共享 API 主机必须照常收到本端分区的权威候选（Zero-Jar 之后分区是唯一凭据来源，跳过补发会让该主机首次请求整条不带凭据、也不带页面 JS 的跨主机活体参数，服务端请求合法性校验直接失败）；只跳过原始头的采纳与墓碑清除，jar 中分区未覆盖的残留仍按原样放行、由该响应双删，同名时本端权威值优先。
-   **残留放行不得绕过本端已知防御**：残留追加前必须丢弃「值匹配墓碑 / 本端任意作用域已有同名 server 权威 / 本端已有同名 client 受管条目 / 同名页面副本待撤销」的项。放行只是「不学习」，不是「绕过裁决」。
-   **平台判定 fail-closed（`classifyYangshipinPlatform`）**：非 `main_frame` 请求必须有顶层上下文（`tabTopHostByTabId`，缺失或 `tabId < 0` → `unknown`）且必须有文档主机发起方（`originUrl` > `documentUrl` > `Origin` > `Referer`，缺失 → `unknown`）；顶层表**只校验上下文，绝不替代发起方**。第三方顶层 → `external`。`unknown`/以其它方式无法归属的响应一律剥除 Set-Cookie。SameSite 的「无发起方视为同站」例外只允许出现在 `main_frame` 顶层导航。
-   **页面副本撤销期抑制**：名字在请求主机上还有 `materializedCopies` 台账而未撤销、且本端已无同名活跃 server 条目时，原始头里的同名值不得被重新准入为 client 条目（否则清除会话后的旧副本会以更宽作用域复活）；撤销由台账响应完成，抑制随台账记录删除自动解除。
-   **非法 Domain 一律拒绝**：`Domain` 存在但与响应主机不 domain-match 时整条 Set-Cookie 失效（RFC 6265 §5.3 step 6），绝不降级成 host-only 落盘；缺省 `Domain` 才是 host-only。
-   **容量淘汰是真 LRU**：`usageOrder`（Map 插入序 = 最近使用序）+ `markUsed()`，不用创建时间冒名顶替「最久未使用」。
-   **生命周期**：会话终结由协议属性判定（`source=server && httpOnly` 条目被删且同复合键未重发），**严禁按 URL 路径识别登出**；终结 / 清除会话推进分区 `generation`，旧代际的在飞响应只剥 Set-Cookie、不登记不降级不物化。
-   **持久化**：client 条目与会话 cookie 永不落盘；墓碑 / 会话终结 / 基线完成走 `persistNow()` 写穿，其余走 1000 ms 防抖；所有写入经同一串行队列（`stateRev` 单调，旧快照不得覆盖新快照），入口内部吞掉一切异常。
-   **关闭开关 = 登出一次**：凭据不在 jar 中，`yangshipinSessionIsolation` 关闭后 handler 立即 `return {}`，等价于登出；改这条链路前先读方案 §9.5 与 §15。

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
