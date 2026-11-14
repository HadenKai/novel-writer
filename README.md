# 小说工坊（Novel-Writer / AI Novel Studio）

一个 **离线优先的桌面长篇中文小说创作工具**：左边写设定、中间策划总纲/大纲、右边让 AI 逐章生成正文，
辅助以「创作研讨（与 AI 对话管家）」「精修（续写/润色/修改/降AI）」「成书（阅读/编辑/导出）」「参考小说分析」
「素材与草稿库」等能力，数据全部存在本机。

> 本文件面向**其他 AI / 开发者**，读完即可上手：能定位任意功能在哪个文件、数据存哪、请求怎么发、AI 怎么接。

---

## 1. 技术栈

| 层 | 选型 | 位置 |
| --- | --- | --- |
| 桌面壳 | Electron 31（`static` Electron 内置，单实例锁、内置本地 HTTP 服务、导出另存、文件夹选择） | `electron/` |
| 前端 | React 18 + React Router 6 + TypeScript + Tailwind | `src/` |
| 后端 | 内置 **Express** 本地 HTTP 服务（无构建、直接跑 ESM 源码） | `server/` |
| 状态/数据 | 全部为盘上 JSON，前端 `fetch` 本地 API | `SERVER DATA_DIR` |
| 构建 | vite + tsc（前端），electron-builder（打包 NSIS 安装版 + Portable 绿色版） | `package.json` |
| 测试 | `node --test`（当前 105 条离线用例） | `tests/` |

运行时不需要任何外部服务：Electron 启动后 `electron/main.mjs` 的 `createWindow()` 动态 `import('../server/app.mjs')` 并
`startServer(3789, { strictPort: true })` 起本地 API，窗口再 `loadURL(http://127.0.0.1:<port>)`。
后端与主进程**同进程**运行，`main.mjs` 顶部有 `uncaughtException/unhandledRejection` 兜底（写 `crash.log`，不弹二次框）。

---

## 2. 目录结构

```
novel_agent/
├─ electron/
│  ├─ main.mjs       # 主进程：单实例锁、注入 NOVEL_DATA_DIR/NOVEL_ACCESS_TOKEN、建窗口、下载与 IPC
│  └─ preload.cjs    # contextBridge 暴露 window.novelAPI.pickFolder()
├─ server/
│  ├─ index.mjs      # 独立运行后端入口：startServer(PORT||3789)
│  ├─ app.mjs        # 全部 REST API、任务系统、导出、参考分析、管家动作执行器（约 5100 行）
│  ├─ store.mjs      # 存储底座：DATA_DIR 各目录与搬迁回退、原子读写 readJson/writeJson、
│  │                 #   版本快照、每文件写队列、mtime 读缓存（LRU 上限）、回收站、ID_RE、appendLog（体量轮转）
│  ├─ stats.mjs      # 每日码字统计：只在「手动保存章节净增字」时记正增量，读时折叠为按日总量
│  ├─ sensitive.mjs  # 敏感词/过审检测：离线内置词典（政治/涉黄/暴力/违禁/辱骂/导流）+ 导流正则，只提示不拦截
│  ├─ ai.mjs         # 所有提示词组装 + 流式解析（约 2000 行）
│  ├─ ai-transport.mjs # 供应商传输层：OpenAI 兼容 SSE / Gemini 原生、normalizeOpenAIBase、重试与截断
│  ├─ models.mjs     # 模型 CRUD/探测/导入、resolveConn、预设与技能仓库
│  ├─ kb.mjs         # 知识库：切块 + 零依赖中文检索 + 库内问答历史
│  ├─ presets.mjs    # 内置文风 AUTHOR_STYLES / 模板 PROMPT_TEMPLATES / 技能 BUILTIN_SKILLS
│  ├─ agent/tools.mjs # 管家动作注册表 TOOLS 与三级权限 ACTION_TIERS 的单一真源
│  └─ skills/        # 随应用发布的内置 Skill 包（Markdown frontmatter，含来源与许可说明）
├─ src/
│  ├─ App.tsx        # 布局 + 路由 + 主题 + Alt+1~9 快捷导航
│  ├─ lib/api.ts     # 前端唯一 API 客户端（所有后端调用集中于此，返回 TS 类型）
│  ├─ lib/constants.ts
│  ├─ types.ts       # Novel/Chapter/Plotline/ModelConfig/GenJob/KbMeta/... 全部核心类型
│  └─ pages/         # Home(书架), Studio(工作台·?tab=), Butler(本书管家), Knowledge(知识库),
│                    # Shelf(素材), Settings(模型), 及 Workspace/Refine/Library/ChapterEditor 等工作区子组件
├─ tests/            # node:test 用例（ai 解析 + API 冒烟 + 参考作品/回收站/素材/字数告警/知识库）
├─ release/out/      # electron-builder 唯一输出目录（Setup.exe + Portable.exe + win-unpacked）
└─ package.json      # scripts / electron-builder 配置（build 字段）
```

---

## 3. 数据存储（最重要）

### 3.1 数据目录（`DATA_DIR`）

- **桌面版**：`process.env.NOVEL_DATA_DIR = app.getPath('userData')/novel-data`
  （Windows 上即 `C:\Users\<你>\AppData\Roaming\novel-writer\novel-data`，在 `electron/main.mjs` 顶部注入，
  **必须先于** `import('../server/app.mjs')`，否则后端顶层会在只读 asar 里建目录报 ENOTDIR）。
- **纯后端跑**（`npm start` / 测试）：未注入时用项目内 `server/../data/`；若不可写则回退到
  `~/.novel-writer-data`（见 `server/store.mjs` 的 DATA_DIR 块）。**回退不再静默**：记 `DATA_DIR_RELOCATED`，
  `GET /api/settings` 的 `storage.relocated` 与设置页「数据位置」卡片会把搬迁事实摆给用户。

**外部 AI 请注意**：`NOVEL_DATA_DIR` 由 Electron 注入，**不要**用别的目录；CLI 调试时要对齐同一个目录。

### 3.2 目录/文件清单

| 路径（相对 DATA_DIR） | 内容 |
| --- | --- |
| `novels/<id>.json` | 每本书一个文件：完整设定 + 大纲 + 章节正文（核心数据）。`<id>` 形如 uuid，只允许 `[A-Za-z0-9_-]{1,64}`（`ID_RE`） |
| `novels/<id>.json.bak` | 写前备份（原子写入的一部分）。主文件仍在时保留作崩溃恢复；主文件被删/被移走后由 `pruneOrphanBaks()` 回收，不留正文残骸 |
| `history/<id>.json` | 版本历史：覆盖类操作前自动快照，可回滚（`/api/novels/:id/history`） |
| `chats/<id>.json` | 每本书的「创作研讨」对话记录（多轮持久化） |
| `recycle/<id>/{novel,history,chat,meta}.json` | 回收站：删除=把上述文件整体移入此处，可恢复 |
| `skills/*.md` | 用户自定义「写作技能」（Markdown 定义，每本书可选多个）；随应用发布的内置包在 `server/skills/*.md`，两者按 id 合并，重名不重复 |
| `models.json`  | **全部模型连接配置，含明文 API Key**。改进位一言蔽之：**切勿外泄/入库/进日志** |
| `settings.json` | 阅读偏好等 App 级设置（`AppPrefs`） |
| `shelf.json` | 素材与草稿库（跨书共享） |
| `kb/<kbId>/kb.json` | 知识库：一个库一个文件，含 meta + docs + 切块后的 chunks（内联词频索引）+ 问答历史 qa |
| `backups/` | 全量备份导出：每日 `auto_<日期>.json`（只留最近 7 份）+ 恢复前的 `pre_restore.json` |
| `presets/custom-*.json` | 用户自定义文风 / 模板（`makeCustomStore`） |

### 3.3 关键数据形状（`src/types.ts`）

- `Novel`：id、title、genre、modelId（本书默认模型）、`characters[]`、`masterOutline`（总纲）、`outline: ChapterOutline[]`、
  `chapters: Chapter[]`、`plotlines: Plotline[]`、`world`、`style`、`skills[]`、`parsed`（AI 解析出的设定）、`status`、
  `targetWords`、`prefs`（linkContext 关联前文 / mobileReading 手机适配）等。
- `Chapter`：index、title、content、words、status（draft/done）、summary。
- `ModelConfig`：id、name、baseUrl、apiKey、model、provider（`openai|gemini`）、temperature、thinkingLevel（`LOW/MEDIUM/HIGH`）、isDefault。
- `GenJob`：后台任务描述（type/kind/status/stream/reasoning/error/chapterIndex/batch/modelId…）。

### 3.4 IO 规范

- 所有 JSON 读写走 `readJson` / `writeJson` / `readJsonAsync` / `writeJsonAsync`（`server/store.mjs`）：原子写 = `.tmp` → fsync → 复制旧版 `.bak`
   → 重命名；读自动回退 `.bak`。**外部代码新增持久化也应走这套，别直接用 `fs.writeFileSync` 覆盖。**
- `saveNovel` 前自动 `pushHistory`（覆盖类操作留快照）。

---

## 4. 后端 API（全部 `server/app.mjs`，前缀 `/api`，JSON 输入输出）

鉴权：桌面版所有 `/api` 请求需带请求头 `x-novel-token`（Electron 在 `webRequest.onBeforeSendHeaders`
自动注入给本窗口 127.0.0.1/localhost 请求，`electron/main.mjs` 的 `onBeforeSendHeaders`）。无令牌注入（`npm run dev/start`）则放行。

### 4.1 模型管理
| 端点 | 说明 |
| --- | --- |
| `GET/POST /api/models` `PUT/DELETE /api/models/:id` `DELETE /api/models` | 模型 CRUD / 批量删（返回会掩码 apiKey：`sk-abc **** xxxx`） |
| `POST /api/models/probe` | 用传入的 baseUrl+apiKey 探测中转站 `/models` 列表 |
| `POST /api/models/import` | 一键拉取该站全部模型批量入库（`/v1` 自动补） |
| `POST /api/models/import-group` | 按中转站分组一键补充导入：复用该站已有模型的密钥，拉全量并去重只增新（前端每组一行按钮） |
| `POST /api/models/stations/name` | 给中转站分组自定义名字（写 `station-names.json`，空串清除；所有模型下拉框按此名分组显示） |
| `POST /api/models/:id/test` | 用该模型发一条「回复：连接成功」测试连通 |
| `POST /api/models/:id/list` | 拉该模型可用模型名列表 |

关键函数：`listModels()` 每次读文件都会跑 `normalizeModel()`（`models.mjs`）——**地址去空白 + OpenAI 兼容自动补 `/v1`**
（内部走 `ai-transport.mjs` 的 `normalizeOpenAIBase`）。`resolveConn(modelId)`（`models.mjs`）决定用哪个连接：指定的 > 全局 isDefault > 列表第一项。
所有 `models.json` 改写统一走 `mutateModels()` 事务（读→改→密钥保护在一次文件队列里完成），删除/变更模型时 `detachNovelsFromModels()`
逐本走 `withFile`，不会盖掉章节/任务在途的写事务。

### 4.2 小说 / 章节
`GET/POST /api/novels`、`GET/PUT/DELETE /api/novels/:id`、`PUT /api/novels/:id/prefs`（轻量偏好，不整书覆盖）、
`PUT /api/novels/:id/chapters/:index`（改标题/正文）、`DELETE .../chapters/:index`、`POST /api/novels/:id/import`
（txt/md 全文按标题切章导入，`replace` 可清空重建）、`POST /api/novels/:id/replace`（查找替换，支持 dryRun）、
`GET /api/novels/:id/stats`（字数统计 + 与 targetWords 偏差 ±30% 的告警章节）。

### 4.3 后台生成任务（GenJob）
- `POST /api/generate/master` 总纲
- `POST /api/generate/outline` 分段大纲（`mode: append|replace`，`count` 章数，`isFinal` 结局段）
- `POST /api/generate/outline-rewrite` 重写指定的若干章大纲
- `POST /api/generate/chapter` 写单章
- `POST /api/generate/all` 连续生成剩余章节（一个任务串行写完，单任务上限 200 章防失控）
- `POST /api/generate/{continue,polish,revise}` 精修三件套（续写/整章重写润色/通读后按问题修改）
- `POST /api/generate/batch-refine` 批量精修（mode 含 `deai` 降AI重写）
- `POST /api/ai/detect` AI 痕迹检测、`POST /api/ai/inspire` 灵感启发、`POST /api/ai/consistency` 全书一致性矛盾检查
- `POST /api/chat` 创作研讨（守护对话，可让 AI 执行「代改动作」）
- 查询/控制：`GET /api/jobs/:id`、`GET /api/novels/:id/job`（当前主要任务）、`GET /api/novels/:id/jobs`、
  `POST /api/jobs/:id/stop`（停笔 = abort 底层流）

任务系统原理（`server/app.mjs`，函数 `registerJob` / `scheduleCleanup` / `startJobRoute` / `spawnJob`）：`jobs = Map`；`startJob` 里「同书同类任务互斥」返回 409，
不同类可并行；`startJob` 用 `Promise.resolve().then(dispatch)` 跑 **master / outline(rewrite) / outline / chapter** 四类 runner；
detect/inspire/chat/consistency 在各自路由里 `registerJob` 后内联 IIFE 执行。结束置 done/stopped/error，
30 分钟后自动清理（`scheduleCleanup`）。前端靠 1.2s 轮询，无 WebSocket。

### 4.4 研讨与历史
`GET/DELETE /api/novels/:id/chat`、`POST /api/novels/:id/chat/undo`（撤销 AI 代改的动作）、
`GET /api/novels/:id/history`、`POST /api/novels/:id/history/:hid/restore`。

### 4.5 预设 / 技能
`GET /api/presets`（返回内置+自定义文风、模板）、`POST/PUT/DELETE /api/presets/styles|styles/:id|templates|templates/:id`、
`GET/POST/PUT/DELETE /api/skills*`、`POST /api/skills/import`。
技能来源三处按 id 合并、重名不重复（`app.mjs allSkills()`）：随应用发布的 `server/skills/*.md`（`builtIn: true`，
带 `sourceRepo/sourceLicense/version`）> `presets.mjs BUILTIN_SKILLS`（旧内置，兼容保留）> 用户 `DATA_DIR/skills/*.md`
（可编辑/删除）。导入同名技能按 409 跳过。

### 4.6 系统性功能
- **参考小说分析**：`POST /api/novels/:id/scan-folder`（选文件夹扫描 *.txt/*.md，指纹去重，返回 `hasNew`）、
  `POST /api/novels/:id/analyze-references`（AI 提炼人物/设定/写法，供学习，同步请求）、
  `POST /api/novels/:id/deconstruct-references`（**拆书报告 = 后台 GenJob**：逐块喂结构给 AI 再汇总成可模仿的报告，落
  `refbooks/<id>/拆书报告-<时间>.md`；长任务可轮询 / 可停笔 / 关弹窗后仍继续，返回 `jobId`）、`POST /api/novels/:id/apply-analysis`（写入设定）。
  → `electron` 侧 `ipcMain.handle('pick-folder')` + `preload.cjs` 的 `window.novelAPI.pickFolder()` 提供选目录。
- **每日码字统计**：`GET /api/stats/daily?days=&novelId=`（`stats.mjs`）；仅「手动保存章节」的正字数增量计入，AI 生成/导入/排版不计。
- **敏感词 / 过审检测**：`POST /api/analysis/sensitive`（`sensitive.mjs`，离线词典 + 导流正则，返回按章分组命中，只提示不拦截）。
- **导出**：`GET /api/novels/:id/export?format=md|txt`、`/export/epub`（自写 EPUB 打包）、`/export/html`。
- **回收站**：`GET /api/recycle`、`POST /api/recycle/:id/restore`、`DELETE /api/recycle/:id`（彻底删除）。
- **素材与草稿**：`GET/POST /api/shelf`、`PUT/DELETE /api/shelf/:id`（跨书共享）。
- **备份**：`GET /api/backup`（全量 JSON，不含 models.json 密钥）、`POST /api/backup/restore`（**恢复前先落 `backups/pre_restore.json` 快照**，
  旧备份覆盖新状态不再是不可逆；生成快照失败则拒绝恢复）。恢复路由的请求体上限单独放宽到 1gb（其余路由仍是 20mb），
  否则整库备份会卡在全局上限上、出现「能导出不能恢复」。每日首次启动另有 `auto_<日期>.json` 自动备份，只留最近 7 份。
- **启动/每日维护**：`gcAttachments()` 回收无引用聊天附件、`pruneOldRecycle()` 清理超 90 天回收站条目、
  `pruneOrphanBaks()` 清理主文件已不存在的 `.bak`（删除作品后不留正文残骸）（`server/app.mjs`）。
- **阅读偏好**：`GET/PUT /api/settings`（字号/行距），本地持久化到 `settings.json`。

### 4.7 AI 设定解析
`POST /api/ai/parse-settings`：喂一段设定文字 + 本书现有设定 → AI 结构化补全 → 落 `novel.parsed` + characters/world/plotlines。

### 4.8 知识库（对标 ima 的三栏：列表 / 内容 / 问答）
文档按段落切成 ~480 字块并内联词频索引，检索是**零依赖字符级**（中文 2-gram + 英文数字词，TF×IDF 打分），不引向量库。与素材库分工：素材整体带进上下文，知识库按查询检索取用。

| 端点 | 说明 |
| --- | --- |
| `GET/POST /api/kb` `DELETE /api/kb/:id` | 知识库增删查（列表只回元信息，不带块文本） |
| `POST /api/kb/:id/docs` | 加文档：`content` 贴文本 / `base64` 上传浏览器选中的文件（服务端 `decodeRefText` 统一 UTF-8/GBK）/ `folderPath` 批量导入 `.txt`/`.md` |
| `DELETE /api/kb/:id/docs/:docId` | 移除文档（连带其块，不动源文件） |
| `GET /api/kb/search?q=&topK=&kb=` | 检索；`kb` 限定单库（库内问答/前端预览用），不传则跨全部库 |
| `GET/DELETE /api/kb/:id/qa` | 库内问答历史（存 kb.json 的 `qa`，封顶 30 轮） |
| `POST /api/kb/ask` | 基于知识库问答：`{kbId,question,modelId}` → 检索命中块 → `kbAskMessages` → **注册 `kbask` 任务**返回 `jobId`，前端轮询取流式答案、可停笔 |

关键函数：`searchKb(query,{kbIds})`（`kb.mjs`）；`kbAskMessages`（`ai.mjs`，只依据片段作答并标注来源）。
`kbask` 任务的 `novelId` 用 `kb:<id>` 占位，与小说任务天然隔离、同库问答互斥（409）。
管家对话（`/api/chat`）与逐章生成也会自动 `searchKb` 把命中块带进上下文（`kbContextText`），无需前端传参。

---

## 5. AI 接入层（`server/ai.mjs`）——接新模型/排查「AI 不回话」必读

### 5.1 供应商协议
- `provider: 'openai'` → OpenAI 兼容 `/chat/completions` SSE，**Bearer 鉴权**；
- `provider: 'gemini'` → Google 原生 `models/{model}:streamGenerateContent?alt=sse`，**`x-goog-api-key` 头**，
  参数用 `thinkingLevel`（已弃用 temperature/top_p/top_k）。

### 5.2 `normalizeOpenAIBase(raw)`（`ai-transport.mjs`）
用户常只填中转站**裸域名**（`https://relay.xxx` 或带斜杠）。此函数：
- 无路径 → 自动补 `/v1`（`https://relay.example.com` → `.../v1`，这是唯一能过 `chat/completions` 的形态）；
- 已有路径（`/v1`、`/v1beta`、`/api/paas/v4`）→ 原样保留；
- 误贴完整端点（`.../v1/chat/completions`、`.../models`）→ 回退到正确的 base。
在 `streamChat`、`normalizeModel`、probe/import/list 四处统一调用。**接新中转站时直接走它即可。**

### 5.3 `streamChat` / `streamGemini`（`ai-transport.mjs`）
标准做法：`yield { type: 'reasoning', text }` 与 `yield { type: 'content', text }` 双通道流，
前端只把 content 写入正文、reasoning 仅作进度展示。

针对 **思考型模型**（glm/gpt-4.5+ 等先吐大量 `reasoning_content` 再吐正文）的兜底（本项目此前修的核心问题）：
- 首轮 `max_tokens` 取 `maxTokens`（默认 8192，可被调用方指定如总纲 16384）；遇到「只有思考、没正文」→ 判定
  `reasoningOnly`，自动把配额逐级放大重试 `baseTokens×2^n` 直到 32768（`MAX_OUTPUT_TOKENS`），兼容 DeepSeek 官方 8192 硬上限；
- 连接超时 30s、块间隔看门狗 120s 自动中止；
- **只在还没输出任何正文时重试**（最多 2 次），已吐正文后网络失败直接报错，防重复拼接；
- SSE 流内 `{"error":{...}}`（HTTP 仍 200）→ 抛 `AI 服务错误：<真实原因>`，命中 overload/upstream/rate 等词且未吐内容时标记 `retryable`。
  注意：错误行在独立解析器中处理，不会被“忽略无法解析的行”的 catch 吞掉（此前会表现为“未返回有效内容”）；
- EOF 收尾会 flush `TextDecoder` 并处理最后一条**没有换行符**的 `data:`，避免中转站末尾丢字；
- 流正常结束但**正文、思考都没有**（中转站“静默空响应”）→ 判为 retryable 重试一次；
- `[DONE]` 置位后退出读流再校验，不对已关闭连接读挂；
- 结束时额外 yield `{ type:'meta', finishReason, truncated }`：`finish_reason=length`（Gemini 为 `MAX_TOKENS`）时
  `truncated=true`。正文任务据此把已生成内容存为**草稿**并报错，绝不把半章标成已完成（`app.mjs runChapterJob`）。

`callModel`（`ai-transport.mjs`）把 `conn` 配置并入 opts 分发给 `streamChat`；`callAI`（app.mjs 里 `const callAI = streamChat` 的别名）再做**错误翻译**
（401→提示查 key、404→提示模型名不对、429→限流、402/balance→余额不足），让前端看到人话而不是裸错误。

### 5.4 提示词函数（均在 `ai.mjs`，纯函数 → messages）
所有正文类任务先注入 `writingContract(novel, chapterIndex, kind)`（`ai.mjs`）：写清当前章号/全书规划章数、
作者本章指令与全书要求的优先级、输出边界和完成前自检，解决“创作指令不明确、被通用规则淹没”。
`chapterMessages`（正文）另注入 `progressContext`（只统计当前章之前、排除草稿）、`completedChaptersText`
（逐章**实际字数**，`countTextUnits` 按 Unicode code point 去空白统计）、`characterStateText`（最近章节状态日志 +
设定基线）与 `recentContextText`（章节摘要链 + 章末原文，摘要缺失时明确标注而非取开头）。
`masterMessages`（总纲）、`plotlineMessages`+`extractPlotlines`（剧情线）、`outlineMessages`/`outlineRewriteMessages`
（大纲）、
`dehumanizeMessages`（降AI）、`continue/polish/reviseMessages`、`detectAIMessages`（AI 检测）、`inspireMessages`（灵感）、
`consistencyMessages`（一致性）、`referenceNovelMessages`+`extractReferenceAnalysis`（参考小说）、
`chatMessages`+`extractChatActions`（研讨管家 + 代改动作解析）、`parseSettingsMessages`+`extractJsonObject`、
工具类 `extractJsonArray`/`extractJsonObject`/`cleanChapter`（容错截断 JSON/去章首标题）。

### 5.5 创作管家（研讨对话）的权限与动作系统

「研讨」页的 AI 管家拥有本软件内最完整的操作能力：它不只是聊天，还能**直接操作作品的几乎全部模块**。
机制：`chatMessages(novel, history, { applyActions, allowDangerous, ... })` 在系统提示里注入动作规范；
模型在回复末尾输出一个 ```json {"actions":[...]} 围栏；`extractChatActions`（`ai.mjs`）解析并剥离该块；
`applyChatActions(novel, {actions, skillNames}, {spawnJob, models, allowDangerous})`（`app.mjs`）逐条执行。

**权限分级（`ACTION_TIERS`，单一真源 `server/agent/tools.mjs` 的 `TOOLS` 表）**
- `edit` 内容编辑（安全）：设定文本、追加元素、数值、人物增删改、剧情线增删与节点、大纲增删/标题/摘要/指令、
  预设套用、作品偏好（pov/关联前文/手机阅读）、切换本书模型、直接写入/追加正文、**正文段落级编辑**
  （`editParagraph` 改某段/连续几段、`insertParagraph` 在某段前插入、`deleteParagraph` 删段，段号从 1 开始，
  动作带 `start/count/replacement` 的 JSON 与整章段落快照 `snapshot`，任意顺序撤销都准确）、存素材、导航。
- `execute` 触发后台任务：生成总纲/大纲/重写大纲、写单章/连续生成、续写/润色/修改/降AI、AI 检测、灵感、一致性检查。
  这些动作通过 `spawnJob()`（`app.mjs`）启动独立后台任务，与 HTTP 路由共用同一套任务调度。
- `danger` 破坏性操作：删书、删章、清空正文。**需前端单独勾选「允许危险操作」**（`allowDangerous`），否则执行器直接拒绝。

**执行反馈**：每条动作返回 `{ status, reason?, before, tier, jobId?, jobType?, jobKind? }`：
- `applied` 已写入（附 `before` 旧值，前端卡片可逐条撤销，走 `/api/novels/:id/chat/undo` → `undoChatAction`）；
- `started` 已启动后台任务（前端显示「前往查看」按钮，按 `jobType/jobKind` 跳到生成/精修页）；
- `rejected` 被拒（权限不足、目标不存在、无变化、同类任务冲突等，附 `reason`）；
- `failed` 执行异常（附 `reason`）。每个动作独立 try/catch，互不影响。

**安全/健壮性**：未知动作被拒；危险动作默认拒绝；`spawnJob` 的同书同类互斥（409）会被转成 `rejected` 反馈；
只有真正改动 novel 的动作才 `saveNovel`，纯启动任务/导航/存素材不写库，减少与并发生成的写入竞争。
前端开关：`butler`（代改与执行）与 `allowDangerous`（危险操作），见 `Butler.tsx`。

---

## 6. 前端（`src/`）

路由（`App.tsx`）：`/` → `Home`（全部作品）；`/shelf` → `Shelf`（素材与草稿）；`/kb` → `Knowledge`（知识库三栏：库列表 / 内容与文件入库 / 库内问答，详见 4.8）；
`/novel/:id` → `Studio`（一本书的唯一入口，`?tab=` 切五个工作区：`bible` 构思、`outline` 大纲、`write` 写作、`refine` 精修、`book` 成书；
信息架构的单一真源是 `src/pages/studio-tabs.ts`）；`/novel/:id/chapter/:cid` → `Studio` 写作区定位到某章；
`/butler?id=` → `Butler`（本书管家：AI 可分析、可代改、可触发生成任务，权限分级+逐条撤销，详见 5.5；
支持像编程 agent 一样「附选段」——选择章节与段落，原文带精确段号随消息发出；输入草稿、选段与滚动位置按书驻留）。
旧路径 `/novel/:id/{refine,read,chat}`、`/projects/:id` 一律重定向到上述新入口。`/settings` → `Settings`（模型管理、备份与恢复、数据位置诊断）。

前端只通过 `src/lib/api.ts` 访问后端；`types.ts` 与后端数据一一对应；主题切换、Alt+1~9 导航在 `App.tsx`。

界面风格是「墨金」（墨黑外壳、宣纸稿面、鎏金细线、朱砂印；深色默认，浅色为宣纸日间版），规范见 `docs/ink-design.md`：
- 语义令牌在 `src/index.css`（`--bg/--panel/--line/--text*/--gold*/--seal*/--jade/--paper*`），页面只用令牌，不写死色值；
- 组件原语在 `src/ui.css`（`.ink-card`、`.ink-paper`、`.ink-section-title`、`.ink-pill`、`.ink-tabs`、`.ink-subnav`、`.ink-seal` 等）；
- 水墨装饰在 `src/components/InkArt.tsx`（远山、祥云、朱砂印、鎏金圆徽、生成式书封），全部内联 SVG，离线可用；
- 标题与正文的宋体是随应用打包的 Noto Serif SC（`@fontsource-variable/noto-serif-sc`，按字符区段懒加载）。

跨页基础设施（新增 UI 请复用，不要再各写一套）：
- `components/Toast.tsx`：全局轻提示，模块级队列 + 单例 Host，`toast()/toast.success()/toast.error()`；确认/告警弹窗统一走 `components/Dialog.tsx` 的 `confirmDialog/alertDialog`。
- `components/CommandPalette.tsx` + `lib/commands.ts`：Ctrl/Cmd+K 全局面板（跳页/跳章/跳书/切主题），章节走 `?meta=1` 轻接口。
- `lib/useFixedSizeWindow.ts`：定高行虚拟滚动（Library 千章目录只渲染视口内行）；变高列表用 `index.css` 的 `.cv-auto`（content-visibility）。管家消息流用尾部窗口（`BUTLER_MSG_WINDOW`）。
- `lib/hooks/useNovel.ts`：单一作品数据源（代际计数防快速换书的陈旧响应覆盖）；`lib/useJobPoll.ts`：任务增量轮询。

---

## 7. 构建与运行

```bash
npm install
npm run dev          # 同时起 vite(5173) + 后端(3789)
npm start            # 仅后端（独立运行，无令牌、端口可向上浮动到 3789~3808）
npm test             # 当前 105 条 node:test 用例（离线，用临时 NOVEL_DATA_DIR，绝不发真实 AI 请求）
npm run typecheck    # tsc --noEmit（仅 src）
npm run lint         # eslint .
npm run format:check # prettier --check .
npm run build        # tsc + vite build（前端产物到 dist/）
npm run verify       # build + lint + format:check + test（改完提交前的全量闸门，含前端打包）
npm run app          # vite(5173) + Electron 桌面壳（联调真实 shell）
npm run app:build    # build + electron-builder --win（打包到 release/out）
```

> `react` / `react-dom` / `react-router-dom` 现列在 **devDependencies**：前端由 Vite 打进 `dist/`，
> 运行时的 `dependencies` 只剩 `express` + `cors`，electron-builder 不再把整份 react 依赖塞进 asar（省体积）。

### electron-builder（`package.json` 的 `build` 字段）
- 输出目录 **`release/out`**（唯一的产物目录；旧的多目录已合并删除）。
- target：`nsis`（`NovelWriter Setup 0.1.0.exe`，可选手动换安装目录 + 桌面快捷方式「小说工坊」）+ `portable`
  （`NovelWriter-Portable.exe`）。
- `files` 只打 `dist/**/*`、`electron/**/*`、`server/**/*`、`package.json`（即后端源码随 asar 分发，运行时解析而非编译）。

---

## 8. 安全与约定（改动时注意）

- **API Key 明文在 `models.json`**：`GET /api/models` 返回前会 `maskModel` 打码，但文件本身是明文——**禁止把 models.json、任何日志、诊断脚本写进仓库/贴给外部**。
- 本地令牌 `x-novel-token`：只允许 127.0.0.1/localhost 来源（CORS 白名单），防别的本地网页偷密钥。
- 单实例锁防双开写坏数据；`window.open` 只放行 http/https 用系统浏览器打开。
- 所有 id 走 `ID_RE` 白名单校验防路径穿越；`writeJson` 原子写防断电截断。
- 生成期间用户手改总纲/大纲会**拒绝覆盖**（拿开头快照对比），避免 AI 顶掉手工编辑。

---

## 9. 常见问题（特别是有 AI 接进来时）

### 9.1 「AI 未返回有效内容，请重试」
逐级排查：
1. **思考模型配额**：自查 `finish_reason=length` + 只有 reasoning 无 content → 代码会自动放大 `max_tokens` 重试到 32768。
   成功率取决于模型本身的思考长度，仍不够时换 `thinkingLevel: LOW` 或换模型。
2. **中转站上游/空响应**：不少中转站（如 `relay.example.com`，用户实测）在 HTTP 200 的 SSE 里塞
   `{"error":{"message":"Our servers are currently overloaded...","type":"upstream_error"}}`，或干脆返回空流。
   现在的 `ai.mjs` 会把这类错误**透出真实原因并自动重试**；之前版本是静默吞掉才显示「未返回有效内容」。
3. **地址没带 `/v1`**：裸域名对 `GET /models` 可能通（该站两个形态都 200），但 `POST /chat/completions` 裸域名会返回
   中转站**网页 HTML**；`normalizeOpenAIBase` 会在请求前自动补 `/v1`。

### 9.2 已知实测结论（2026-09）
- `https://relay.example.com/v1` + 该站 key：格式为标准 OpenAI 兼容，**写法无问题**；`gpt-5.5`/`gpt-5.6-terra`/`gpt-6-astra`
  稳定回复，`gpt-5.6-sol` 上游**时好时坏**（实测 3 次成功 1 次，其余报 upstream overloaded），`gpt-5.6-luna` 静默空响应，
  `gpt-image-2` 需要图片专用参数（400）。→ 遇「不回话」先换该站其它模型确认。
- 模型列表共 7 个：gpt-5.6-sol / gpt-5.6-terra / gpt-5.6-luna / gpt-5.5 / gpt-image-2 / gpt-6-astra / gpt-5.6-astra。

### 9.3 祝语框
与另一个「不会回复」的坑：各大厂最新推理模型的 `temperature <= 0` 或对 `temperature` 类型敏感；本项目默认 0.8，
Gemini 3 系走了 `thinkingLevel` 不走 temperature。接入新站时先按 `streamChat` 现有参数试，别乱加 max_tokens 超大值
（DeepSeek 官方上限 8192 会 400）。

---

## 10. 测试

`npm test` → `node --test "tests/**/*.test.mjs"`，覆盖：JSON 解析容错、提示词组装（含技能/剧情线/联前文/任务合同/
逐章字数/人物状态）、归一化函数、统一字数统计与上下文裁剪、SSE 错误透传/EOF 无换行/finish_reason 截断元数据、
API 冒烟（字数告警/导出/回收站/素材库/参考差异/管家动作/内置技能包/导入 4000 字上下文快照）、
纯文本解码回退（GBK→gb18030）、知识库（建库/文件入库/库内检索隔离/问答守卫）、
码字统计/敏感词/meta 轻接口、一键排版幂等、`hardening.test.mjs`（第二轮工业级加固回归：导入不丢无题正文、
整书 PUT 不抹后台新追加大纲、章号冲突顺延不删章、敏感词 ASCII 整词匹配、备份恢复前快照、删模型作品回落默认），
以及 `fixes.test.mjs`（大纲重排/中间插入不串位、手改标题不被大纲覆盖、超 20mb 备份可恢复且常规路由仍受 20mb 保护、
彻底删除后无正文残骸、无主 `.bak` 回收且保留有主 `.bak`）。
全部离线，不调用真实 AI。改核心逻辑后务必 `npm run verify` 跑通。