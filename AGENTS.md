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
-   **根目录跳板只限顶层直连导航（`isYangshipinTrampolineNavigation`，方案 §9.2 R0t）**：`https://w.yangshipin.cn/` 仅在「`type === "main_frame"` **且**目标 URL 命中跳板（配置主机 + **显式** `/`）**且**发起方链（`collectCallerHosts`，**只取 host**）不含移动文档主机」时判为 `trampoline`。出向不注入任何凭据（本端分区候选与 jar 残留都拦下）、不准入、不排队降级/purge、不写 `baselineCleanedHosts`；入向**绑定优先**（站内导航到 `/` 的文档响应按 mobile 处理，否则其 Set-Cookie 被搁死），仅无绑定时才以 `main_frame` + 响应 URL 兜底剥除整条 Set-Cookie；仅判决成立时删除该 tab 的旧顶层上下文。**两条铁律**：① 严禁把跳板表达成「不是文档主机」——那会把它交给按主机清洗路径，从另一个入口继续删父域 cookie 并伪造清洗记录；② **严禁用发起方 URL 的路径产生跳板判决**——浏览器把跨域 Referer 裁成 origin `https://w.yangshipin.cn/`（与跳板 URL 字面相同），据此判决会让整条移动端登录被当成跳板（`auth_login` 不带凭据、`vusession` 从未登记），发起方路径只能用于排除。详见 [.memory/2026-10-13.md](file:///.memory/2026-10-13.md) §4。
-   **页面副本撤销期抑制（含跨主机）**：名字在请求主机上还有 `materializedCopies` 台账而未撤销、且本端已无同名活跃 server 条目时，原始头里的同名值不得被重新准入为 client 条目（否则清除会话后的旧副本会以更宽作用域复活）；撤销由台账响应完成，抑制随台账记录删除自动解除。**跨主机同样抑制**（`hasPendingCopyRevocation`）：当台账源复合键已不在 `partition.entries`（到期 / 被源 API 主机删除 / 清除会话）且请求携带的值与 `valueFingerprint` 相符时，**任何**主机都不得把它重新接管为父域 client 条目——否则会在文档主机撤销前被另一台共享 API 主机抢先「复活」。
-   **非法 Domain 一律拒绝**：`Domain` 存在但与响应主机不 domain-match 时整条 Set-Cookie 失效（RFC 6265 §5.3 step 6），绝不降级成 host-only 落盘；缺省 `Domain` 才是 host-only。
-   **同平台文档主机判定（`isDocHost`）**：入向必须用 `isDocHost = docHostPlatform(respHost) === platform`，**严禁**退化成 `isYangshipinDocHost(respHost)`。PC 播放页会从 `m.yangshipin.cn/static/...` 拉 CSS/PNG，用「是不是任意文档主机」判定会让这些跨端子资源截胡排空 `pcPartition.pendingDemoteNames`、并把 PC 凭据物化到 `m`（真机 401/403 根因之一）。`pc` 只在 `www` 上做步骤 2 降级与步骤 3c 物化，`mobile` 只在 `w` / `m` 上做。
-   **物化台账只存指纹 + 新旧副本防回滚**：`MaterializedCopyRecord` 只持久化 `valueFingerprint`（8 位 FNV-1a），**不落盘明文 `value`**（与墓碑同一机制）。出向步骤 1 必须同时阻断两类回滚：① 同一请求头内 `[V_NEW, V_OLD]`（本端已 `valueRev` 领先 + 尾随旧值等于台账指纹）——同一请求内先采纳的新值不得被后面的旧副本覆盖；② 跨请求：`matRecord.valueRev < existingClient.valueRev && fingerprint(value) === matRecord.valueFingerprint` 的旧 Host-Only 副本不得把刚续期的新凭据回滚。
-   **重放回显必须「成对 + 有来源证据」**：① **严禁按 `statusCode === 304` 整批丢弃 Set-Cookie**——那会连带丢掉合法的 304 续期与独立服务端删除；只在同一响应内**成对出现**父域 `Domain=.yangshipin.cn; Max-Age=0` 与「同值、Host-Only、`SameSite=Lax`」的客户端副本回声时，才忽略这一对降级回声（单独下发的父域删除头照常执行并墓碑化）；304 上另外跳过「`(name, path, valueFingerprint)` 与既有台账记录一致」的缓存型 §13 回显。② `hydrate()` 自愈只有拿到证据才允许：存在 `clientLedgerKey`（`${clientKey}#${docHost}`）或与父域 `clientKey` 墓碑配对且同 `valueFingerprint` 时才还原为父域 `client` 条目——**绝不**把合法的 `www` Host-Only `server` 条目扩域到 `.yangshipin.cn`（21:09 HAR `guid` 悬案的成因）。
-   **401/403 诊断快照 = 有界环形缓冲 + 脱敏**：快照由 `diagnostics.authFailures` 计数与定长环形缓冲承载（`MAX_AUTH_FAILURE_LOGS = 20`），经 `getYangshipinAuthFailureLogs()` / `clearYangshipinAuthFailureLogs()` 读取与清空。快照里的 URL 一律经 `sanitizeDiagnosticUrl()`（清 userinfo / fragment，查询值转 `<len:N,fp:XXXXXXXX>`）；Cookie 只以长度 + FNV-1a 指纹出现，明文值永不入日志或环形缓冲。
-   **安装期顺序：先清洗、后接管（`isBaselineCleanPending` + `baselineCleanedHosts`）**：① 全局基线分支在 **§11.7 水合门禁之后、§6.2 稳态准入之前**（平台分类之后）执行——**「尚未读回标记」不等于「确定 pending」**：内存标记初值 `true` 只是占位，据它提前登记破坏性基线会让正常重启（磁盘 `fxcast_ysp_baseline_clean_done = true`）的首跳被当成基线，同一响应**先**按 §13 物化页副本、**后**下发同名删除行，副本被删而 `materializedCopies` 已记为「已物化」（`materializedDocHosts` 不持久化 → 本次后台生命周期内不再重发）→ 重启丢一次页内会话（已复现，`.memory/2026-10-14.md` §8）。被门禁 fail-closed 吞掉的基线**保持 pending**，由下一次文档导航重试（§12.4）；跳板永不到达该判定点（平台分类处已早退）。② 按主机清洗的**覆盖集包含全部 yangshipin 主机（含文档主机 `www` / `w` / `m`）**：全局基线只保护它自己那一跳落到的文档主机，其它文档主机上的 host-only 页副本（上一安装物化的孤儿）必须由各自「首次请求：放行不采纳 + 双删」兜住，否则会被首个稳态请求采纳成**父域** client 条目并全域补发——这也是「基线被吞掉时不会先搬运」的唯一依据。③ 基线那一跳**同时消耗其响应主机的名额**（计入 `baselineCleans`，不计入 `hostBaselineCleans`），避免同一主机被清第二次、删掉刚物化的页副本。④ 文档主机响应侧的删除集只覆盖「本端分区未管理」的名字（`hasServerManagedName` 为假且无同名 client 键），否则删除行会与同一响应里的 §13 物化副本互相取消。⑤ 出向/入向 fail-closed 都必须 `clearRequestScopedState(requestId)`，使已登记的基线请求保持可重试。详见 [.memory/2026-10-14.md](file:///.memory/2026-10-14.md) §8。
-   **水合操作代际、用户重置串行与确认写入（§11.3 / §11.4 / §11.7 / §12.3）**：`hydrateAll()` 在 `readStorage()` **之前**记录 `stateEpoch`，`await` 之后若代际已变更则**整份快照丢弃**（不落分区/墓碑，也不改 `isBaselineCleanPending`）；`stateEpoch` 由用户重置与测试全量重置推进。**`resetYangshipinForUser()` 是 async 且返回 `boolean`**：先推进代际，再清分区/物化台账/重排基线，然后 `await` 两端分区的 `persistNowConfirmed()` 与 `persistBaselineCleanDone(false)`，**三段全部成功才返回 `true`**；任一失败返回 `false`、分区保持 dirty（由后续普通变更重试），options 消息处理回 `{ ok: persisted }` 并在 `ok === false` 时显示「已重置但未能写盘」。**`waitForWrites()` 不是持久化证据**——它只等写入「结束」，而普通写入器 `runWrites()` 内部吞掉异常；凡是「回复成功即代表已落盘」的需求都必须走带结果的确认写入。**确认写入绝不自起 writer**：`requestWrite()` 返回槽位上的 run，`persistNowConfirmed()` 只加入它（重叠调用共用同一个 writer），否则同一 key 会出现同一 `stateRev` 的两个并发写入、破坏「旧快照不得覆盖新快照」（实测 pc/mobile 各 2，断言 39/40）；基线标记 `fxcast_ysp_baseline_clean_done` 由多条路径写，必须走模块级写入链，同一 key 绝不并发、以最后发起者为准。在途基线请求**无需**在重置里特殊处理：出向在平台分类处已写 `requestIdPlatformMap` 绑定（先于 §3.2 基线分支），而 `clearYangshipinSession()` 推进分区 `generation`，该响应会被 §5.2 步骤 1b 作废并丢掉自己的登记。否则会出现「重置已生效 → 在途旧快照提交 → 凭据复活 + 刚重排的基线被取消」（已复现，断言 37 / 38）。
-   **容量淘汰是真 LRU**：`usageOrder`（Map 插入序 = 最近使用序）+ `markUsed()`，不用创建时间冒名顶替「最久未使用」。
-   **生命周期**：会话终结由协议属性判定（`source=server && httpOnly` 条目被删且同复合键未重发），**严禁按 URL 路径识别登出**；终结 / 清除会话推进分区 `generation`，旧代际的在飞响应只剥 Set-Cookie、不登记不降级不物化。
-   **持久化与重启恢复（v+9 契约）**：重启不清除两端状态、不重新执行基线，恢复关闭前的有效状态；原本有明确到期时间的 Cookie 仍按原时间到期（不续期，过期直接丢弃），无到期时间的条目（会话 server 条目与 client 条目）及恢复关联状态（`pendingDemoteNames`、`baselineCleanedHosts`、`materializedCopies`）完整持久化与恢复；冷启动首个同端文档响应重新下发页面赢家副本；client 变更走 1000 ms 防抖合并，墓碑 / 会话终结 / 基线完成走 `persistNow()` 写穿；所有写入经同一串行队列（`stateRev` 单调，旧快照不得覆盖新快照），入口内部吞掉一切异常。
-   **关闭开关 = 登出一次**：凭据不在 jar 中，`yangshipinSessionIsolation` 关闭后 handler 立即 `return {}`，等价于登出；改这条链路前先读方案 §9.5 与 §15。
-   **MV3 唤醒期的顶层上下文与注册时序**：① 拦截器必须在 `background.ts` 的 `init()` 里**同步注册**（先于一切 `await`），否则 MV3 非持久事件页被唤醒时，唤醒它的那次导航/请求会漏拦截；② `initYangshipinLive()` 与 `initYangshipinSessionInterceptor()` 都必须**幂等**（`yangshipinLiveWired` / `sessionInterceptorWired` + 记录已接线的 browser），因为 `init()` 会在 options 未就绪时提前返回并被再次调用——重复注册会让 `onBeforeRequest` 与 `runtime.onMessage` 监听器叠加（重置、`queueReceiver`、`resolveStreamUrl` 各跑两遍）；③ 顶层上下文除 `tabTopHostByTabId` 外还维护 `committedTopHostByTabId` + `failedNavTabIds`：**已提交 2xx 文档的标签页**发生中途导航取消/失败时恢复为已提交宿主，仅「初始导航尚未提交即失败」才清空，`frameId === 0` 的唤醒缺失时回填，启动时用 `tabs.query({})` 预热（manifest 已有 `tabs` 权限）。顶层表**仍然只做上下文校验，绝不替代发起方**（§2.7 上一条）。
-   **`extBrowser()` 绑定语义（跨上下文隔离）**：模块在**加载时**绑定当时的 `browser`（`boundBrowser`），此后运行时的一切存储与通知访问都走 `extBrowser()`。裸 `browser.*` 只允许出现在**类型标注**与**监听器注册**处（注册必须用当刻的 global，以便测试世界替换 stub）。这样任何迟到回调（1000 ms 防抖写、在途写、通知）都不可能写进另一个上下文/测试世界的存储——这是「测试世界互换 `global.browser` 后互不串写」的前提，也是断言 40 曾经偶发失败的根因。

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

---

## 5. Git & 工作区纪律（强制）

-   **禁止用 `checkout` 或任何类似 HEAD 的手段覆盖工作区中未保存的文件**：
    -   不得执行 `git checkout <path>`、`git checkout HEAD -- <path>`、`git checkout -- .`、`git restore`、`git reset --hard`、`git reset -- <path>`、`git clean -f/-fd/-fdx`，也不得用 `git stash` 来"把工作区弄干净"。这些命令都会丢弃或覆盖尚未提交的改动，包括别人的。
    -   需要看 HEAD 版本时只用**只读**手段：`git show HEAD:<path>`、`git diff HEAD -- <path>`、`git log`，或把 HEAD 内容重定向到临时文件再比对——**绝不写回工作区**。
    -   改文件一律用编辑工具（Edit/Write），不用 git 当文件操作手段。
    -   唯一例外：用户在同一轮对话中明确要求丢弃/回滚**某个具体文件**。
-   **禁止未经允许 commit**：
    -   只有用户在当前对话里明确说"提交/commit"才允许 `git commit`；不要从"任务完成"推断出提交授权。
    -   只提交用户要求的范围：提交前先 `git status` + `git diff`，把"顺手修的""不在要求内"的改动排除在外；提交后在回复里列出本次包含的文件，以及仍然留在工作区未提交的改动。
    -   不得使用 `--amend`、`--no-verify`、`--no-gpg-sign`（除非用户明确要求），不得 `git push`（除非用户明确要求）。
