# ChatGPT Subscription Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标** 在桌面版「设置 → AI 模型 → 添加模型」中提供 ChatGPT Subscription，完成 Codex 设备码授权后即可测试模型、设为默认或供作品和创作管家使用。

**架构** Electron 主进程持有独立的加密 OAuth 会话，并把会话能力提供给同进程的 Express。`streamChat` 调用独立 Codex Responses 适配器，原有 Agent Loop 继续消费标准流事件。渲染进程经可信 IPC 管理授权，只接收连接和模型目录信息。

**技术栈** Electron 31 `safeStorage` 与 IPC、Express 4、Node `fetch` 和 `node:test`、React 18、TypeScript、Vite 5。

**规格** [ChatGPT Subscription 桌面接入设计](../specs/2026-11-20-chatgpt-subscription-design.md)

## 全局约束

- 「桌面、单个已连接的 ChatGPT 账号和工作区」，开发窗口和本地安装版均显示「实验性」。独立 Web 沿用现有供应商。
- 使用 Codex 设备码与 Hermes Codex Responses 协议，小说工坊自行刷新并运行自己的 Agent Loop。当前不使用 SIWC、Codex CLI 或单独的 Codex App Server。
- 授权与推理使用固定上游地址。应用请求使用小说工坊自身的客户端标识。OAuth 令牌与设备授权内部标识排除在模型 API、渲染进程、导出备份、诊断及日志之外。
- 维持已有 OpenAI、Gemini、本地服务和历史配置的行为。订阅推理使用 `stream: true`、`store: false`，省略 `max_output_tokens`、`temperature`。授权、权限和额度错误直接反馈给用户，已收到正文后断流时避免自动重放。
- 单元和集成测试使用内存替身或环回 mock，数据路径使用临时目录。真实账户交由其所有者在官方验证页面授权，验证数据使用非书稿示例。

## 审查重点

- 取消、断开或新尝试发生在交换令牌或写盘期间时，较早操作无法恢复连接。任务 1 在异步屏障处检查旧操作。
- 两个请求用旧 access token 同时遭遇 401 时，刷新链只旋转一次。任务 1 验证新令牌复用，任务 2 验证一次请求最多重试一次。
- UTF-8 字符拆跨多个块、显式截断和没有终止事件的 EOF 要正确区分。任务 2 用同一套 SSE 用例分别验证这些结果。
- 连接同账号的不同工作区时，作品已选模型保持原绑定。任务 3 验证模型可编辑且必须显式改绑，任务 5 验证界面确认状态。
- 普通浏览器和同窗口的非可信 frame 即使知道环回端口，也不能启动已授权的付费推理。任务 4 以代理和 IPC 两条入口验证。

## 文件和任务边界

| 任务 | 生产文件归属                                                                                                                                                  | 交付                                     |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| 1    | `server/codex-oauth.mjs`、`electron/codex-credentials.mjs`                                                                                                    | 设备码、凭据存储、刷新和断开             |
| 2    | `server/codex-responses.mjs`、`server/ai-transport.mjs`                                                                                                       | Responses、模型目录和现有流接口分发      |
| 3    | `server/models.mjs`、`server/app.mjs` 的模型错误映射                                                                                                          | 模型公开字段、选择、配置和连接测试       |
| 4    | `electron/main.mjs`、`electron/preload.cjs`、`src/lib/desktop.ts`                                                                                             | 主进程接线、可信窗口 API 和前端 IPC 接口 |
| 5    | `src/types.ts`、`src/pages/Settings.tsx`、`src/components/CodexConnectionDialog.tsx`、`src/components/ModelSelect.tsx`、`src/lib/errors.ts`、`src/lib/api.ts` | 模型界面和桌面验收                       |

任务 1 定好接口后，任务 2 可独立验证流协议。任务 3 和 4 共用任务 2 的运行时接口，负责不同文件。任务 5 消费任务 3 和 4 的接口。

### 任务 1　设备码授权和凭据

**接口** 异步 `createCodexAuth({ storage, fetchImpl, now, sleep, clientId })` 加载凭据并返回授权服务。`storage` 提供 `isAvailable()` 及异步 `read()`、`write(record)`、`clear()`。实际 `clientId` 取 Hermes 所用 Codex 设备码的公开客户端标识，集中在 OAuth 模块，测试注入替身。`createCodexCredentialStorage({ filePath, safeStorage })` 实现独立加密存储，Windows 使用 Electron 系统凭据保护。公开 `status()` 同步返回 `CodexConnectionStatus`，即 `{ state, connectionRef?, label?, code? }`，`state` 为 `disconnected`、`connected`、`reconnect` 或 `unavailable`。`start()` 异步创建尝试并返回 `CodexAttemptStatus`，`attempt(attemptId)` 同步返回该对象或 `null`。`cancel(attemptId)`、`disconnect()` 和 `shutdown()` 异步结束操作。`CodexAttemptStatus` 只包含 `{ attemptId, state, userCode?, expiresAt?, code? }`，状态为 `starting`、`pending`、`retrying`、`connected`、`cancelled`、`expired` 或 `error`。内部异步 `getCredential(connectionRef, { rejectedAccessToken?, signal? } = {})` 返回 `{ accessToken, accountId, residency? }`，失败抛出含稳定 `code` 的安全错误。

- [ ] **写失败测试** `tests/codex-oauth.test.mjs`。`device authorization saves only current successful attempt` 断言等待的 `403/404` 继续、一次 `200` 完成交换、旧尝试延迟成功后 `assert.equal(writeCount, 0)`。`device polling honours expiry and retry bounds` 用假时钟断言期限内按服务间隔轮询，过期后次数不变，连续网络错误用尽后停止。`refresh is shared and disconnect wins over late writes` 断言两个过期或同时拒绝同一 access token 的调用 `assert.equal(refreshCount, 1)`，存储返回新令牌对，断开后晚回包到达时 `assert.equal(auth.status().state, 'disconnected')`。覆盖取消请求自己的等待时，另一个等待者仍能拿到共享刷新结果。`credential storage has no plaintext fallback` 用临时文件和测试 safeStorage 验证已加密、保留上次成功持久化记录和不可用时拒写。再覆盖 `invalid_grant` 进入 `reconnect`、网络抖动保留现有状态和同一身份重登连接引用稳定。
- [ ] **运行失败测试** `node --test tests/codex-oauth.test.mjs`，预期新增授权和存储接口缺失。
- [ ] **实现授权与存储**。设备码三步请求和刷新字段按 [Hermes 设备码工作流](https://github.com/NousResearch/hermes-agent/blob/9f47677483d1b4de4d1a88d37b3b7ca18b18b215/hermes_cli/web_routers/oauth.py#L224-L300) 与 [Hermes 刷新实现](https://github.com/NousResearch/hermes-agent/blob/9f47677483d1b4de4d1a88d37b3b7ca18b18b215/hermes_cli/auth_codex.py#L497-L537)。输入只接受上游返回的授权字段，验证页固定为 `https://auth.openai.com/codex/device`，轮询间隔取服务返回值并使用 Hermes 的有效期兜底。用可信交换结果中的用户主体与工作区 ID 组合成有命名空间的稳定散列引用。交换、刷新与断开在同一写入队列提交，进入写入队列后再次核对会话代次。失效错误只暴露安全代码和可显示信息。安全存储缺失或只提供明文时返回 `unavailable`，加密文件的更新及删除不留下可复用的旧凭据备份。
- [ ] **运行通过测试** `node --test tests/codex-oauth.test.mjs`，预期全部通过。
- [ ] **提交任务** `feat: manage Codex device authorization and credentials`，范围限任务 1 文件与测试。

### 任务 2　Codex Responses 与账号模型目录

**接口** `createCodexClient({ auth, fetchImpl, appVersion })` 返回 `status()`、`listModels(connectionRef, { signal } = {})` 和 `stream(options)`。目录返回 `Array<{ id, label }>`，`stream` 产生 `streamChat` 现有 `content`、`reasoning`、`meta` 事件。`configureCodexClient(client)` 和 `getCodexClient()` 供 Electron 与模型层共享同一实例，未配置时返回空。`streamChat` 识别 `provider: 'chatgpt-subscription'`，以 `{ model, messages, connectionRef, reasoningEffort, signal }` 调用适配器。

- [ ] **写失败测试** `tests/codex-responses.test.mjs`。`codex request preserves history and image input` 捕获请求并断言系统提示进入 `instructions`、消息顺序和图片保留、`stream === true`、`store === false`，没有 `max_output_tokens` 和 `temperature`，令牌只发往固定 Codex 主机。`codex stream distinguishes completion truncation and EOF` 传入将 UTF-8 字符分块的 SSE，断言输出正文、推理摘要、一次结束事件。显式 `max_output_tokens` 导致 `truncated === true`，流中途关闭报错且请求次数为一。`codex retries one pre-stream 401 and preserves cancellation` 断言 401 用新 token 重试一次、403/429 不刷新、取消停止读取。`account catalog returns visible unique slugs` 断言按上游排序过滤隐藏或重复模型，失败时允许界面呈现手填模型入口。
- [ ] **运行失败测试** `node --test tests/codex-responses.test.mjs`，预期新模块和事件映射缺失。
- [ ] **实现传输与分发**。参考 [Hermes Responses 传输](https://github.com/NousResearch/hermes-agent/blob/9f47677483d1b4de4d1a88d37b3b7ca18b18b215/agent/transports/codex.py)、[账号请求头](https://github.com/NousResearch/hermes-agent/blob/9f47677483d1b4de4d1a88d37b3b7ca18b18b215/agent/codex_headers.py#L39-L83) 和 [模型目录](https://github.com/NousResearch/hermes-agent/blob/9f47677483d1b4de4d1a88d37b3b7ca18b18b215/hermes_cli/codex_models.py#L136-L184)。Bearer、账号及适用的工作区区域信息仅发至固定 Codex 后端，拒绝 HTTP 重定向。目录版本用应用实际版本并允许服务拒绝时手填。使用现有 SSE 处理惯例，映射 `response.output_text.delta`、`response.reasoning_summary_text.delta`、`response.completed`、`response.incomplete`、`response.failed` 及错误事件。对有权限错误语义的 401 直接报告权限问题。错误代码至少覆盖 `CODEX_RECONNECT`、`CODEX_ACCOUNT_MISMATCH`、`CODEX_MODEL_FORBIDDEN`、`CODEX_RATE_LIMIT`、`CODEX_NETWORK`、`CODEX_UNAVAILABLE`。保持超时和取消，模型直接结束前没有完成事件时报告上游断流。
- [ ] **运行通过测试** `node --test tests/codex-responses.test.mjs tests/ai.test.mjs`，预期新旧流处理测试全部通过。
- [ ] **提交任务** `feat: stream ChatGPT subscription through Codex Responses`，范围限任务 2 文件与测试。

### 任务 3　模型配置、选择和连接测试

**接口** 模型供应商为 `'chatgpt-subscription'`。公开条目使用既有模型字段加 `connectionRef` 和 `connectionState`，其中 `connectionState` 为 `connected`、`reconnect`、`account-mismatch` 或 `unavailable`。公共 DTO 继续包含旧模型已使用的 API Key 掩码与 `hasKey`，订阅条目无可编辑密钥和地址。`resolveConn(modelId)` 保留旧查找优先级，订阅配置传出 `connectionRef`，在选定模型后执行凭据校验。原 `POST /api/models/:id/test` 对订阅条目使用短 `streamChat`，错误体 `{ error, code }`。

- [ ] **写失败测试** `tests/codex-models.test.mjs`。使用临时 `NOVEL_DATA_DIR` 和 mock 客户端，本地路由 fixture 参考 `tests/writer-agent.test.mjs`。`subscription config projects an allowlisted DTO` 断言注入的 `accessToken`、`refreshToken`、`baseUrl`、`apiKey`、`local` 不会改变订阅连接或被回传。`an existing model stays bound until explicitly reassigned` 断言断开记录保留、同账号恢复、另一工作区标错且原作品配置保留。`subscription test resolves exact id and production stream` 断言未知 ID 返回 404，指定 ID 命中正确 slug，下游断开或权限错误没有旧供应商请求。`legacy model imports stay fenced` 断言订阅配置不被 OpenAI `/probe`、`/import`、`/import-group`、`/list`、站点命名或本地自动导入误处理。保留旧 API 缺省 provider、脱敏、默认选择及本地空密钥用例。
- [ ] **运行失败测试** `node --test tests/codex-models.test.mjs`，预期新增供应商分支或契约缺失。
- [ ] **实现 DTO 和路由**。在 `server/models.mjs` 明确识别供应商并保留旧数据规范化、保存和默认模型规则。订阅模型首次保存及改绑要匹配当前连接，既有模型保持原引用时允许编辑。注册路由时按供应商拦截通用导入、探测和分组接口。`/test` 使用具名 ID 提取，在流正常结束且确有非空正文时返回成功。`server/app.mjs` 将有类型的订阅错误传给现有任务和管家错误路径，脱敏后保留 `code`。后端仍使用原有写作与管家动作流程。
- [ ] **运行通过测试** `node --test tests/codex-models.test.mjs tests/local-models.test.mjs tests/writer-agent.test.mjs tests/chat-sessions.test.mjs`，预期全部通过。对 sandbox 禁止环回监听的环境，使用可访问环回的运行方式重试。
- [ ] **提交任务** `feat: support subscription-backed model configurations`，范围限任务 3 文件与测试。

### 任务 4　Electron 主进程、API 边界和 IPC

**接口** `window.novelAPI.codex` 由 preload 暴露，`src/lib/desktop.ts` 对应声明 `status(): Promise<CodexConnectionStatus>`、`start(): Promise<CodexAttemptStatus>`、`attempt(id: string): Promise<CodexAttemptStatus | null>`、`openVerification(id: string): Promise<boolean>`、`cancel(id: string): Promise<void>`、`disconnect(): Promise<void>`、`listModels(): Promise<Array<{ id: string, label: string }>>`。两种状态类型与任务 1 的公开形状一致。IPC channel 使用 `codex:status`、`codex:start`、`codex:attempt`、`codex:open-verification`、`codex:cancel`、`codex:disconnect`、`codex:list-models`。生产与开发 Electron 都使用启动时生成的 `x-novel-token`。

- [ ] **写失败测试** `tests/codex-desktop-boundary.test.mjs`。以注入的会话和窗口替身检查 `desktop request header is scoped to the trusted window and API origin`，断言开发和生产 API 请求注入对应令牌，外部窗口、其他 origin、非 API URL 和不可信 frame 不注入。`subscription IPC allows an active attempt and fixed verification URL only` 断言错误 sender、frame、attempt ID 被拒绝，请求不会打开调用者自传 URL。集成测试设置令牌并动态导入 Express，断言没有令牌的 `/api/models` 返回 401，携带正确令牌返回 200。
- [ ] **运行失败测试** `node --test tests/codex-desktop-boundary.test.mjs`，预期可信窗口与 IPC 接线缺失。
- [ ] **实现生命周期与接线**。`electron/main.mjs` 在 `app.whenReady()` 之后读取 safeStorage 并创建服务，数据文件使用当前 `NOVEL_DATA_DIR`，启动 Express 前注册同进程客户端。开发 origin 从已验证的 `ELECTRON_START_URL` 解析，生产用 `apiOrigin`。在对应 origin 的 `/api/*` 复用 session 请求头拦截，检查可信 `webContents` 和可用的 frame origin。Vite 沿用透明代理，进程退出调用 `shutdown()`。仅可信主 frame 可调用新的 IPC，打开官方验证页前检查该尝试仍有效。
- [ ] **运行通过测试** `node --test tests/codex-desktop-boundary.test.mjs`，预期全部通过。分别验证独立 Web 启动仍正常，普通浏览器访问 Electron 开发端口上的 `/api/models` 返回 401，桌面窗口读取模型和现有 SSE 任务仍成功。
- [ ] **提交任务** `feat: connect subscription sessions to the trusted Electron window`，范围限任务 4 文件与测试。

### 任务 5　AI 模型界面与整体验收

**接口** `ModelProvider` 增加 `'chatgpt-subscription'`。`CodexConnectionDialog` 接收 `onClose` 和 `onConnected`，使用 `window.novelAPI.codex` 状态，在设置页的既有模型表单中打开。设置页从订阅目录选择模型或手填 ID，断开和切换账号后及时刷新状态，显式改绑时才提交新 `connectionRef`。保存、默认模型、作品选模及测试连接继续使用现有 API。

- [ ] **记录修改前行为**。在桌面开发窗口打开「设置 → AI 模型 → 添加模型」，复现缺失 ChatGPT Subscription 入口。记录传统 OpenAI、Gemini 和本地配置入口，作为更改后的回归用例。
- [ ] **实现模型交互**。在 `Settings.tsx` 复用现有表单和弹窗组件。设备码窗提供复制、打开官方验证页、取消和可读状态。结束或重开时拒接较早轮询的结果。账号状态与模型记录分开显示，不提供 API Key 和地址输入。模型选择器和设置分组显示订阅名称与适用状态，旧模型选项保持兼容。`src/lib/api.ts` 和 `src/lib/errors.ts` 保留安全错误码，分别显示需重新连接、账号不匹配、模型权限和额度状态。
- [ ] **运行构建与回归测试**。运行 `npm.cmd run typecheck`、`npm.cmd run build`、`npm.cmd run lint`、`npm.cmd run format:check -- --end-of-line auto` 和 `npm.cmd test`。预期构建、检查和测试均通过，记录已知的 ESLint 警告。用一个订阅 mock 写作请求及一个 mock 管家请求验证共享流入口，确认正文展示及现有应用动作校验仍然执行。
- [ ] **验证桌面开发版和本地安装版**。使用 `npm.cmd run app` 验证开关入口、尝试取消和状态清理、目录回退手填、普通浏览器 401、旧模型编辑和作品模型切换。使用 `npm.cmd run app:build` 构建 Windows 安装包，在独立验收数据目录启动打包版本，验证入口存在及受信窗口行为。保留用户现有数据和运行实例，切换端口占用时只关闭自己启动的进程或通过用户授权处理现有实例。
- [ ] **走查有授权的设备码链路**。由账号所有者在官方页面批准设备码。完成指定模型测试、长章节生成、创作管家问答、重启后的模型复用、断开和同账号重连。记录上游错误与受影响功能，如果账户授权暂不可用，明确记录真实联调待验，并保留 mock 与桌面验证结果。
- [ ] **提交任务** `feat: add ChatGPT Subscription to AI model settings`，提交前复核分支差异和验收结果。
