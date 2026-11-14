/**
 * 管家工具注册表 —— 管家能力的单一真源。
 *
 * 一种管家动作（tool）此前要在四个地方各登记一次：后端权限分级 ACTION_TIERS、
 * 后端 apply 的巨型 if、后端 undo 的 if 链、前端 ACTION_META；提示词里的动作清单
 * 还是第五份手写副本。漏改任一处的表现是「动作被静默拒绝」，从现象几乎无法定位根因。
 *
 * 这个文件把「一种动作是什么」集中声明：分级、归类、text 字段的形态、一句话说明。
 * 目前被这三处消费：
 *   1. server/app.mjs 的权限判定与拒绝原因（ACTION_TIERS / actionHint）
 *   2. 自愈回环的回执：动作被拒时把该动作的 text 形态提示一并回喂给模型，提高修正成功率
 *   3. tests/action-catalog.test.mjs —— 与 types.ts 的联合类型、前端 ACTION_META 做交叉校验
 *
 * 参考的是 OpenCode / Claude Code 这类 coding agent 的做法：工具自描述，
 * 校验与提示由工具定义派生，而不是散落在调用点。
 */

/** 权限分级：edit 内容编辑（安全）/ execute 触发后台任务 / danger 破坏性操作 */
export const TIERS = ['edit', 'execute', 'danger']

/**
 * text 字段的形态。模型最常见的失败就是这一步给错：
 * 把该给 JSON 字符串的写成裸对象、把该给纯数字的写成中文数字。
 */
export const TEXT_KIND = {
  text: 'text',
  json: 'json',
  number: 'number',
  enum: 'enum',
  name: 'name',
  none: 'none'
}

/** 被拒时回喂给模型的形态提示 */
const KIND_HINT = {
  text: 'text 要放进一个字符串里，直接用 \\n 换行，不要写成对象',
  json: 'text 必须是 JSON **字符串**（引号要转义），不要直接把对象给 text',
  number: 'text 必须是纯数字的字符串，例如 "30"，不要写「三十」或裸数字',
  enum: 'text 必须是指定枚举值之一，拼写要与清单完全一致',
  name: 'text 必须是已存在对象的精确名称，不能是新造的名字',
  none: '该动作不需要 text（内容通过 chapter 等其它字段表达）'
}

/**
 * 全部管家动作。
 * category 只用于归类呈现；kind 决定自愈回环给出的形态提示；summary 供人阅读与文档。
 */
export const TOOLS = [
  // ── 作品字段（整体替换） ──
  { name: 'synopsis', tier: 'edit', category: '作品字段', kind: 'text', summary: '替换全书简介' },
  { name: 'title', tier: 'edit', category: '作品字段', kind: 'text', summary: '替换书名' },
  { name: 'genre', tier: 'edit', category: '作品字段', kind: 'text', summary: '替换类型' },
  { name: 'worldview', tier: 'edit', category: '作品字段', kind: 'text', summary: '替换世界观' },
  {
    name: 'masterOutline',
    tier: 'edit',
    category: '作品字段',
    kind: 'text',
    summary: '替换整份总纲（仅明确要求重写时）'
  },
  {
    name: 'styleProfile',
    tier: 'edit',
    category: '作品字段',
    kind: 'text',
    summary: '覆盖风格档案（拆书产出，需作者确认）'
  },
  { name: 'element', tier: 'edit', category: '作品字段', kind: 'text', summary: '追加剧情元素' },
  { name: 'extraRequirement', tier: 'edit', category: '作品字段', kind: 'text', summary: '追加额外写作要求' },
  { name: 'chapterCount', tier: 'edit', category: '作品字段', kind: 'number', summary: '全书章节数' },
  { name: 'targetWords', tier: 'edit', category: '作品字段', kind: 'number', summary: '每章目标字数' },
  // ── 人物 ──
  {
    name: 'protagonist',
    tier: 'edit',
    category: '人物',
    kind: 'json',
    summary: '整体替换主角（JSON：name/role/personality/appearance/background/notes）'
  },
  { name: 'addCharacter', tier: 'edit', category: '人物', kind: 'json', summary: '新增配角（JSON，name/role 必填）' },
  {
    name: 'updateCharacter',
    tier: 'edit',
    category: '人物',
    kind: 'json',
    summary: '更新已有配角（JSON 需含现有 name）'
  },
  { name: 'removeCharacter', tier: 'edit', category: '人物', kind: 'name', summary: '删除配角（text 为姓名）' },
  // ── 剧情线 ──
  {
    name: 'addPlotline',
    tier: 'edit',
    category: '剧情线',
    kind: 'json',
    summary: '新增剧情线（JSON：name/type/goal/description）'
  },
  {
    name: 'plotlineStatus',
    tier: 'edit',
    category: '剧情线',
    kind: 'json',
    summary: '改剧情线状态（JSON：name/status = active|paused|done|pending）'
  },
  { name: 'removePlotline', tier: 'edit', category: '剧情线', kind: 'name', summary: '删除剧情线（text 为线名）' },
  {
    name: 'addPlotBeat',
    tier: 'edit',
    category: '剧情线',
    kind: 'json',
    summary: '给剧情线加节点（JSON：plotline/title/summary/chapter）'
  },
  // ── 大纲 ──
  {
    name: 'chapterPrompt',
    tier: 'edit',
    category: '大纲',
    kind: 'text',
    summary: '改某章的本章指令（chapter 为章号）'
  },
  { name: 'outlineSummary', tier: 'edit', category: '大纲', kind: 'text', summary: '改某章大纲摘要' },
  { name: 'outlineTitle', tier: 'edit', category: '大纲', kind: 'text', summary: '改某章标题' },
  {
    name: 'addOutline',
    tier: 'edit',
    category: '大纲',
    kind: 'json',
    summary: '末尾新增一条大纲（JSON：title/summary）'
  },
  { name: 'deleteOutline', tier: 'edit', category: '大纲', kind: 'none', summary: '删除某章大纲（chapter 为章号）' },
  // ── 预置 ──
  { name: 'applyStyle', tier: 'edit', category: '预置', kind: 'name', summary: '套用文风（text 为文风精确名）' },
  { name: 'applyTemplate', tier: 'edit', category: '预置', kind: 'name', summary: '套用模板（text 为模板精确名）' },
  { name: 'applySkill', tier: 'edit', category: '预置', kind: 'name', summary: '启用写作技能' },
  { name: 'removeSkill', tier: 'edit', category: '预置', kind: 'name', summary: '停用写作技能' },
  // ── 作品偏好 ──
  { name: 'pov', tier: 'edit', category: '作品偏好', kind: 'enum', summary: '叙事视角（text "first" / "third"）' },
  {
    name: 'linkContext',
    tier: 'edit',
    category: '作品偏好',
    kind: 'enum',
    summary: '写下一章是否关联前文（"true"/"false"）'
  },
  {
    name: 'mobileReading',
    tier: 'edit',
    category: '作品偏好',
    kind: 'enum',
    summary: '手机阅读优化（"true"/"false"）'
  },
  { name: 'model', tier: 'edit', category: '作品偏好', kind: 'name', summary: '切换本书模型（text 为模型名）' },
  // ── 正文 ──
  {
    name: 'chapterContent',
    tier: 'edit',
    category: '正文',
    kind: 'text',
    summary: '写入/覆盖整章正文（chapter 为章号）'
  },
  { name: 'appendChapter', tier: 'edit', category: '正文', kind: 'text', summary: '在章末追加正文' },
  {
    name: 'editParagraph',
    tier: 'edit',
    category: '正文',
    kind: 'json',
    summary: '改写某段或连续几段（JSON：start/count?/replacement）'
  },
  { name: 'insertParagraph', tier: 'edit', category: '正文', kind: 'json', summary: '在第 start 段前插入新段落' },
  {
    name: 'deleteParagraph',
    tier: 'edit',
    category: '正文',
    kind: 'json',
    summary: '删除某段或连续几段（JSON：start/count?，或 "5" / "5,6,7"）'
  },
  // ── 素材 / 界面 / 建书 ──
  {
    name: 'addMaterial',
    tier: 'edit',
    category: '素材与界面',
    kind: 'text',
    summary: '存入素材库（text 为内容，或 JSON {title,content}）'
  },
  // ── 联网检索 ──
  {
    name: 'webSearch',
    tier: 'edit',
    category: '联网检索',
    kind: 'text',
    summary: '检索网页（text 为检索词；服务端执行后把来源回传，你再基于来源回答）'
  },
  {
    name: 'fetchPage',
    tier: 'edit',
    category: '联网检索',
    kind: 'text',
    summary: '读取公网网页正文（text 为 URL；仅摘要不够时使用）'
  },
  {
    name: 'navigate',
    tier: 'edit',
    category: '素材与界面',
    kind: 'enum',
    summary: '跳转页面（home|settings|shelf|bible|outline|write|refine|read）'
  },
  {
    name: 'createNovel',
    tier: 'edit',
    category: '素材与界面',
    kind: 'none',
    summary: '不在已有作品内输出；建书请走管家的「创建新书」入口'
  },
  // ── 触发后台任务 ──
  { name: 'generateMaster', tier: 'execute', category: '后台任务', kind: 'none', summary: '已下线，不要输出' },
  { name: 'generateOutline', tier: 'execute', category: '后台任务', kind: 'none', summary: '已下线，不要输出' },
  { name: 'rewriteOutline', tier: 'execute', category: '后台任务', kind: 'none', summary: '已下线，不要输出' },
  { name: 'writeChapter', tier: 'execute', category: '后台任务', kind: 'none', summary: '已下线，不要输出' },
  { name: 'generateAll', tier: 'execute', category: '后台任务', kind: 'none', summary: '已下线，不要输出' },
  {
    name: 'continueChapter',
    tier: 'execute',
    category: '后台任务',
    kind: 'text',
    summary: '续写（chapter 为章号，text 可空）'
  },
  { name: 'polishChapter', tier: 'execute', category: '后台任务', kind: 'text', summary: '润色' },
  {
    name: 'reviseChapter',
    tier: 'execute',
    category: '后台任务',
    kind: 'text',
    summary: '按问题修改（text 为问题描述）'
  },
  { name: 'deaiChapter', tier: 'execute', category: '后台任务', kind: 'text', summary: '降 AI 痕迹' },
  {
    name: 'detectAI',
    tier: 'execute',
    category: '后台任务',
    kind: 'text',
    summary: '检测 AI 痕迹（text 为章号如 "1,2,3"）'
  },
  { name: 'inspire', tier: 'execute', category: '后台任务', kind: 'none', summary: '灵感启发' },
  { name: 'consistencyCheck', tier: 'execute', category: '后台任务', kind: 'none', summary: '全书一致性检查' },
  // ── 破坏性 ──
  { name: 'deleteNovel', tier: 'danger', category: '破坏性', kind: 'none', summary: '删除本书（进回收站）' },
  { name: 'deleteChapter', tier: 'danger', category: '破坏性', kind: 'none', summary: '删除某章（chapter 为章号）' },
  { name: 'clearChapters', tier: 'danger', category: '破坏性', kind: 'none', summary: '清空全部正文' }
]

/** 动作名 → 权限分级（server/app.mjs 的权限判定直接用这张表） */
export const ACTION_TIERS = Object.fromEntries(TOOLS.map(t => [t.name, t.tier]))

/** 动作名 → 工具定义 */
export const TOOL_BY_NAME = Object.fromEntries(TOOLS.map(t => [t.name, t]))

/**
 * 动作被拒时附加给模型的「text 形态」提示。
 * 模型最常见的失败就是 text 形态给错，光告诉它「被拒了」它往往改不到点上。
 * 未知动作（老服务端 / 新增未同步）返回空串。
 */
export function actionHint(name) {
  const tool = TOOL_BY_NAME[name]
  // 未知动作（老服务端 / 新增未同步）与「本来就不需要 text」的动作都不给提示，
  // 免得回执里塞无用信息干扰模型。
  if (!tool || tool.kind === TEXT_KIND.none) return ''
  const hint = KIND_HINT[tool.kind]
  return hint ? `（该动作要求：${hint}）` : ''
}

/** 按归类列出动作，供文档与调试使用 */
export function listTools(category) {
  return category ? TOOLS.filter(t => t.category === category) : TOOLS
}
