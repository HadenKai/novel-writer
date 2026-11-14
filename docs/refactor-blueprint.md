# 小说工坊 · 重构蓝图

> 目标：把"一整个项目逻辑都差"的体感，收敛为一套可维护的架构 + 一条符合作者心智的写作动线。
> 本蓝图分两层：**架构层**（可读性 / 可维护性）与**产品层**（信息架构 / 交互）。
>
> **进度（2026-09-23）**：Phase 0 与 Phase 2 已完成并出包，`npm run verify` 89 项测试全绿。
> 已完成 / 未完成清单见文末「七、执行进度」。

---

## 一、诊断：问题不在代码细节，在结构与归属

### 1. 一个实体，两套路由（最伤的一处）

`Novel` 是唯一的作品实体，但前端把它拆成两条互不相通的路径：

| 路径            | 承载内容                        | 文件                                                                              |
| --------------- | ------------------------------- | --------------------------------------------------------------------------------- |
| `/projects/:id` | 章节列表、章节编辑              | `ProjectDetail.tsx`(428)、`ChapterEditor.tsx`                                     |
| `/novel/:id`    | 设定（8 Tab）、管家、精修、成书 | `Workspace.tsx`(1090)、`Butler.tsx`(1376)、`Refine.tsx`(490)、`Library.tsx`(1143) |

用户在"小说项目"里看章节，要切到"设定"才能改人设。**写第 12 章时看不到第 12 章的大纲卡与相关人设** —— 正文与设定彻底隔离。这是"逻辑差"的根因。

### 2. 六页各拉各的数据，互不同步

同一份 `novel` 被独立拉取并独立持有：

`Workspace.tsx:86` · `Butler.tsx:274` · `Refine.tsx:32` · `Library.tsx:302` · `ProjectDetail.tsx:39` · `ChapterEditor.tsx:26` · `App.tsx:421`

后果：管家页改了人设，设定页不知道；AI 后台写入正文，只有 `Library.tsx:366` / `Butler.tsx:298` 手动 reload，`Workspace` 完全不在生成链路内。

→ `Workspace.tsx:96-135` 那套"选择性保存 diff（3 处 `as unknown as` 绕过类型）"是为了补救这个缺陷而写的**防御性代码**。根因不解决，这类补丁只会越来越多。

### 3. 巨型组件

| 行数 | 文件                      |
| ---- | ------------------------- |
| 4203 | `server/app.mjs`          |
| 1376 | `src/pages/Butler.tsx`    |
| 1143 | `src/pages/Library.tsx`   |
| 1090 | `src/pages/Workspace.tsx` |
| 979  | `src/pages/Settings.tsx`  |
| 737  | `server/store.mjs`        |

- `Workspace`：数据加载 + dirty 追踪 + 8 个 Tab 内联渲染(`408-1028`) + 5 个弹窗 state + 参考分析合并 + 预置增删改 + memo 工厂（`153-191/346-351`）。一个组件 ≈ 一个子应用。
- `Butler`：聊天流 + 多会话 CRUD + 导航重放守卫 + 一致性任务 + 正文兜底落库 + 动作卡片 diff + 选段面板。
- `Library`：阅读器 + 编辑器 + 一键排版 + 导入 + AI 面板 + 统计 + 导出 + 偏好同步。
- `app.mjs`：所有路由 + 7 个任务执行器 + chat + 导入导出 + 备份 + 实例锁。超长函数：applyChatActions ≈ 700 行(`1909-2677`)、/api/chat handler ≈ 138 行(`2845-2983`)。

### 4. 重复样板清单（至少 8 处）

1. **fetch + loading + error 三态**各写一遍：`Home.tsx:34-60`、`Projects.tsx:46-74`、`Refine.tsx:29-54`、`Shelf.tsx:20-32`、`ChapterEditor.tsx:23-39`、`Library.tsx:299-334`
2. **「启动任务 → 轮询 → 收尾」三份**：`Butler.tsx:339-357`、`Library.tsx:578-591`、`Refine.tsx:106-158`
3. **「getNovelJobs → jobs.find 认领」**：`Butler.tsx:285-290`、`Library.tsx:349-362`、`Refine.tsx:40-53`
4. **手写弹窗遮罩 / Esc / 焦点**：`Home.tsx:257-311`、`Shelf.tsx:231-328`、`Library.tsx:1070-1139`（只有 workspace 用了 `ModalShell`）
5. **新建作品表单**：`Home.tsx:328-391` 与 `Projects.tsx:320-413` 逐字段雷同，`Projects.tsx:372-395` 还手写了 optgroup 而不复用 `ModelSelect`
6. **错误翻译两套**：后端 `app.mjs:613-629` `upstreamFailHint` 与前端 `butler/constants.tsx:11-26` `describeModelError`，需人工同步
7. **图标表 5 份**：`App.tsx:50`、`butler/constants.tsx:63`、`Library.tsx:50`、`Settings.tsx:24`、`workspace/shared.tsx:46`
8. **样式常量 2 份**：`workspace/shared.tsx:5-7` 与 `Settings.tsx:19-21`

### 5. 动作类型散落六处

`ChatAction` 有 50+ 种 type（`types.ts:210-263`），同一枚举在 6 处各自 switch：

- 后端：`app.mjs:1848-1903`(ACTION_TIERS) · `1975-2677`(apply 巨型 if) · `2681-2842`(undo if 链)
- 前端：`butler/constants.tsx:121-175`(ACTION_META) · `Butler.tsx:539-563`(prettyActionText) · `565-684`(actionCard)

**新增一种动作，漏改任一处即静默失败**（`app.mjs:2672`）。

### 6. 其他具体缺陷

- `window.novelAPI` 同一类型断言重复 4 次：`App.tsx:271`、`Home.tsx:85`、`Workspace.tsx:673`、`ReferenceAnalysisModal.tsx:35`
- 魔法数：`maxTokens: 16384` 硬编码 6 处（`app.mjs:195,942,972,1055,2914,3610`）
- 空 `catch{}` 遍布（`app.mjs:929,2940,2966,3486`…），无统一错误中间件
- 死接口/死代码：`/api/diagnostics`(`app.mjs:1704`) 前端无映射；`api.getNovelJob`(`api.ts:295`) 未使用；`Refine.tsx:91` `job.type==='outline'` 死分支；`workspace/index.ts` 全量再导出但从未被 import
- 注释错位：`Workspace.tsx:43` 注释"单条剧情线编辑卡片"贴错组件
- 类型重复：`Library.tsx:11-20` `TypoPrefs` 与 `types.ts:411-427` `AppPrefs` 字段重叠
- 依赖数组豁免 7 处 `eslint-disable`：`App.tsx:286`、`Butler.tsx:161/291/315`、`Library.tsx:333`、`ProjectDetail.tsx:46`、`Shelf.tsx:31`

---

## 二、对标结论：值得借鉴的 5 条

| 来源                             | 借鉴点                                                                                                                                                                                                                         |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Scrivener**                    | 三栏工作台：Binder（左，章节树）+ Editor（中，正文）+ Inspector（右，本章 synopsis / 元数据 / 历史快照）。Composition mode 全屏专注。编辑器有「正文 / 卡片墙 / 大纲表」三视图。                                                |
| **Sudowrite**                    | **Story Bible 是有依赖关系的渐进链**：Braindump → 题材 / 文风 → 简介 → 人设 / 世界观 → 大纲 → 场景 → 正文。每层从上层生成，生成时读全部层。侧栏是"动词式"工具（Write / Describe / Expand / Rewrite / Feedback / Brainstorm）。 |
| **星月写作**                     | **工具箱思维**：书名 / 简介 / 大纲 / 细纲 / 黄金开篇 / 金手指 / 名字 / 人设 生成器各自独立。模型切换带简介与评分。"关联知识库"把已写章节 + 人设 + 框架喂给 AI，防失忆。                                                        |
| **蛙蛙写作**                     | **编辑器左右分屏**（左正文 / 右 AI 辅助），**划词局部优化**（续写 / 扩写 / 润色 / 改写 / 解释），空格键唤起指令。总纲 / 卷纲 / 章纲三级大纲。首页创作数据看板。                                                                |
| **AI_NovelGenerator / 蛙趣拼文** | 模块化 + 互不污染：大纲 / 角色 / 世界观 / 伏笔 / 素材 / 生成 / 精修 各自独立，角色卡强制注入章节生成。                                                                                                                         |

**你已经做得好、但被埋起来的**：`ReferenceAnalysisModal` 的"AI 拆书 + 新/变化文件指纹标记"比多数同类产品强，却藏在设定页的一个 Tab 弹窗里，应该提到工具箱一级入口。

---

## 三、目标信息架构

### 三层心智

```
书架层（跨书）    全部作品 · 素材与草稿 · 模型设置
作品层（一本书）  单一入口 /novel/:id
                 构思 · 大纲 · 写作 · 精修 · 成书
辅助层            本书管家 —— 任意工作区右侧抽屉唤起
```

### 路由收敛

| 现状                                                     | 目标                                                        |
| -------------------------------------------------------- | ----------------------------------------------------------- |
| `/projects` `/projects/:id` `/projects/:id/chapter/:cid` | `/novel/:id?tab=write&chapter=:cid`（章节树并入工作台左栏） |
| `/novel/:id`                                             | `/novel/:id?tab=bible\|outline\|write\|refine\|book`        |
| `/butler?id=`                                            | 保留为独立页，但默认以右侧抽屉形式在工作台内可用            |
| `/shelf` `/settings` `/`                                 | 不变                                                        |

`/projects` 若需保留，定位改为"书架批量管理视图"，不再承载章节编辑。

### 五个工作区的职责

| 工作区   | 承载                                                                     | 对应现状                                         |
| -------- | ------------------------------------------------------------------------ | ------------------------------------------------ |
| **构思** | Story Bible 渐进链：灵感池 → 题材/文风 → 简介 → 人设 → 世界观 → 参考分析 | Workspace 的 设定/人物/剧情线/文风/技能/参考 Tab |
| **大纲** | 总纲 → 分章大纲 → 剧情线。列表 / 卡片墙 / 表格三视图                     | Workspace 的大纲 Tab + OutlineRow                |
| **写作** | 三栏工作台：章节树 / 编辑器 / 上下文面板                                 | ProjectDetail + ChapterEditor 合并               |
| **精修** | 批量续写 / 润色 / 改写 / 去 AI 味 / 一致性检查                           | Refine                                           |
| **成书** | 阅读器、排版、导出 EPUB/HTML/MD                                          | Library                                          |

---

## 四、分阶段执行计划

### Phase 0 · 地基（不动 UI，风险最低，收益最高）

| 新增                        | 职责                                                                   | 替换掉                                                            |
| --------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `src/lib/hooks/useNovel.ts` | 单一数据源：loading / error / reload / 任务认领 / 与 `useJobPoll` 合流 | 6 页各写一遍的 fetch 三态                                         |
| `src/lib/hooks/useJob.ts`   | 启动任务 → 轮询 → 收尾 → 清理                                          | `Butler.tsx:339-357`、`Library.tsx:578-591`、`Refine.tsx:106-158` |
| `src/lib/errors.ts`         | 错误码 → 中文文案单一真源（与后端共用映射表）                          | `upstreamFailHint` + `describeModelError` 双份                    |
| `src/lib/desktop.ts`        | `window.novelAPI` 类型化单点                                           | 4 处重复断言                                                      |
| `src/lib/nav.ts`            | 路由与 `sectionLabel` 集中                                             | `App.tsx:336-347` 散落的路径正则                                  |
| `src/components/ui/`        | `Modal` / `Field` / `Icon` / `EmptyState` / `Card`                     | 3 份手写 overlay、5 份图标表、2 份样式常量                        |
| `src/constants/ai.ts`       | `MAX_TOKENS` 等魔法数集中                                              | 6 处硬编码                                                        |

验收：`npm run verify` 全绿；纯替换，无行为变化。

### Phase 1 · 架构分层

1. **`server/app.mjs` 按域拆分**（纯搬迁，风险低）
   `routes/{novels,models,presets,skills,jobs,chat,ai,import-export,backup}.mjs` + `middleware/{error,instance-lock}.mjs`
2. **ChatAction 表驱动化**（收益高，风险中）
   后端建一张元数据表 `{ type, tier, apply, undo, meta }`，apply / undo / tiers 全由它派生；
   前端 `ACTION_META` / `prettyActionText` / `actionCard` 由同一份元数据派生（元数据用 JSON 描述、两端共享）。
   收益：新增动作只改一处，漏改即编译期报错而非静默失败。
3. **`Workspace` 拆分**：8 个 Tab 各自成组件；弹窗统一走 `ModalShell`；dirty/save 抽 `useNovelDraft`；memo 工厂改 `useReducer` + Context。

### Phase 2 · 信息架构合并 + 写作工作台

1. 路由收敛（见上表），`ProjectDetail` / `ChapterEditor` 的章节树并入工作台左栏
2. 新增 `pages/studio/` 目录：
   `Studio.tsx`（三栏壳）· `ChapterTree.tsx` · `Editor.tsx` · `SelectionToolbar.tsx` · `ContextPanel.tsx`
3. 管家改为可唤起的右侧抽屉（保留 `/butler` 独立页兼容旧入口）
4. `/projects` 降级为书架管理视图

### Phase 3 · 产品化增强

- 划词 AI 动作条：续写 / 扩写 / 润色 / 改写 / 去 AI 味（复用已有 `batch-refine` 后端能力）
- "AI 工具箱"一级入口：书名 / 简介 / 黄金开篇 / 人设 / 名字 生成器 + 已有的拆书分析
- 大纲卡片墙（Corkboard）视图
- 首页创作看板：总字数 / 今日字数 / 连续天数 / 各书进度

---

## 五、验收标准

- `npm run verify`（typecheck + lint + format:check + test）全绿
- 无新增 `eslint-disable`；每消一处原有豁免都应记录
- 任一页面可独立修改而不影响其它页（不再共享隐式状态）
- 新增一种管家动作只需改 1 处
- 从"打开一本书"到"开始写第 N 章"的点击数 ≤ 2
- 写作时右侧始终可见本章大纲卡与出场人物

---

## 六、风险与约束

- **数据兼容**：`types.ts` 的字段增删必须向后兼容（老 `novel.json` 仍可读）。路由收敛需保留旧路径重定向（已有 `LegacyButlerRedirect` 先例）。
- **打包**：`electron-builder` 只打包 `dist/` `electron/` `server/`，`src/` 不入包，重构前端目录结构不影响产物。
- **不可回滚的文件**：asar 不是源码备份，前端只有压缩后的 `dist/`。**每阶段前先提交 git 或复制一份 `src/` 快照。**
- **顺序建议**：Phase 0 → 1 → 2 → 3。Phase 0/1 与产品方向无关，可无条件执行；Phase 2 会改变导航习惯，需确认后再动。

---

## 七、执行进度

### 已完成（2026-09-23，`npm run verify` 89 tests 全绿）

**Phase 0 · 地基**

- 公共层：`useNovel` / `useJob` / `useModels` / `errors` / `desktop` / `server/constants.mjs`
- 9 个页面全部接入公共层：`Refine`（参考实现）、`Home`、`Projects`、`Shelf`、`ProjectDetail`、`ChapterEditor`、`Library`、`Butler`、`Workspace`
- 错误文案单点化：`api.ts` 与 `butler/constants.tsx` 共用 `lib/errors.ts`
- `window.novelAPI` 断言从 4 处收敛为 `lib/desktop.ts` 1 处；`maxTokens: 16384` 从 6 处收敛为 `server/constants.mjs` 1 处
- 删除死代码 `src/pages/workspace/index.ts`（零引用的 barrel）

**Phase 2 · 信息架构合并**

- 新增 `pages/Studio.tsx`：一本书的唯一入口，5 个工作区（构思 / 大纲 / 写作 / 精修 / 成书），状态全部由 URL 驱动
- 新增 `pages/studio-tabs.ts`：信息架构单一真源（Studio / Workspace / App 三处共用）
- `Workspace.tsx` 的 8 个页签按「构思 / 大纲」归组，子页签状态改由 URL 驱动，组件内不再自持 tab state
- 旧路径全部重定向：`/projects/:id`、`/projects/:id/chapter/:cid`、`/novel/:id/refine|read|chat`
- 侧栏改为 5 个工作区入口 + Alt+1~9 快捷键 + 面包屑按 `tab` 取名
- 管家 `pagePath`（`butler/constants.tsx`）与后端提示词（`server/ai.mjs:1609`）同步换用新 key

**Phase 1 · 动作目录单点化（前端部分）**

- `ACTION_META` 改为 `Record<ChatAction['type'], ActionMeta>` 穷尽类型 —— 漏改即编译报错
- 52 种动作的图标 / 配色 / 是否可撤销 / 是否套用预置 / 卡片说明 / payload 美化，全部收进一张表
- 新增 `tests/action-catalog.test.mjs`，交叉校验 `types.ts` 联合 / 后端 `ACTION_TIERS` / 前端 `ACTION_META` 三张表

### 未完成（含未做理由）

| 项                                       | 理由                                                                                                        |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `Workspace.tsx` 渲染层拆分               | 需向 8 个子组件透传约 20 个 props/ops，改动面大、零功能收益                                                 |
| `server/app.mjs` 按域拆 `routes/*`       | 纯搬迁但改动面积 4200 行，值得单独一轮专门做                                                                |
| ChatAction 后端 apply/undo 表驱动化      | 约 860 行核心业务逻辑，风险过高；已用跨表校验测试兜底                                                       |
| `components/ui/`（Icon 5→1、Modal 扩容） | 5 份图标表描边宽度不一致（1.7 / 1.8），合并有视觉回归风险；`ModalShell` 需先扩契约才能吸收剩余 3 处手写弹窗 |
| Phase 3 产品化增强                       | 属新增功能（划词 AI 动作条 / AI 工具箱 / 卡片墙 / 首页看板），不在重构范围内                                |

### 有意保留的两处「看似重复」

- `Shelf` / `Library` 的手写弹窗遮罩：`ModalShell` 的契约是「单滚动面板 + 自带标题行」，而这两处是「固定头 + 仅内容滚动 + 固定底」，硬套会改变外观。
- Settings 与 workspace 的同名 `inputCls`：规格有意不同（`py-2` 带焦点态 vs `py-1.5` 紧凑），不是重复。

---

## 八、第二轮（2026-09-23 下午）：修 bug + 封面 + 管家架构强化

### 修掉一个真 bug：成书页看不到侧栏收缩按钮

`<aside>` 上的 `lg:translate-x-0` 会写出 `transform`，而 **transform 会创建层叠上下文**；叠上 `lg:z-auto` 之后，
整个侧栏子树（含右缘那个 `-right-4` 的收缩手柄）被锁死在 auto 层级里。偏偏 `Library.tsx` 的根节点是全项目
唯一带 `position: relative` 的页面根，DOM 又排在后面——它那 232px 宽、不透明的左栏正好盖住手柄位置，
于是只有成书页看不见按钮。

**修复：`lg:z-auto` → `lg:z-30`**（只用来压过页面根，仍低于页面内模态 z-50 与对话框 z-200），并加注释说明原因。
另外按需求给成书页左侧章节目录补了一个对称的收起按钮。

### 作品封面（Home 改为封面卡片网格）

- 后端：`<data>/covers/`；`GET /api/covers/:file`、`POST|DELETE /api/novels/:id/cover`；
  `Novel`/`NovelMeta` 增 `coverFile`/`coverAt`（前端用 `?v=<coverAt>` 破缓存）；彻底删除作品时连带清封面文件。
- 上传走**原始二进制**（`express.raw({ type: 'image/*', limit: 5MB })`）——最初用 JSON + data:URL 必然 413，
  因为全局 `express.json()` 的默认上限只有 100KB。文件名由服务端按 id + MIME 生成（不接受客户端路径），并加魔数校验。
- 前端：Home 由列表改为封面卡片网格，未上传时用书名首字 + 按书名取稳定金色混比的占位底色；
  悬停出「换封面 / 删除」；网格首格为「新建作品」。
- `tests/cover.test.mjs`。

### 管家：工具注册表 + 自愈回环（对标 OpenCode 的「工具—结果回喂」）

- `server/agent/tools.mjs`：54 个动作的单一真源（tier / category / kind / summary），
  派生 `ACTION_TIERS`（app.mjs 里那份手写表已删除）与 `actionHint()`。
- 自愈回环：动作被拒时把拒因 + 该动作的 text 形态提示回喂一次让模型自修（`MAX_REPAIR_ROUNDS = 1`），
  只在确有被拒动作时触发；修正动作并入同一条消息的动作快照，仍可逐条撤销。
- **覆盖率测试抓出 7 处「动作被静默丢弃」**：`plotlineStatus` / `updateCharacter` / `chapterPrompt` 等分支
  在「目标不存在」或「内容无变化」时 `continue` 而不记任何结果——作者看不到为什么没执行。
  已全部改为 `reject(...)` 并给出具体原因。这些拒因正是自愈回环的输入。
- `tests/action-coverage.test.mjs`：① 注册表里每种动作都必须走到实现分支（不落进「暂未实现」）；
  ② 用本地假中转站让模型先给坏动作、再给好动作，验证回环真的发生（2 次请求 / 回执含拒因 / 修正后落库）。

### 更新后的未完成清单

| 项                                                                   | 状态                                                       |
| -------------------------------------------------------------------- | ---------------------------------------------------------- |
| `components/ui/`（Icon 5→1、Modal 扩容）                             | 未做（5 份图标表的描边宽度不一致，合并需逐屏视觉比对）     |
| `Workspace.tsx` 渲染层拆分                                           | 未做（需向子组件透传约 20 个 props/ops，零功能收益）       |
| `server/app.mjs` 按域拆 `routes/*`                                   | 未做（纯搬迁，改动面 4200 行）                             |
| ChatAction 后端 apply/undo **逻辑体**表驱动化                        | 部分完成：分级与形态提示已抽进注册表；860 行逻辑体仍在原处 |
| 管家提示词的动作清单改由注册表生成                                   | **有意不做**：那是调过质量的自然语言规范，生成版会丢细节   |
| Phase 3 产品化增强（划词 AI 动作条 / AI 工具箱 / 卡片墙 / 首页看板） | 未做（属新增功能，不在重构范围）                           |

### 第三轮：三处 UI 修正

1. **成书页左侧目录「被截断」** —— 是上一轮引入的真 bug。`Studio` 根 div 只有 `flex-1`，
   而它的父级（Layout 里 `flex-1 overflow-y-auto` 那层）**不是 flex 容器**，`flex-1` 完全失效
   → Studio 高度塌成内容高度 → `Library.tsx` 的 `h-full` 链断裂
   → 左侧目录只有内容那么高、悬在半空（截图里就是「左边被截断、下面一片空」）。
   **修复：给 Studio 根 div 补 `h-full`**。
   教训：给页面外面再包一层组件时，必须回头确认 `h-full` / `flex-1` 的传递链在新层级下依然成立。
2. **书架卡片改为小尺寸横排**：`aspect-[3/4]` 竖版大卡 → 左 66×92 封面 + 右侧信息；
   网格 `grid-cols-1 sm:grid-cols-2`；操作按钮从封面悬停遮罩挪到卡片右下角；去掉封面渐变压暗层。
3. **撤掉「小说项目」板块**：删除 `Projects.tsx`，`/projects` 重定向到 `/`（`/projects/:id*` 保留兼容重定向）；
   侧栏入口移除，快捷键重编号为 **Alt+1~8**；原板块的「搜索书名或类型 + 排序」移植到书架并补了空态；
   `ChapterEditor` / `ProjectDetail` 面包屑的「小说项目」改为「全部作品」。

### 第四轮：管家界面（＋ 号语义修正 + 去线条）

1. **「＋」从「附选段开关」改成真正的附件入口**（原语义错位：用户直觉里 ＋ 就是传文件/图片）。
   点 ＋ 弹出三项菜单：插入图片 / 附加文档(.txt .md) / 附选段。
   - 图片：上传到 `<data>/attachments/`（随机 id 命名），随消息以多模态 content（`image_url`）发给模型，
     气泡里显示缩略图；**聊天 JSON 只存文件名**——几张截图就能把 `chats/*.json` 撑到几十 MB，不能存 dataURL。
   - 文档：发送时内联成 `【附加文档 · 文件名】` 引用块（与「附选段」同一口径，>8000 字截断），不落盘。
   - **历史轮次的图片刻意不重复发送**：烧上下文，且模型已据此作答过；只随最后一条用户消息发。
     Composer 新增 `plusMenu`（＋ 的下拉菜单）与 `topSlot`（附件缩略图位）两个插槽。
2. **去线条**：会话列表项去掉 `ring-1 + shadow`（改纯底色区分选中态）、快捷指令 chip 去掉边框、
   「＋」按钮去掉描边——这些都是「框中框」观感的来源。
3. `/api/chat` 接受 `attachments`；新增 `POST|GET /api/attachments`（原始二进制，理由同封面）。
4. 新增 `tests/attach.test.mjs`。验证：97 tests 全绿；bundle 397.76KB。
