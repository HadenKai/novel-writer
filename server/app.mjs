import express from 'express'
import cors from 'cors'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  streamChat,
  outlineMessages,
  outlineRewriteMessages,
  masterMessages,
  chapterMessages,
  continueMessages,
  polishMessages,
  reviseMessages,
  dehumanizeMessages,
  plotlineMessages,
  extractPlotlines,
  extractJsonArray,
  cleanChapter,
  parseSettingsMessages,
  extractJsonObject,
  detectAIMessages,
  inspireMessages,
  chatMessages,
  extractChatActions,
  consistencyMessages,
  referenceNovelMessages,
  deconstructChunkMessages,
  deconstructReportMessages,
  kbContextText,
  kbAskMessages,
  extractReferenceAnalysis,
  countTextUnits
} from './ai.mjs'
import { collectResearch, mergeResearch, formatResearchContext } from './research.mjs'

// 生成任务里统一用 callAI 这个名字（语义是「取一次完整回复」，底层就是流式调用）。
// 保留别名而不是改名，是为了让 11 处任务执行器读起来一致、改动面最小。
const callAI = streamChat
import { AUTHOR_STYLES, PROMPT_TEMPLATES } from './presets.mjs'
import { MAX_TOKENS } from './constants.mjs'
// 知识库（可检索文档库）：分块 + 零依赖中文检索 + 库内问答历史
import { listKb, createKb, deleteKb, addDoc, removeDoc, searchKb, listQa, pushQa, clearQa } from './kb.mjs'
// 每日码字统计：章节保存时记净增字数
import { recordWords, dailyTotals } from './stats.mjs'
// 敏感词 / 过审检测：离线内置词典，只提示不拦截
import { detectSensitive, CATEGORY_NAMES } from './sensitive.mjs'
// 管家工具注册表：动作的分级 / 归类 / text 形态提示的单一真源
import { ACTION_TIERS, actionHint } from './agent/tools.mjs'
// 写作 Agent：构思 → 起草 → 自检 → 修订 四阶段（只用于整章重写）
import {
  chapterBriefMessages,
  chapterReviewMessages,
  chapterFixMessages,
  pickActionableIssues
} from './agent/writer.mjs'
// 存储基础设施（路径解析 / JSON 事务 / 版本快照 / 对话存储 / 素材库）
import {
  DATA_DIR,
  DATA_DIR_RELOCATED,
  NOVELS_DIR,
  HISTORY_DIR,
  BACKUP_DIR,
  LOGS_DIR,
  CHATS_DIR,
  RECYCLE_DIR,
  COVERS_DIR,
  ATTACHMENTS_DIR,
  PORTRAITS_DIR,
  REFBOOKS_DIR,
  SETTINGS_FILE,
  SHELF_FILE,
  STATS_FILE,
  STATION_NAMES_FILE,
  ID_RE,
  readJson,
  writeJson,
  writeJsonAsync,
  updateJson,
  readJsonAsync,
  withFile,
  novelDir,
  novelFile,
  historyFile,
  historyBlobDir,
  readBlob,
  chatFile,
  pushHistory,
  snapshotChapters,
  snapshotIntact,
  deriveSessionTitle,
  normalizeChatStore,
  readChatStore,
  findSession,
  sessionMeta,
  writeChatStore,
  updateChatStore,
  saveChat,
  createChatSession,
  readShelf,
  saveShelf,
  recycleNovel,
  recycleList,
  restoreRecycle,
  purgeRecycle,
  appendLog,
  pendingFileWriteCount,
  invalidateJsonCache
} from './store.mjs'
// 模型配置与预置库（风格 / 模板 / 技能）
import {
  listModels,
  resolveConn,
  customStyles,
  customTemplates,
  listCustomSkills,
  allSkills,
  saveCustomSkill,
  registerModelRoutes,
  registerPresetRoutes,
  registerSkillRoutes
} from './models.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')

const app = express()

// 本地访问令牌：Electron 启动时注入，阻止其它本地网页窃取密钥或删库
const ACCESS_TOKEN = process.env.NOVEL_ACCESS_TOKEN || ''

// 本机来源放行；其余来源只是不加 CORS 响应头（浏览器自然拦截），
// 绝不能 cb(new Error)——那会把跨域预检变成 500 并污染 app.log
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) return cb(null, true)
      cb(null, false)
    }
  })
)

// body 上限分两档：常规请求 20mb 足够，但「还原备份」要整库上传——一本 400 章、
// 百万字级的书导出就 3mb 以上，六本书的备份轻易超过 20mb，恢复自己刚导出的备份
// 却回 413，等于「备份能用、恢复不能用」。这里按路径分流，只有本机 + 带令牌才能进到
// 恢复路由，放宽不影响对外暴露面。
const jsonSmall = express.json({ limit: '20mb' })
const jsonRestore = express.json({ limit: '1gb' })
app.use((req, res, next) => (req.path === '/api/backup/restore' ? jsonRestore : jsonSmall)(req, res, next))

// Express 4 不会捕获 async 处理器的 Promise rejection：一旦抛错请求永久挂起、
// 前端只能看到「请求失败」。在注册层统一包一层，把 rejection 转交给末尾的错误中间件。
for (const m of ['get', 'post', 'put', 'patch', 'delete']) {
  const orig = app[m].bind(app)
  app[m] = (path, ...handlers) =>
    orig(
      path,
      ...handlers.map(h =>
        typeof h === 'function' && h.constructor.name === 'AsyncFunction'
          ? (req, res, next) => {
              h(req, res, next).catch(next)
            }
          : h
      )
    )
}

// 令牌校验（未配置令牌时放行，便于 npm run dev 调试）。
// 只认请求头：查询参数会进日志/历史记录，容易泄漏令牌
app.use('/api', (req, res, next) => {
  if (!ACCESS_TOKEN) return next()
  const t = req.get('x-novel-token')
  if (t === ACCESS_TOKEN) return next()
  res.status(401).json({ error: '未授权访问' })
})

// ---------- 模型 / 预置库 / 技能路由（实现见 models.mjs）----------
// 必须挂在 express.json() 之后：这些路由全都读 req.body，提前注册会拿到 undefined。
registerModelRoutes(app)
registerPresetRoutes(app)
registerSkillRoutes(app)

// ---------- 设定智能分配：把一大段自由格式的设定草稿分拣进各字段 ----------
app.post('/api/ai/parse-settings', async (req, res) => {
  const novel = getNovel(req.body?.novelId)
  if (!novel) return res.status(404).json({ error: '小说不存在' })
  const raw = String(req.body?.text || '').trim()
  if (raw.length < 10) return res.status(400).json({ error: '设定内容太短，直接手动填更方便' })

  // 分拣可指定模型（前端透传）；未指定时用书的默认模型
  const conn = resolveConn(req.body?.modelId || novel.modelId)
  if (!conn) return res.status(400).json({ error: '还没有配置模型，请先到【模型设置】添加' })

  try {
    let out = ''
    for await (const part of callAI(conn, {
      temperature: 0.3, // 分拣任务要稳定，压低随机性
      messages: parseSettingsMessages(raw)
    })) {
      if (part.type === 'content') out += part.text
    }
    const parsed = extractJsonObject(out)
    if (!parsed || typeof parsed !== 'object') {
      return res.status(422).json({ error: 'AI 返回的内容无法解析为设定结构，请换一个模型或稍后再试' })
    }
    // 只放行白名单字段，防止模型输出多余内容
    if (!parsed.protagonist || typeof parsed.protagonist !== 'object') {
      return res.status(422).json({ error: 'AI 未能识别出主角信息，请检查草稿中是否写明了主角' })
    }
    const str = v => (typeof v === 'string' ? v.trim() : '')
    const normChar = c => ({
      name: str(c?.name),
      role: str(c?.role),
      personality: str(c?.personality),
      appearance: str(c?.appearance),
      background: str(c?.background),
      notes: str(c?.notes)
    })
    res.json({
      ok: true,
      parsed: {
        title: str(parsed.title),
        genre: str(parsed.genre),
        pov: parsed.pov === 'first' || parsed.pov === 'third' ? parsed.pov : '',
        synopsis: str(parsed.synopsis),
        protagonist: normChar(parsed.protagonist),
        characters: Array.isArray(parsed.characters)
          ? parsed.characters.map(normChar).filter(c => c.name || c.role || c.personality || c.background)
          : [],
        worldview: str(parsed.worldview),
        elements: str(parsed.elements),
        extraRequirements: str(parsed.extraRequirements)
      }
    })
  } catch (e) {
    res.status(502).json({ error: upstreamFailHint(e) })
  }
})

// AI 生成剧情线：读设定+总纲，输出结构化剧情线数组（前端预览确认后应用）
app.post('/api/ai/plotlines', async (req, res) => {
  const novel = getNovel(req.body?.novelId)
  if (!novel) return res.status(404).json({ error: '小说不存在' })
  const mode = req.body?.mode === 'append' ? 'append' : 'replace'
  const conn = resolveConn(req.body?.modelId || novel.modelId)
  if (!conn) return res.status(400).json({ error: '请先在【模型设置】添加可用模型' })

  try {
    let out = ''
    for await (const part of callAI(conn, {
      temperature: 0.4,
      maxTokens: MAX_TOKENS,
      messages: plotlineMessages(novel, { mode })
    })) {
      if (part.type === 'content') out += part.text
    }
    const arr = extractPlotlines(out)
    if (!arr || !arr.length) {
      return res.status(422).json({ error: 'AI 返回的内容无法解析为剧情线结构，请换一个模型或重试' })
    }
    const plotlines = arr
      .filter(p => p && (String(p.name || '').trim() || String(p.description || '').trim()))
      .map(p =>
        normalizePlotline({
          id: crypto.randomUUID(),
          name: String(p.name || '').trim() || '未命名剧情线',
          type: String(p.type || '主线').trim(),
          goal: String(p.goal || '').trim(),
          description: String(p.description || '').trim(),
          status: p.status,
          characters: Array.isArray(p.characters) ? p.characters : [],
          beats: Array.isArray(p.beats)
            ? p.beats
                .map(b => ({
                  title: String(b?.title || '').trim(),
                  summary: String(b?.summary || b || '').trim(),
                  chapter: Number(b?.chapter) > 0 ? Number(b.chapter) : 0
                }))
                .filter(b => b.title || b.summary)
            : []
        })
      )
    if (!plotlines.length) return res.status(422).json({ error: 'AI 未识别出有效的剧情线，请重试' })
    res.json({ ok: true, plotlines })
  } catch (e) {
    res.status(502).json({ error: upstreamFailHint(e) })
  }
})

function getNovel(id) {
  try {
    const n = readJson(novelFile(id), null)
    return n ? normalizeNovel(n) : null
  } catch {
    return null
  }
}

function saveNovel(novel) {
  novel.updatedAt = Date.now()
  // 落盘前确保目标目录存在
  const dir = novelDir(novel)
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch {
    /* 不可写留给原子写入报错 */
  }
  writeJson(novelFile(novel), novel)
  return novel
}

/**
 * 在「同一本书」的串行事务里做一次读-改-写。
 * 生成任务与管家动作并发改动同一本书时，靠它保证不丢更新。
 * mutate 收到的是刚归一化过的最新 novel，可直接改后 return。
 */
async function updateNovel(novelId, mutate) {
  const file = novelFile(novelId)
  return withFile(file, async () => {
    const raw = await readJsonAsync(file, null)
    const novel = raw ? normalizeNovel(raw) : null
    if (!novel) return null
    const result = await mutate(novel)
    if (result === null) return null
    const mutated = result || novel
    mutated.updatedAt = Date.now()
    await writeJsonAsync(file, mutated)
    return mutated
  })
}

/**
 * 章节正文落库的唯一入口：整段读-改-写跑在书级事务里，
 * 避免「生成任务写完第 3 章」与「管家动作写完第 5 章」互相覆盖。
 * 返回 true 表示已落盘，false 表示小说不存在。
 */
async function saveChapterContentAtomic(novelId, idx, content, status, extra, expectedHash) {
  let saved = false
  let conflict = false
  await updateNovel(novelId, novel => {
    const existing = (novel.chapters || []).find(c => c.index === idx)
    const existingHash = existing?.content ? hashText(existing.content) : ''
    if (expectedHash !== undefined && existingHash !== expectedHash) {
      conflict = true
      return null
    }
    const o = (novel.outline || []).find(x => x.index === idx)
    const context = buildChapterContext(novel, idx, content, status === 'draft' ? 'draft' : 'generated')
    // 写作 Agent 审稿时顺带抽取的章末状态 / 待回收线索（零额外调用），有则更新
    if (typeof extra?.characterState === 'string' && extra.characterState.trim()) {
      context.characterState = extra.characterState.trim().slice(0, 1200)
    }
    if (typeof extra?.openThreads === 'string' && extra.openThreads.trim()) {
      context.openThreads = extra.openThreads.trim().slice(0, 800)
    }
    const chapters = (novel.chapters || []).filter(c => c.index !== idx)
    chapters.push({
      index: idx,
      title: (extra?.title ?? '') || existing?.title || o?.title || `第${idx}章`,
      content,
      words: countTextUnits(content),
      status,
      oid: existing?.oid || o?.oid || '',
      // 保留用户/AI 之前写入的人物状态与线索，只更新摘要与钩子
      context: { ...(existing?.context || {}), ...context }
    })
    novel.chapters = chapters.sort((a, b) => a.index - b.index)
    saved = true
    return novel
  })
  if (conflict) throw new Error('本章在生成期间被手动修改过，为避免覆盖你的改动，本次草稿未写入。')
  return saved
}

app.get('/api/novels/:id/history', (req, res) => {
  try {
    const list = readJson(historyFile(req.params.id), [])
    if (!Array.isArray(list)) return res.status(400).json({ error: '版本历史数据损坏' })
    res.json(
      list.map(h => ({
        id: h.id,
        at: h.at,
        label: h.label,
        chapters: (h.snapshot?.chapters || []).length,
        words: (h.snapshot?.chapters || []).reduce((s, c) => s + (c.words || 0), 0)
      }))
    )
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) })
  }
})

app.post('/api/novels/:id/history/:hid/restore', async (req, res) => {
  const novel = getNovel(req.params.id)
  if (!novel) return res.status(404).json({ error: '小说不存在' })
  const list = readJson(historyFile(req.params.id), [])
  if (!Array.isArray(list)) return res.status(400).json({ error: '版本历史数据损坏' })
  const h = list.find(x => x.id === req.params.hid)
  if (!h) return res.status(404).json({ error: '版本不存在' })
  // 回滚前先校验正文块可读：若有块丢失，宁可整体拒绝，也不能用残缺内容覆盖现有书稿
  if (!snapshotIntact(novel, h.snapshot)) {
    return res.status(409).json({
      error: '该版本的正文块缺失（可能被外部清理），为避免覆盖现有书稿已中止回滚。请选择其它版本。'
    })
  }
  // 回滚前先给当前状态留一份快照（走同一套 blob 去重，代价很低）
  pushHistory(novel, '回滚前自动快照')
  // 兼容多种快照格式：新版 chapters[].ref 指向正文块，旧版直接内嵌 content
  const restored = snapshotChapters(novel, h.snapshot, buildChapterContext)
  // 落库走书级事务：回滚的「读-改-写」若绕过写队列，正好撞上章节生成任务的
  // 事务写入间隙时，整次回滚会被过期整书快照静默覆盖
  await updateNovel(req.params.id, n => {
    n.masterOutline = h.snapshot.masterOutline || ''
    n.outline = h.snapshot.outline || []
    n.chapters = restored
    return n
  })
  res.json({ ok: true, chapters: restored.length })
})

function newChar() {
  return { id: crypto.randomUUID(), name: '', role: '', personality: '', appearance: '', background: '', notes: '' }
}

function normalizeBeat(b) {
  return {
    id: String(b?.id || crypto.randomUUID()),
    title: String(b?.title || ''),
    summary: String(b?.summary || ''),
    chapter: Number(b?.chapter) > 0 ? Number(b.chapter) : 0
  }
}

function normalizePlotline(p) {
  return {
    id: String(p?.id || crypto.randomUUID()),
    name: String(p?.name || ''),
    type: String(p?.type || '主线'),
    goal: String(p?.goal || ''),
    description: String(p?.description || ''),
    status: ['active', 'paused', 'pending', 'done'].includes(p?.status) ? p.status : 'pending',
    beats: Array.isArray(p?.beats) ? p.beats.map(normalizeBeat) : [],
    characters: Array.isArray(p?.characters) ? p.characters.map(String).filter(Boolean) : []
  }
}

function defaultNovel(title, genre) {
  return {
    id: crypto.randomUUID(),
    title: title || '未命名小说',
    genre: genre || '',
    style: '',
    pov: 'third',
    targetWords: 2000,
    chapterCount: 12,
    synopsis: '',
    protagonist: newChar(),
    characters: [],
    worldview: '',
    elements: '',
    extraRequirements: '',
    // 新书默认「按题材自动推荐文风」：写作时按分类+书名+简介实时挑一位契合的作家
    authorStyleId: 'auto',
    styleProfile: '',
    templateId: 'balanced',
    customPrompt: '',
    modelId: '',
    skillIds: [],
    plotlines: [],
    folderPath: '',
    masterOutline: '',
    outline: [],
    chapters: [],
    createdAt: Date.now(),
    updatedAt: Date.now()
  }
}

// 兼容旧数据：补齐新增字段；为大纲条目分配稳定 oid，供正文对齐
function normalizeNovel(n) {
  n.authorStyleId = n.authorStyleId ?? ''
  n.templateId = n.templateId ?? 'balanced'
  n.customPrompt = n.customPrompt ?? ''
  n.skillIds = Array.isArray(n.skillIds) ? n.skillIds.map(String).filter(Boolean) : []
  n.plotlines = Array.isArray(n.plotlines) ? n.plotlines.map(normalizePlotline) : []
  n.modelId = n.modelId ?? '' // 为空表示尚未选择模型
  n.styleProfile = n.styleProfile ?? '' // 风格档案：拆书产出，作为全书文字校准依据
  n.linkContext = n.linkContext ?? true // 写下一章时是否关联前文（作者可在生成页自由开关）
  n.mobileReading = n.mobileReading ?? false // 手机阅读优化（多换行/口语化/六感代入）
  n.folderPath = n.folderPath ?? '' // 参考小说文件夹路径（仅作分析素材用）
  n.libraryDir = n.libraryDir ?? '' // 历史遗留字段：仅旧数据兼容读取，不再有写入入口
  n.refAnalyzed = n.refAnalyzed ?? null // 最近一次参考作品分析的指纹快照 { at, files }
  n.masterOutline = n.masterOutline ?? ''
  // 旧版管家追加动作误写单数字段：合并回真实字段后清除，避免这部分内容永远不进提示词
  for (const [legacy, field] of [
    ['element', 'elements'],
    ['extraRequirement', 'extraRequirements']
  ]) {
    const stale = typeof n[legacy] === 'string' ? n[legacy].trim() : ''
    const cur = typeof n[field] === 'string' ? n[field] : ''
    if (stale && !cur.includes(stale)) n[field] = cur ? (cur.endsWith('\n') ? cur + stale : cur + '\n' + stale) : stale
    else n[field] = cur
    delete n[legacy]
  }
  n.chapterCount = Math.max(Math.floor(n.chapterCount ?? 12) || 12, 1)
  n.protagonist = n.protagonist ?? newChar()
  n.characters = Array.isArray(n.characters) ? n.characters : []
  n.outline = Array.isArray(n.outline) ? n.outline : []
  n.chapters = Array.isArray(n.chapters) ? n.chapters : []

  n.outline = n.outline.map((o, i) => ({
    ...o,
    index: Number(o.index) || i + 1,
    title: o.title ?? '',
    summary: o.summary ?? '',
    customPrompt: o.customPrompt ?? '',
    oid: o.oid || crypto.randomUUID()
  }))

  // 老数据的章节按 index 绑定到对应大纲的 oid
  const byIndex = new Map(n.outline.map(o => [o.index, o.oid]))
  n.chapters = n.chapters.map(c => ({
    ...c,
    index: Number(c.index) || 0,
    content: typeof c.content === 'string' ? c.content : '',
    // 字数一律以正文为准重算：旧数据里的 words 可能过期，会让「实际 4000 字显示成 2000 字」
    words: countTextUnits(c.content),
    status: c.status === 'draft' ? 'draft' : 'done',
    oid: c.oid || byIndex.get(c.index) || '',
    context: normalizeChapterContext(c.context)
  }))
  return n
}

// 章节上下文快照（summary/人物状态/未回收线索/章末钩子）：旧数据没有时为 undefined。
function normalizeChapterContext(ctx) {
  if (!ctx || typeof ctx !== 'object') return undefined
  const str = v => (typeof v === 'string' ? v.trim() : '')
  const out = {
    summary: str(ctx.summary),
    characterState: str(ctx.characterState),
    openThreads: str(ctx.openThreads),
    endingHook: str(ctx.endingHook),
    source: str(ctx.source),
    updatedAt: Number(ctx.updatedAt) || 0,
    // 作者手改次数：用于识别「作者亲笔」章节，是 AI 对齐文风时优先级最高的样本
    manualEdits: Number(ctx.manualEdits) || 0
  }
  return Object.values(out).some(v => v) ? out : undefined
}

// 落盘时的确定性上下文快照，不额外调用 AI：摘要优先引用大纲框架，正文只保留首尾。
function buildChapterContext(novel, chapterIndex, content, source = 'generated') {
  const outlineItem = (novel.outline || []).find(o => o.index === chapterIndex)
  const text = String(content || '')
  const units = countTextUnits(text)
  const firstPara =
    text
      .split(/\n+/)
      .map(s => s.trim())
      .filter(Boolean)[0] || ''
  const tail = text.replace(/\s+/g, ' ').slice(-220)
  const summary = outlineItem?.summary?.trim()
    ? `按大纲执行：${outlineItem.summary.replace(/\s+/g, ' ').slice(0, 300)}；正文实际 ${units} 字`
    : `本章 ${units} 字；开头：${firstPara.slice(0, 120)}；结尾：${tail}`
  return {
    summary,
    // characterState / openThreads 不在这里重置：它们由审稿阶段抽取或作者写入，
    // 混进返回值会在每次落库时把既有状态清成空串（合并 spread 时覆盖旧值）
    endingHook: tail.slice(-160),
    source,
    updatedAt: Date.now()
  }
}

/**
 * 一键排版：把正文规范成中文小说的标准版式。
 *
 * 只动「版面」不动「文字」：段落首行缩进两格（全角空格，纯文本里唯一可靠的缩进方式）、
 * 段与段之间空一行、清掉行首行尾多余空格与三行以上的连续空行。
 * 实现是幂等的——重复排版不会再变，作者随时可以放心点。
 * 章节标题行（如「第3章 初雪」）不缩进，避免导入文稿的结构被压平。
 * 判标题要求「以第N章开头 + 行很短 + 不含句读」，否则正文段落里一句
 * 「第二章的第一段。」也会被误判成标题而丢掉缩进。
 */
function typesetChapterText(text, indent = 2) {
  const pad = '\u3000'.repeat(Math.max(0, Math.min(4, Math.floor(Number(indent) || 0))))
  const out = []
  for (const raw of String(text || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')) {
    const body = raw.replace(/[ \t\u3000]+$/, '').replace(/^[ \t\u3000]+/, '')
    if (!body) {
      if (out.length && out[out.length - 1] !== '') out.push('')
      continue
    }
    const isHeading =
      body.length <= 30 &&
      /^第\s*[0-9零一二三四五六七八九十百千两]+\s*[章节回]/.test(body) &&
      !/[。！？，；]/.test(body)
    out.push(isHeading ? body : pad + body)
  }
  return out.join('\n').replace(/^\n+|\n+$/g, '')
}

/**
 * 判断一条管家回复是不是「已交付的正文」而非讨论/分析。
 *
 * 用途：模型偶尔会写完正文却忘记输出落库动作块（作者就得再说一句「存进成书」）。
 * 这里做保守识别，命中后前端给出一键落库入口。
 *
 * 判定偏向「宁可漏判，不可误判」——把讨论、方案清单、分析报告排除掉，
 * 只认成段的连续叙述文字。
 */
export function looksLikeDeliveredProse(text) {
  const t = String(text || '').trim()
  if (t.length < 240) return false
  // 已经带代码围栏（含动作块）的不算漏落库
  if (t.includes('```')) return false
  // 中文字数门槛
  const cjk = (t.match(/[\u4e00-\u9fa5]/g) || []).length
  if (cjk < 180) return false
  // 必须是多段连续叙述
  const paragraphs = t
    .split(/\n\s*\n/)
    .map(s => s.trim())
    .filter(Boolean)
  const narrative = paragraphs.filter(p => !/^[-*·•>\d]/.test(p) && !/^#{1,6}\s/.test(p))
  if (narrative.length < 2) return false
  // 句读密度：正文会有较多句末标点
  const sentenceEnds = (t.match(/[。！？…”」]/g) || []).length
  if (sentenceEnds < 6) return false
  // 讨论/分析口吻：问句过多、或大量冒号分点
  const questions = (t.match(/[？?]/g) || []).length
  if (questions > sentenceEnds * 0.35) return false
  const bullets = (t.match(/^[-*·•]\s/gm) || []).length
  if (bullets > narrative.length) return false
  return true
}

// ---------- 小说 CRUD ----------
// 作品库元数据缓存：首页/侧栏会频繁拉列表，而每本书的 JSON 可能很大（正文+大纲）。
// 用「文件名 + mtime + size」做签名，签名不变就直接复用；既避免重复解析，
// 又能在任何写盘后立刻失效（不依赖进程内通知）。
let novelsMetaCache = { key: '', at: 0, list: [] }
function listNovelMetas() {
  let files = []
  try {
    files = fs.readdirSync(NOVELS_DIR).filter(f => f.endsWith('.json'))
  } catch {
    /* 目录缺失时为空 */
  }
  const key = files
    .map(f => {
      try {
        const st = fs.statSync(path.join(NOVELS_DIR, f))
        return `${f}:${st.mtimeMs}:${st.size}`
      } catch {
        return `${f}:0:0`
      }
    })
    .join('|')
  if (novelsMetaCache.key === key && Date.now() - novelsMetaCache.at < 5000) return novelsMetaCache.list
  const list = []
  for (const f of files) {
    const n = readJson(path.join(NOVELS_DIR, f), null)
    if (!n) continue
    list.push({
      id: n.id,
      title: n.title,
      genre: n.genre,
      updatedAt: n.updatedAt,
      modelId: n.modelId || '',
      folderPath: n.folderPath || '',
      // 封面（用户上传）：文件名 + 上传时间戳，前端用 coverAt 做缓存失效
      coverFile: n.coverFile || '',
      coverAt: Number(n.coverAt) || 0,
      // 计划章节数（作者预期规模）
      planCount: Math.max(Math.floor(n.chapterCount) || 0, 0),
      // 已排大纲的章节数（含正在规划的）
      outlineCount: (n.outline && n.outline.length) || 0,
      // 已完成章节数：草稿（停笔/中断留存）不算完成，与生成页口径一致
      chaptersDone: (n.chapters || []).filter(c => c.content && c.content.trim() && c.status !== 'draft').length
    })
  }
  list.sort((a, b) => b.updatedAt - a.updatedAt)
  novelsMetaCache = { key, at: Date.now(), list }
  return list
}

app.get('/api/novels', (_req, res) => {
  res.json(listNovelMetas())
})

// ---------- 作品封面 ----------
// 用户上传的封面原图按 `<作品id>.<ext>` 落在 <data>/covers/。
// 传输走**原始二进制**（Content-Type: image/*）而不是 JSON + data:URL，两个原因：
//   1) 全局 express.json() 的默认上限只有 100KB，5MB 的 data:URL 会在进路由前就被 413 拦掉；
//   2) 少一层 base64 膨胀（省约 1/3 体积）。
// 文件名一概由服务端依据 id + MIME 生成，不接受客户端传入路径，从根上避免目录穿越。
const COVER_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }
const COVER_MAX_BYTES = 5 * 1024 * 1024
const COVER_FILE_RE = /^[A-Za-z0-9_-]{1,64}\.(?:png|jpg|webp|gif)$/
const coverRaw = express.raw({ type: 'image/*', limit: COVER_MAX_BYTES })

/** 用魔数确认这确实是图片，防止只改扩展名/Content-Type 的文件混进来 */
function looksLikeImage(buf) {
  if (buf.length < 12) return false
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true // PNG
  if (buf[0] === 0xff && buf[1] === 0xd8) return true // JPEG
  if (buf.subarray(0, 3).toString('ascii') === 'GIF') return true
  return buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP'
}

app.get('/api/covers/:file', (req, res) => {
  const file = String(req.params.file || '')
  if (!COVER_FILE_RE.test(file)) return res.status(400).json({ error: '非法的封面文件名' })
  const p = path.join(COVERS_DIR, file)
  if (!fs.existsSync(p)) return res.status(404).json({ error: '封面不存在' })
  // 内容随重新上传而变，缓存失效由前端追加 ?v=<coverAt> 完成，这里给长缓存即可
  res.set('Cache-Control', 'public, max-age=2592000')
  res.sendFile(p)
})

app.post('/api/novels/:id/cover', coverRaw, async (req, res) => {
  const id = String(req.params.id || '')
  if (!ID_RE.test(id)) return res.status(400).json({ error: '非法的作品 ID' })
  const mime = String(req.headers['content-type'] || '')
    .split(';')[0]
    .trim()
    .toLowerCase()
  const ext = COVER_EXT[mime]
  if (!ext) return res.status(400).json({ error: '只支持 PNG / JPG / WebP / GIF 图片' })
  const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)
  if (!buf.length) return res.status(400).json({ error: '图片内容为空' })
  if (buf.length > COVER_MAX_BYTES) return res.status(400).json({ error: '图片过大，请压缩到 5MB 以内' })
  if (!looksLikeImage(buf)) return res.status(400).json({ error: '这个文件不是有效的图片' })
  if (!getNovel(id)) return res.status(404).json({ error: '小说不存在' })

  const file = `${id}.${ext}`
  try {
    fs.mkdirSync(COVERS_DIR, { recursive: true })
    // 换了图片格式就把旧后缀那份删掉，避免同一个作品残留两套封面
    for (const other of Object.values(COVER_EXT)) {
      if (other === ext) continue
      const stale = path.join(COVERS_DIR, `${id}.${other}`)
      if (fs.existsSync(stale)) fs.unlinkSync(stale)
    }
    fs.writeFileSync(path.join(COVERS_DIR, file), buf)

    const updated = await updateJson(novelFile(id), cur => {
      if (!cur) return null
      cur.coverFile = file
      cur.coverAt = Date.now()
      return cur
    })
    appendLog('cover', `更新封面 ${id} → ${file}（${Math.round(buf.length / 1024)}KB）`)
    res.json({ ok: true, novel: updated ? normalizeNovel(updated) : null })
  } catch (e) {
    appendLog('cover', `写入封面失败 ${id}: ${e.message}`)
    res.status(500).json({ error: '封面写入失败，请检查磁盘空间或写入权限' })
  }
})

app.delete('/api/novels/:id/cover', async (req, res) => {
  const id = String(req.params.id || '')
  if (!ID_RE.test(id)) return res.status(400).json({ error: '非法的作品 ID' })
  if (!getNovel(id)) return res.status(404).json({ error: '小说不存在' })
  try {
    for (const ext of Object.values(COVER_EXT)) {
      const p = path.join(COVERS_DIR, `${id}.${ext}`)
      if (fs.existsSync(p)) fs.unlinkSync(p)
    }
    const updated = await updateJson(novelFile(id), cur => {
      if (!cur) return null
      cur.coverFile = ''
      cur.coverAt = 0
      return cur
    })
    res.json({ ok: true, novel: updated ? normalizeNovel(updated) : null })
  } catch (e) {
    appendLog('cover', `移除封面失败 ${id}: ${e.message}`)
    res.status(500).json({ error: '封面移除失败' })
  }
})

// ---------- 管家对话附件 ----------
// 作者随消息发的图片，按随机 id 落在 <data>/attachments/。聊天 JSON 里只存文件名，
// 发给模型时才读盘转成 data:URL —— 否则几张截图就能把 chats/*.json 撑到几十 MB。
// 传输同样走原始二进制（理由见上方封面的注释：全局 json 上限只有 100KB）。
const ATTACH_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }
const ATTACH_MIME_BY_EXT = Object.fromEntries(Object.entries(ATTACH_EXT).map(([k, v]) => [v, k]))
const ATTACH_MAX_BYTES = 8 * 1024 * 1024
const ATTACH_FILE_RE = /^[A-Za-z0-9_-]{1,64}\.(?:png|jpg|webp|gif)$/
const ATTACH_LIMIT = 4 // 单条消息最多带几张图：再多对长文写作没有增益，只会烧上下文
const attachRaw = express.raw({ type: 'image/*', limit: ATTACH_MAX_BYTES })

app.post('/api/attachments', attachRaw, (req, res) => {
  const mime = String(req.headers['content-type'] || '')
    .split(';')[0]
    .trim()
    .toLowerCase()
  const ext = ATTACH_EXT[mime]
  if (!ext) return res.status(400).json({ error: '只支持 PNG / JPG / WebP / GIF 图片' })
  const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)
  if (!buf.length) return res.status(400).json({ error: '图片内容为空' })
  if (!looksLikeImage(buf)) return res.status(400).json({ error: '这个文件不是有效的图片' })
  const file = `${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}.${ext}`
  try {
    fs.mkdirSync(ATTACHMENTS_DIR, { recursive: true })
    fs.writeFileSync(path.join(ATTACHMENTS_DIR, file), buf)
    appendLog('attach', `收到图片 ${file}（${Math.round(buf.length / 1024)}KB）`)
    res.json({ ok: true, file, url: `/api/attachments/${file}` })
  } catch (e) {
    appendLog('attach', `写入附件失败: ${e.message}`)
    res.status(500).json({ error: '附件写入失败，请检查磁盘空间或写入权限' })
  }
})

app.get('/api/attachments/:file', (req, res) => {
  const file = String(req.params.file || '')
  if (!ATTACH_FILE_RE.test(file)) return res.status(400).json({ error: '非法的附件文件名' })
  const p = path.join(ATTACHMENTS_DIR, file)
  if (!fs.existsSync(p)) return res.status(404).json({ error: '附件不存在' })
  res.set('Cache-Control', 'public, max-age=31536000, immutable') // 文件名一次性，内容永不变
  res.sendFile(p)
})

// ---------- 人物照片 ----------
// 作者给角色上传的图按随机 id 落在 <data>/portraits/，作品 JSON 里 character.portrait 只存文件名。
// 上传只负责落盘并回传文件名，由设定页把它当普通字段写进草稿、随设定一起保存——
// 这样「放弃修改」不会留下指向新图的半截状态。没被任何作品 / 回收站 / 历史版本引用的
// 文件由 gcPortraits 在宽限期后回收（同附件）。
const PORTRAIT_MAX_BYTES = 5 * 1024 * 1024
const PORTRAIT_FILE_RE = /^[A-Za-z0-9_-]{1,64}\.(?:png|jpg|webp|gif)$/
const portraitRaw = express.raw({ type: 'image/*', limit: PORTRAIT_MAX_BYTES })

app.post('/api/portraits', portraitRaw, (req, res) => {
  const mime = String(req.headers['content-type'] || '')
    .split(';')[0]
    .trim()
    .toLowerCase()
  const ext = ATTACH_EXT[mime]
  if (!ext) return res.status(400).json({ error: '只支持 PNG / JPG / WebP / GIF 图片' })
  const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)
  if (!buf.length) return res.status(400).json({ error: '图片内容为空' })
  if (buf.length > PORTRAIT_MAX_BYTES) return res.status(400).json({ error: '图片过大，请压缩到 5MB 以内' })
  if (!looksLikeImage(buf)) return res.status(400).json({ error: '这个文件不是有效的图片' })
  const file = `${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}.${ext}`
  try {
    fs.mkdirSync(PORTRAITS_DIR, { recursive: true })
    fs.writeFileSync(path.join(PORTRAITS_DIR, file), buf)
    appendLog('portrait', `收到人物照片 ${file}（${Math.round(buf.length / 1024)}KB）`)
    res.json({ ok: true, file })
  } catch (e) {
    appendLog('portrait', `写入人物照片失败: ${e.message}`)
    res.status(500).json({ error: '照片写入失败，请检查磁盘空间或写入权限' })
  }
})

app.get('/api/portraits/:file', (req, res) => {
  const file = String(req.params.file || '')
  if (!PORTRAIT_FILE_RE.test(file)) return res.status(400).json({ error: '非法的照片文件名' })
  const p = path.join(PORTRAITS_DIR, file)
  if (!fs.existsSync(p)) return res.status(404).json({ error: '照片不存在' })
  res.set('Cache-Control', 'public, max-age=31536000, immutable')
  res.sendFile(p)
})

app.get('/api/novels/:id', (req, res) => {
  const novel = getNovel(req.params.id)
  if (!novel) return res.status(404).json({ error: '小说不存在' })
  // ?meta=1 只回目录元信息（不带正文）：命令面板搜索章节、侧栏长列表等场景避免整本正文过网
  if (req.query.meta === '1') {
    return res.json({ ...novel, chapters: (novel.chapters || []).map(c => ({ ...c, content: undefined })) })
  }
  res.json(novel)
})

app.post('/api/novels', (req, res) => {
  const { title, genre } = req.body || {}
  const novel = defaultNovel(title, genre)
  if (req.body?.modelId) novel.modelId = String(req.body.modelId)
  if (req.body?.folderPath) novel.folderPath = String(req.body.folderPath)
  if (req.body?.chapterCount) {
    novel.chapterCount = Math.max(Math.floor(Number(req.body.chapterCount) || 12), 1)
  }
  saveNovel(novel)
  res.status(201).json(novel)
})

/**
 * 把上游模型调用异常翻译成作者能照着排查的一句话（不泄露任何密钥）。
 * 「一对话就报 AI 接口错误」这类反馈必须能区分：Key 无效 / 无权限 / 模型名不对 / 参数不支持。
 */
function upstreamFailHint(e) {
  const st = Number(e?.status)
  const raw = String(e?.message || e)
  if (typeof e?.code === 'string' && e.code.startsWith('CODEX_')) return raw
  const head =
    st === 401
      ? '模型鉴权失败（401）：API Key 无效或已过期，请到「模型设置」重新粘贴'
      : st === 403
        ? '模型拒绝访问（403）：该 Key 没有这个模型的权限，请改用其它模型或检查中转站账号'
        : st === 404
          ? '模型不存在（404）：该中转站没有这个模型名，请核对模型名与接口地址'
          : st === 400
            ? '模型拒绝请求（400）：模型名或请求参数不被该模型支持'
            : st === 429
              ? '请求过于频繁或额度不足（429）：请稍后重试或检查余额'
              : '模型调用失败'
  return `${head}。原始信息：${raw}`
}

// 可由「设定页」编辑的字段白名单；chapters 只允许专用接口写入，避免陈旧快照覆盖新章节
const EDITABLE_FIELDS = [
  'title',
  'genre',
  'style',
  'pov',
  'targetWords',
  'chapterCount',
  'synopsis',
  'protagonist',
  'characters',
  'worldview',
  'elements',
  'extraRequirements',
  'authorStyleId',
  'templateId',
  'customPrompt',
  'skillIds',
  'plotlines',
  'modelId',
  'masterOutline',
  'outline',
  'folderPath',
  'styleProfile'
]

app.put('/api/novels/:id', async (req, res) => {
  const body = req.body
  if (!body || body.id !== req.params.id) return res.status(400).json({ error: '数据不合法' })
  const result = await updateNovel(req.params.id, current => {
    const next = { ...current }
    for (const k of EDITABLE_FIELDS) {
      if (k in body) next[k] = body[k]
    }
    next.chapters = current.chapters
    normalizeNovel(next)
    // 章节归属只认「旧大纲」。normalizeNovel 会拿刚提交的新大纲按 index 给缺 oid 的章节补归属，
    // 而大纲一旦被上移/下移/插入，同一个 index 已经指向另一行——补出来的归属是错的。
    // 这里按位置还原：原本就有 oid 的章节不动，原本没有的只用旧大纲查，查不到就留空当孤立章。
    {
      const curChapters = current.chapters || []
      const oldOidByIndex = new Map((current.outline || []).map(o => [o.index, o.oid]))
      next.chapters = (next.chapters || []).map((c, i) => {
        const before = curChapters[i]
        if (!before || before.oid) return c
        const oid = oldOidByIndex.get(before.index) || ''
        return c.oid === oid ? c : { ...c, oid }
      })
    }

    if (Array.isArray(body.outline)) {
      const clientRows = body.outline || []
      // 大纲与旧快照不同且行数变少时先留一份可回滚的快照：整书 PUT 过去从不进版本历史，
      // 旧客户端快照覆盖掉后台大纲任务刚追加的行后，作者没有任何退路
      const curRows = current.outline || []
      const outlineChanged =
        clientRows.length !== curRows.length ||
        clientRows.some((o, i) => o.oid !== curRows[i]?.oid || o.title !== curRows[i]?.title)
      if (outlineChanged && clientRows.length < curRows.length) pushHistory(current, '保存大纲前')
      // 无条件把「服务端有、客户端没提交、也没被显式删除」的行并回来。
      // 旧实现只在客户端行缺 oid 时才做保护：客户端带全 oid 的过期快照会静默抹掉
      // 后台任务刚生成的新大纲行。删除必须走 removedOids，UI 已始终携带。
      const removed = new Set(Array.isArray(body.removedOids) ? body.removedOids : [])
      const clientOids = new Set(clientRows.map(o => o.oid).filter(Boolean))
      const serverOnly = curRows.filter(o => o.oid && !clientOids.has(o.oid) && !removed.has(o.oid))
      if (serverOnly.length) {
        next.outline = [...(next.outline || []), ...serverOnly].sort((a, b) => a.index - b.index)
        next.outline = next.outline.map((o, i) => ({ ...o, index: i + 1 }))
      }
    }

    // 大纲改名后同步章节标题。必须按 oid 配对，不能按 index：
    // 上移/下移/插入一行后同一个 index 换成了另一行，按 index 合并会把邻章的标题错配到别人的
    // 正文上（章号由 syncChapterIndices 按 oid 重排，于是「章号是新的、标题是别人的」，
    // 全程无警告，并直接进入导出）。按 oid 配对后，只有「同一行被改名」才会带动章节标题，
    // 且仅当章节标题仍等于该行旧标题（说明是自动同步来的、作者没手工改过）时才覆盖。
    if (Array.isArray(body.outline) && current.outline) {
      const oldTitleByOid = new Map(current.outline.filter(o => o.oid).map(o => [o.oid, o.title]))
      const newTitleByOid = new Map((next.outline || []).filter(o => o.oid).map(o => [o.oid, o.title]))
      next.chapters = (next.chapters || []).map(c => {
        if (!c.oid) return c
        const old = oldTitleByOid.get(c.oid)
        const neu = newTitleByOid.get(c.oid)
        if (neu && old && c.title === old && neu !== old) return { ...c, title: neu }
        return c
      })
    }

    const warnings = syncChapterIndices(next)
    Object.defineProperty(next, '__warnings', { value: warnings, enumerable: false, configurable: true })
    return next
  })
  if (!result) return res.status(404).json({ error: '小说不存在' })
  const warnings = result.__warnings || []
  delete result.__warnings
  res.json({ ...result, warnings })
})

// 轻量偏好更新：只写入指定字段（如「关联前文」开关），
// 避免用整书快照 PUT——生成任务并行时整书快照可能已过期，会覆盖 AI 刚写入的大纲/章节
app.put('/api/novels/:id/prefs', async (req, res) => {
  const novel = await updateNovel(req.params.id, current => {
    if (typeof req.body?.linkContext === 'boolean') current.linkContext = req.body.linkContext
    if (typeof req.body?.mobileReading === 'boolean') current.mobileReading = req.body.mobileReading
    if (typeof req.body?.modelId === 'string') current.modelId = req.body.modelId.trim()
    return current
  })
  if (!novel) return res.status(404).json({ error: '小说不存在' })
  res.json({
    ok: true,
    linkContext: novel.linkContext !== false,
    mobileReading: !!novel.mobileReading,
    modelId: novel.modelId || ''
  })
})

// 依据 outline 的 oid 顺序，重排 chapters 的 index；找不到归属的正文移到末尾并标记
function syncChapterIndices(novel) {
  const warnings = []
  const outline = novel.outline || []
  const chapters = novel.chapters || []
  if (!chapters.length) return warnings
  const oidToIndex = new Map(outline.filter(o => o.oid).map(o => [o.oid, o.index]))
  const kept = []
  const orphans = []
  for (const c of chapters) {
    if (c.oid && oidToIndex.has(c.oid)) {
      kept.push({ ...c, index: oidToIndex.get(c.oid) })
    } else if (c.oid) {
      orphans.push(c)
    } else {
      kept.push(c) // 老数据没有 oid，保持原状
    }
  }
  if (orphans.length) {
    let next = Math.max(0, ...outline.map(o => o.index), ...kept.map(c => c.index)) + 1
    for (const o of orphans) {
      kept.push({ ...o, index: next++, orphan: true })
    }
    warnings.push(`有 ${orphans.length} 章正文对应的大纲已被删除，已移至末尾保留，可在成书页手动处理。`)
  }
  // 章号冲突不再静默删章：后来的章挪到末尾空号并标记孤立，正文永远优先于编号整齐
  const seen = new Set()
  const sorted = kept.sort((a, b) => a.index - b.index)
  let maxIdx = Math.max(0, ...sorted.map(c => c.index))
  const resolved = []
  for (const c of sorted) {
    if (!seen.has(c.index)) {
      seen.add(c.index)
      resolved.push(c)
      continue
    }
    maxIdx += 1
    while (seen.has(maxIdx)) maxIdx += 1
    seen.add(maxIdx)
    resolved.push({ ...c, index: maxIdx, orphan: true })
    warnings.push(`第 ${c.index} 章出现章号冲突，已顺延到第 ${maxIdx} 章并标记孤立，请手动确认。`)
  }
  novel.chapters = resolved.sort((a, b) => a.index - b.index)
  return warnings
}

app.delete('/api/novels/:id', (req, res) => {
  // 软删除：整本书（正文/大纲/版本历史/研讨对话）移入回收站，可在回收站恢复
  const piece = recycleNovel(req.params.id)
  res.json({ ok: true, recycled: piece })
})

// ---------- 回收站 ----------
app.get('/api/recycle', (_req, res) => {
  res.json(recycleList())
})

app.post('/api/recycle/:id/restore', (req, res) => {
  const meta = restoreRecycle(req.params.id)
  if (!meta) return res.status(404).json({ error: '回收站里没有这项' })
  res.json({ ok: true, title: meta.title })
})

app.delete('/api/recycle/:id', (req, res) => {
  const id = String(req.params.id || '')
  purgeRecycle(id)
  // 彻底删除后封面图就再没有归属了，一并清掉，避免 data/covers 里堆积孤儿文件
  if (ID_RE.test(id)) {
    for (const ext of Object.values(COVER_EXT)) {
      const p = path.join(COVERS_DIR, `${id}.${ext}`)
      try {
        if (fs.existsSync(p)) fs.unlinkSync(p)
      } catch {
        /* 清理失败不影响删除结果 */
      }
    }
    // 拆书报告目录同理：作品彻底删除后不再可能回来
    try {
      fs.rmSync(path.join(REFBOOKS_DIR, id), { recursive: true, force: true })
    } catch {
      /* 清理失败不影响删除结果 */
    }
    // 该书会话刚进回收站时被删除引用，附件进入 12 小时宽限期后即可被回收
    gcAttachments()
  }
  res.json({ ok: true })
})

// ---------- 知识库（对标 ima：可检索、能被 AI 引用的文档库） ----------
app.get('/api/kb', (_req, res) => res.json(listKb()))
app.post('/api/kb', (req, res) => {
  const name = String(req.body?.name || '').trim()
  if (!name) return res.status(400).json({ error: '请填写知识库名称' })
  const kb = createKb(name, req.body?.description)
  res.json({ ok: true, kb: { ...kb, chunks: kb.chunks.length } })
})
app.delete('/api/kb/:id', async (req, res) => {
  if (!(await deleteKb(req.params.id))) return res.status(404).json({ error: '知识库不存在' })
  res.json({ ok: true })
})

// 加文档：直接贴文本，或给一个文件夹路径批量导入其中的 .txt / .md
app.post('/api/kb/:id/docs', async (req, res) => {
  const folderPath = String(req.body?.folderPath || '').trim()
  const results = []
  if (folderPath) {
    if (!fs.existsSync(folderPath)) return res.status(400).json({ error: `文件夹不存在：${folderPath}` })
    let entries = []
    try {
      entries = fs.readdirSync(folderPath)
    } catch (e) {
      return res.status(500).json({ error: `读取文件夹失败：${e.message}` })
    }
    for (const entry of entries) {
      if (!['.txt', '.md', '.text'].includes(path.extname(entry).toLowerCase())) continue
      try {
        const content = decodeRefText(fs.readFileSync(path.join(folderPath, entry)))
        const r = await addDoc(req.params.id, { name: entry, content })
        results.push({ name: entry, ok: !r.error, chunks: r.chunks || 0, error: r.error })
      } catch {
        results.push({ name: entry, ok: false, error: '读取失败' })
      }
    }
    if (!results.length) return res.status(400).json({ error: '文件夹里没有 .txt / .md 文件' })
    const okCount = results.filter(r => r.ok).length
    if (!okCount) return res.status(400).json({ error: '没有文档导入成功（内容太短或已达上限）', results })
    return res.json({ ok: true, imported: okCount, results })
  }

  const name = String(req.body?.name || '').trim()
  // 浏览器端选文件：前端把文件读成 base64 传上来，服务端统一走 decodeRefText（UTF-8 失败回退 GBK），
  // 这样 Windows 上存量的 GBK .txt 也不会变乱码。
  const b64 = String(req.body?.base64 || '').trim()
  if (b64) {
    const buf = Buffer.from(b64, 'base64')
    if (!buf.length) return res.status(400).json({ error: '文件内容为空' })
    const r = await addDoc(req.params.id, { name: name || '未命名文档', content: decodeRefText(buf) })
    if (r.error) return res.status(400).json({ error: r.error })
    return res.json({ ok: true, doc: r.doc, chunks: r.chunks })
  }
  const content = String(req.body?.content || '')
  if (!name || !content.trim()) return res.status(400).json({ error: '请填写文档名与内容' })
  const r = await addDoc(req.params.id, { name, content })
  if (r.error) return res.status(400).json({ error: r.error })
  res.json({ ok: true, doc: r.doc, chunks: r.chunks })
})

app.delete('/api/kb/:id/docs/:docId', async (req, res) => {
  const r = await removeDoc(req.params.id, req.params.docId)
  if (r.error) return res.status(404).json({ error: r.error })
  res.json({ ok: true })
})

// 检索：管家对话会自动用它；这里也开放出来供前端预览（?kb= 限定单个知识库）
app.get('/api/kb/search', (req, res) => {
  const q = String(req.query.q || '').trim()
  if (!q) return res.json({ hits: [], used: 0 })
  const topK = Math.min(12, Math.max(1, Number(req.query.topK) || 6))
  const kb = String(req.query.kb || '').trim()
  res.json(searchKb(q, { topK, budget: 1600, kbIds: kb ? [kb] : null }))
})

// 库内问答历史（ima 式右侧问答面板的会话记录）
app.get('/api/kb/:id/qa', (req, res) => res.json(listQa(req.params.id)))
app.delete('/api/kb/:id/qa', async (req, res) => {
  const r = await clearQa(req.params.id)
  if (r.error) return res.status(404).json({ error: r.error })
  res.json({ ok: true })
})

// 基于知识库问答：检索命中块 → 组装提示词 → 走任务系统（可轮询进度、可停笔）
app.post('/api/kb/ask', (req, res) => {
  const kbId = String(req.body?.kbId || '').trim()
  const question = String(req.body?.question || '').trim()
  if (!kbId || !question) return res.status(400).json({ error: '请输入问题' })
  if (!listKb().some(k => k.id === kbId)) return res.status(404).json({ error: '知识库不存在' })
  const conn = resolveConn(req.body?.modelId)
  if (!conn) return res.status(400).json({ error: '请先在模型设置中选择有效模型' })
  // 任务用 kb: 前缀占位 novelId，与小说任务天然隔离，同库问答互斥
  const scope = `kb:${kbId}`
  if (hasRunningSameKind(scope, 'kbask', 'write')) {
    return res.status(409).json({ error: '上一个问题还在回答中，可先停止或稍候再问' })
  }
  const hits = searchKb(question, { topK: 6, budget: 2400, kbIds: [kbId] }).hits
  const history = listQa(kbId).flatMap(e => [
    { role: 'user', content: e.q },
    { role: 'assistant', content: e.a }
  ])
  const job = registerJob({ ...newJob(scope, 'kbask'), modelId: conn.id })
  res.status(202).json({ jobId: job.id })
  ;(async () => {
    const finish = status => {
      job.status = status
      job.endedAt = Date.now()
      scheduleCleanup(job)
    }
    try {
      for await (const part of callAI(conn, {
        messages: kbAskMessages({ question, hits, history }),
        signal: job.ctrl.signal,
        maxTokens: MAX_TOKENS
      })) {
        if (job.stopRequested) throw new Error('已停止')
        // restart：传输层自动重试后思考从头再来，清空上一轮片段避免整段重复
        if (part.type === 'reasoning') job.reasoning = part.restart ? '' : job.reasoning + part.text
        else if (part.type === 'content') job.stream += part.text
      }
      const answer = job.stream.trim()
      if (!answer) throw new Error('AI 未返回有效内容，请重试')
      await pushQa(kbId, {
        q: question,
        a: answer,
        hits: hits.map(h => ({ docName: h.docName, text: String(h.text).slice(0, 120) })),
        modelId: conn.id
      })
      finish('done')
    } catch (e) {
      if (job.stopRequested) finish('stopped')
      else {
        failJob(job, e)
        finish('error')
      }
    }
  })()
})

// ---------- 应用偏好（阅读器字号等，不含任何密钥） ----------
const DEFAULT_PREFS = {
  fontSize: 16,
  lineHeight: 2.05,
  autoBackup: true,
  fontFamily: 'song',
  letterSpacing: 0.01,
  paragraphSpacing: 0.9,
  indent: 2,
  align: 'justify',
  readingWidth: 38
}

app.get('/api/settings', (_req, res) => {
  res.json({
    ...DEFAULT_PREFS,
    ...readJson(SETTINGS_FILE, {}),
    // 存储位置诊断：relocated 非空说明配置的目录不可写、实际数据落在了别处
    storage: { dir: DATA_DIR, relocated: DATA_DIR_RELOCATED || '' }
  })
})

app.put('/api/settings', (req, res) => {
  const body = req.body || {}
  const merged = { ...DEFAULT_PREFS, ...readJson(SETTINGS_FILE, {}) }
  if (typeof body.fontSize === 'number') merged.fontSize = Math.min(Math.max(body.fontSize, 12), 26)
  if (typeof body.lineHeight === 'number') merged.lineHeight = Math.min(Math.max(body.lineHeight, 1.4), 2.8)
  if (typeof body.autoBackup === 'boolean') merged.autoBackup = body.autoBackup
  if (body.fontFamily === 'song' || body.fontFamily === 'hei' || body.fontFamily === 'kai')
    merged.fontFamily = body.fontFamily
  if (typeof body.letterSpacing === 'number') merged.letterSpacing = Math.min(Math.max(body.letterSpacing, 0), 0.2)
  if (typeof body.paragraphSpacing === 'number')
    merged.paragraphSpacing = Math.min(Math.max(body.paragraphSpacing, 0), 2.4)
  if (typeof body.indent === 'number') merged.indent = Math.min(Math.max(Math.round(body.indent), 0), 4)
  if (body.align === 'left' || body.align === 'justify') merged.align = body.align
  if (typeof body.readingWidth === 'number') merged.readingWidth = Math.min(Math.max(body.readingWidth, 28), 56)
  writeJson(SETTINGS_FILE, merged)
  res.json(merged)
})

// ---------- 后台任务系统 ----------
// 生成任务在服务进程内运行，与浏览器连接无关：可离开页面、关掉窗口，
// 回来后仍能看到进度与结果（应用退出则任务停止，已完成章节已持久化）。
const jobs = new Map() // jobId -> job

function newJob(novelId, type) {
  const job = {
    id: crypto.randomUUID(),
    novelId,
    type, // 'outline' | 'chapter' | 'master' | 'detect' | 'inspire' | 'chat' | 'consistency'
    kind: 'write', // write | continue | polish
    status: 'running', // running | done | error | stopped
    stream: '',
    reasoning: '', // 思考型模型的推理过程，与正文分开存放展示
    chapterIndex: null,
    extraPrompt: '',
    error: '',
    // 写作 Agent 的阶段：'' (未启用) | plan | draft | review | revise | done
    stage: '',
    stageNote: '',
    agent: false,
    agentDepth: 'full',
    truncated: false,
    startedAt: Date.now(),
    endedAt: null,
    stopRequested: false,
    ctrl: new AbortController(), // 强制停笔：直接掐断底层请求
    errorStatus: null,
    errorCode: ''
  }
  return job
}

// 注册任务：入任务表（清理在任务结束后才安排，避免长任务被自己删掉）
function registerJob(job) {
  jobs.set(job.id, job)
  // 兜底回收：流悬挂 / finish 未执行的任务 2 小时后强制结束并出表，
  // 否则 jobs Map 泄漏且同书同类任务永久 409。
  // 出表前必须先 abort 底层请求：只改状态的话，上游 AI 调用会继续烧 token，
  // 而任务已出表，前端连「停笔」都无处可发。
  const guard = setTimeout(
    () => {
      if (job.status === 'running') {
        job.stopRequested = true
        job.status = 'error'
        job.error = job.error || '任务超时未结束，已自动回收'
        job.endedAt = Date.now()
        try {
          job.ctrl.abort()
        } catch {
          /* 已中止 */
        }
      }
      if (jobs.get(job.id) === job) jobs.delete(job.id)
    },
    2 * 60 * 60 * 1000
  )
  guard.unref?.()
  // 记下守卫句柄（不可枚举，避免混进 jobPublic/JSON）：scheduleCleanup 到点删除任务时
  // 顺手 clearTimeout，否则这个闭包会替已结束的任务再抱住 stream/reasoning 大字符串达 2 小时
  Object.defineProperty(job, 'guardTimer', { value: guard, enumerable: false, configurable: true })
  return job
}

/**
 * 记录任务失败：写内存字段（供前端展示）并落一行日志（供事后排查）。
 *
 * 上游返回的 4xx 会带上 status / code，日志里一并记下，这样「AI 接口错误」这句话
 * 才有办法追到具体原因（模型名不对 / 参数不被支持 / 密钥无权限）。
 */
function failJob(job, e) {
  job.error = String(e?.message || e)
  job.errorStatus = Number(e?.status) || null
  job.errorCode =
    e?.code || (job.errorStatus === 403 ? 'MODEL_FORBIDDEN' : job.errorStatus === 400 ? 'MODEL_BAD_REQUEST' : '')
  const tail = job.errorStatus ? ` status=${job.errorStatus}` : ''
  const code = job.errorCode ? ` code=${job.errorCode}` : ''
  const model = job.modelId ? ` modelId=${job.modelId}` : ''
  appendLog('job:error', `type=${job.type} novel=${job.novelId}${model}${tail}${code} err=${job.error}`)
}

// 任务结束后延迟清理，保留一段时间供前端查看结果
function scheduleCleanup(job) {
  const t = setTimeout(
    () => {
      if (job.status !== 'running') {
        jobs.delete(job.id)
        // 释放 2h 兜底守卫：它闭包持有 job（含整段 stream），不清会导致已结束任务长期占内存
        if (job.guardTimer) clearTimeout(job.guardTimer)
        job.stream = ''
        job.reasoning = ''
      }
    },
    30 * 60 * 1000
  )
  t.unref?.()
}

function jobPublic(job) {
  // ctrl 是运行时句柄，不应对外暴露。
  // 用 delete 逐个剔除，避免解构出未使用的绑定（no-unused-vars 也会因此误报）。
  const pub = { ...job }
  delete pub.ctrl
  return {
    ...pub,
    kind: job.kind || 'write',
    count: job.count ?? null,
    mode: job.mode ?? null,
    isFinal: !!job.isFinal,
    batch: !!job.batch,
    chapterIndex: job.chapterIndex ?? null,
    chapterIndices: job.chapterIndices ?? null
  }
}

/**
 * 增量视图：给已经拿到前面内容的调用方只回「新增的那一段」。
 *
 * 背景——前端原本每 1.2 秒整包拉一次 jobPublic，正文越长单次响应越大：
 * 写 4000 字的中途，每次轮询都要把已生成的 3000+ 字重传一遍，
 * 30 次轮询累计约 100KB 的重复流量，且每次都要 JSON 解析整段字符串。
 *
 * 这里按调用方给的游标切一刀：
 *   since.streamLen / since.reasoningLen  —— 上次已收到的字符数
 * 响应里给出对应的增量与新的游标，前端只需 append。
 * 游标是「字符数」而非字节数，和 job.stream 的字符串长度严格对应；
 * 若前端发现服务端返回的长度小于自己的长度（理论上不该发生，除非任务被重置），
 * 则视为 Reset，前端整体替换而不是 append。
 */
function jobDelta(job, since) {
  const full = typeof job.stream === 'string' ? job.stream : ''
  const reasoning = typeof job.reasoning === 'string' ? job.reasoning : ''
  const sLen = Math.max(0, Math.min(Number(since?.streamLen) || 0, full.length))
  const rLen = Math.max(0, Math.min(Number(since?.reasoningLen) || 0, reasoning.length))
  const base = jobPublic(job)
  // stream / reasoning 全量字段对增量调用方没有意义，去掉避免白白序列化
  const { stream: _s, reasoning: _r, ...meta } = base
  return {
    ...meta,
    delta: {
      stream: full.slice(sLen),
      reasoning: reasoning.slice(rLen),
      streamLen: full.length,
      reasoningLen: reasoning.length
    }
  }
}

// 任务完成后的通知（无实际推送，靠前端轮询；listeners 预留）

async function runMasterJob(job) {
  const novel = getNovel(job.novelId)
  const conn = resolveConn(job.modelId || novel?.modelId)
  if (!conn) throw new Error('请先为本书或本次任务选择模型')
  let full = ''
  for await (const part of callAI(conn, {
    messages: masterMessages(novel),
    // 思考型模型会把配额大量消耗在推理过程上，总纲又是长文，给足输出上限避免“思考完没正文”
    maxTokens: MAX_TOKENS,
    signal: job.ctrl.signal
  })) {
    if (job.stopRequested) throw new Error('已停止')
    if (part.type === 'reasoning') {
      if (part.restart) job.reasoning = ''
      else job.reasoning += part.text
    } else if (part.type === 'meta') {
      if (part.truncated) job.truncated = true
    } else if (part.type === 'content') {
      full += part.text
      job.stream = full
    }
  }
  const text = full.trim()
  if (!text) throw new Error('AI 未返回有效内容，请重试')
  if (job.truncated)
    job.stream = text + '\n\n⚠️ 输出达到模型长度上限被截断，以上可能不是完整总纲；可换输出上限更大的模型重试。'
  const fresh = getNovel(job.novelId)
  // 生成期间用户手改了总纲 → 拒绝覆盖（无论开始是否为空，凡与开始时不同的都拒绝）
  if ((fresh.masterOutline || '') !== (novel.masterOutline || '')) {
    throw new Error('总纲在生成期间被手动修改过，为避免覆盖你的改动，本次结果未写入。可重新发起。')
  }
  // 落库走书级事务：整书读改写若绕过写队列，会与章节任务/管家动作的事务写入互相覆盖
  await updateNovel(job.novelId, n => {
    if (n.masterOutline?.trim()) pushHistory(n, '生成总纲前')
    n.masterOutline = text
    return n
  })
}

async function runOutlineJob(job) {
  const novel = getNovel(job.novelId)
  const conn = resolveConn(job.modelId || novel?.modelId)
  if (!conn) throw new Error('请先为本书或本次任务选择模型')
  const opts = { count: job.count, mode: job.mode, isFinal: job.isFinal }

  const collect = async messages => {
    let full = ''
    for await (const part of callAI(conn, {
      messages,
      signal: job.ctrl.signal,
      maxTokens: MAX_TOKENS,
      temperature: 0.5
    })) {
      if (job.stopRequested) throw new Error('已停止')
      if (part.type === 'reasoning') {
        if (part.restart) job.reasoning = ''
        else job.reasoning += part.text
      } else if (part.type === 'content') {
        full += part.text
        job.stream = full
      }
    }
    return full
  }

  // 章号基准提前算好，提示词与落盘使用同一个值
  const fresh = getNovel(job.novelId)
  if (!fresh) throw new Error('小说不存在或已被删除，本次大纲未写入')
  const mode = opts.mode === 'replace' ? 'replace' : 'append'
  const base = mode === 'append' ? Math.max(0, ...(fresh.outline || []).map(o => o.index || 0)) : 0

  let full = await collect(outlineMessages(novel, { ...opts, base }))
  let outline = extractJsonArray(full)

  // 解析失败自动重试一次：把模型上次的错误输出回给它，明确要求纯 JSON 数组
  if (!outline || !outline.length) {
    job.stream = ''
    full = await collect([
      ...outlineMessages(novel, { ...opts, base }),
      { role: 'assistant', content: String(full).slice(0, 2000) },
      {
        role: 'user',
        content:
          '你上面输出的不是合法的 JSON 数组（可能夹了解释文字、用了代码围栏，或输出被截断）。请重新输出：只输出一个合法的 JSON 数组本身，以 [ 开始、以 ] 结束，不要任何解释、不要代码围栏。每个元素形如 {"index":数字,"title":"章节标题","summary":"结构化框架，含【开场】【事件】【交锋】【情感】【钩子】五个部分"}。'
      }
    ])
    outline = extractJsonArray(full)
  }
  if (!outline || !outline.length) {
    throw new Error(
      'AI 两次输出都不是合法 JSON（输出可能被长度上限截断）。建议：把「本次排几章」调小一些再排，或到【模型设置】换一个输出更稳定的模型'
    )
  }

  // 生成结束后重读最新数据再合并：大纲与正文任务可并行（互不覆盖彼此的落盘结果）。
  // 合并与落盘整体跑进书级事务——事务外的读改写会与并行任务的写入互相覆盖。
  await updateNovel(job.novelId, latest0 => {
    const latest = latest0 || fresh
    if ((latest.outline || []).length) pushHistory(latest, mode === 'replace' ? '覆盖重排大纲前' : '续排大纲前')
    const oldPrompts = new Map((latest.outline || []).map(o => [o.index, o.customPrompt || '']))
    const oldOids = new Map((latest.outline || []).map(o => [o.index, o.oid]))
    // 章号基准以生成结束时的大纲为准：提示词用的 base 与并发期间的改动取较大者，避免撞号
    const latestBase = Math.max(0, ...(latest.outline || []).map(o => o.index || 0))
    const writeBase = mode === 'append' ? Math.max(base, latestBase) : 0
    const incoming = outline
      // 规范化：只收有实际内容的行，字段兜底为字符串
      .map(o => ({
        title: String(o?.title ?? '').trim(),
        summary: String(o?.summary ?? o?.desc ?? '').trim()
      }))
      .filter(o => o.title || o.summary)
      .map((o, i) => {
        const index = writeBase + i + 1
        return {
          index,
          title: o.title || `第${index}章`,
          summary: o.summary,
          customPrompt: mode === 'replace' ? oldPrompts.get(index) || '' : '',
          // replace 模式复用同章号的 oid，让已写正文仍能对齐
          oid: (mode === 'replace' ? oldOids.get(index) : null) || crypto.randomUUID()
        }
      })
    if (!incoming.length) throw new Error('AI 返回的大纲条目内容为空，请重试')
    latest.outline =
      mode === 'append' ? [...(latest.outline || []), ...incoming].sort((a, b) => a.index - b.index) : incoming
    syncChapterIndices(latest)
    return latest
  })
}

// 选择性重写大纲：只替换被选中章节的标题和摘要，保留 oid 和其余章节
async function runOutlineRewriteJob(job) {
  const novel = getNovel(job.novelId)
  const conn = resolveConn(job.modelId || novel?.modelId)
  if (!conn) throw new Error('请先为本书或本次任务选择模型')
  const indices = Array.isArray(job.chapterIndices) ? job.chapterIndices : []
  if (!indices.length) throw new Error('未指定要重写的章节')

  const collect = async messages => {
    let full = ''
    for await (const part of callAI(conn, {
      messages,
      signal: job.ctrl.signal,
      maxTokens: MAX_TOKENS,
      temperature: 0.5
    })) {
      if (job.stopRequested) throw new Error('已停止')
      if (part.type === 'reasoning') {
        if (part.restart) job.reasoning = ''
        else job.reasoning += part.text
      } else if (part.type === 'content') {
        full += part.text
        job.stream = full
      }
    }
    return full
  }

  const fresh = getNovel(job.novelId)
  let full = await collect(outlineRewriteMessages(novel, indices))
  let rewritten = extractJsonArray(full)

  // 解析失败重试一次
  if (!rewritten || !rewritten.length) {
    job.stream = ''
    full = await collect([
      ...outlineRewriteMessages(novel, indices),
      { role: 'assistant', content: String(full).slice(0, 2000) },
      {
        role: 'user',
        content:
          '你上面输出的不是合法的 JSON 数组。请重新输出：只输出一个合法的 JSON 数组本身，以 [ 开始、以 ] 结束，不要任何解释或代码围栏。每个元素形如 {"index":数字,"title":"章节标题","summary":"结构化框架，含【开场】【事件】【交锋】【情感】【钩子】五个部分"}。'
      }
    ])
    rewritten = extractJsonArray(full)
  }
  if (!rewritten || !rewritten.length) {
    throw new Error('AI 两次输出都不是合法 JSON，请重试或换一个输出更稳定的模型')
  }

  // 生成结束后重读最新数据再合并：只替换选中章节，其余（含并发期间的改动）原样保留。
  // 合并落库整体走书级事务，避免与并行任务的写入互相覆盖。
  await updateNovel(job.novelId, latest0 => {
    const latest = latest0 || fresh
    if ((latest.outline || []).length) pushHistory(latest, '重写部分大纲前')

    // 保留旧大纲的 oid 和 customPrompt，只替换 title 和 summary
    const rewriteMap = new Map()
    for (const o of rewritten) {
      const idx = Number(o.index)
      if (idx > 0)
        rewriteMap.set(idx, { title: String(o.title || '').trim(), summary: String(o.summary || o.desc || '').trim() })
    }

    latest.outline = (latest.outline || []).map(o => {
      const rw = rewriteMap.get(o.index)
      if (rw && (rw.title || rw.summary)) {
        return { ...o, title: rw.title || o.title, summary: rw.summary || o.summary }
      }
      return o
    })

    syncChapterIndices(latest)
    return latest
  })
}

// 正文输出预算：中文约 1~1.5 字符/token，另留思考与结构余量；不再隐式使用 8192 默认。
function chapterMaxTokens(novel, kind) {
  const target = Math.max(Number(novel?.targetWords) || 2000, 500)
  const base = kind === 'continue' ? Math.ceil(target * 1.2) : Math.ceil(target * 2.5)
  return Math.min(32768, Math.max(8192, base + 4096))
}

/** 本地模型上下文小：把 contextTokens 折算成提示词字符预算（中文约 1 token ≈ 1.5 字，给输出留 40%） */
function promptLimitFor(conn) {
  const ctx = Number(conn?.contextTokens) || 0
  if (!ctx) return 0
  return Math.max(4000, Math.floor(ctx * 1.5 * 0.6))
}

/** 取一次完整回复但**不写入 job.stream**：方案、审稿这类中间产物不该混进正文流 */
async function collectOnce(job, conn, messages, maxTokens) {
  let out = ''
  for await (const part of callAI(conn, { messages, signal: job.ctrl.signal, maxTokens })) {
    if (job.stopRequested) throw new Error('已停止')
    if (part.type === 'content') out += part.text
  }
  return out
}

/** 流式写正文：累加到 job.stream，返回本次完整文本与截断状态 */
async function streamInto(job, conn, messages, maxTokens) {
  let full = ''
  let truncated = false
  let finishReason = ''
  for await (const part of callAI(conn, { messages, signal: job.ctrl.signal, maxTokens })) {
    if (job.stopRequested) throw new Error('已停止')
    if (part.type === 'reasoning') {
      if (part.restart) job.reasoning = ''
      else job.reasoning += part.text
    } else if (part.type === 'meta') {
      truncated = !!part.truncated
      finishReason = part.finishReason || ''
    } else if (part.type === 'content') {
      full += part.text
      job.stream += part.text
    }
  }
  return { full, truncated, finishReason }
}

async function runChapterJob(job) {
  const novel = getNovel(job.novelId)
  const conn = resolveConn(job.modelId || novel?.modelId)
  if (!conn) throw new Error('请先为本书或本次任务选择模型')
  const idx = job.chapterIndex
  const kind = job.kind || 'write' // write | continue | polish | revise | deai
  const before = (novel.chapters || []).find(c => c.index === idx)
  const beforeHash = before?.content ? hashText(before.content) : ''
  // 关联前文：任务级开关 > 书级偏好（novel.linkContext，默认开）
  const linkContext = typeof job.linkContext === 'boolean' ? job.linkContext : novel.linkContext !== false
  // 知识库检索：用本章标题+大纲摘要当查询，捞相关块（正文管线此前只进管家对话，这是补齐）
  const curOutline = (novel.outline || []).find(o => o.index === idx)
  const kbQuery = `${curOutline?.title || ''} ${curOutline?.summary || ''}`.trim()
  const kbContext = kbQuery ? kbContextText(searchKb(kbQuery, { topK: 4, budget: 1200 }).hits) : ''
  const limit = promptLimitFor(conn)
  // 写作 Agent：只有「整章重写」走四阶段（构思/起草/自检/修订）；
  // 续写/润色/改稿/降 AI 都是对既有正文的一次性变换，加方案与审稿只会更慢更贵。
  const agentMode = !!job.agent && kind === 'write'
  const { extraPrompt } = job

  let messages
  let brief = null
  if (agentMode) {
    job.stage = 'plan'
    job.stageNote = '正在设计本章节拍…'
    try {
      const raw = await collectOnce(
        job,
        conn,
        chapterBriefMessages(novel, idx, {
          limit: limit ? Math.min(limit, 12000) : 12000,
          linkContext,
          extraPrompt
        }),
        2048
      )
      const parsed = extractJsonObject(raw)
      if (parsed && Array.isArray(parsed.beats) && parsed.beats.length) {
        brief = parsed
        job.brief = parsed
      } else job.stageNote = '方案格式不完整，直接起草'
    } catch (e) {
      // 方案失败不能拖垮整章：退回一次性成文，作者仍然拿得到正文
      if (job.stopRequested) throw e
      job.stageNote = '方案生成失败，直接起草'
    }
    messages = chapterMessages(novel, idx, { linkContext, kbContext, brief, limit, extraPrompt })
  } else {
    messages =
      kind === 'continue'
        ? continueMessages(novel, idx, job.extraPrompt, { kbContext, limit })
        : kind === 'polish'
          ? polishMessages(novel, idx, job.extraPrompt, { kbContext, limit })
          : kind === 'revise'
            ? reviseMessages(novel, idx, job.extraPrompt, { kbContext, limit })
            : kind === 'deai'
              ? dehumanizeMessages(novel, idx, job.extraPrompt, { limit })
              : chapterMessages(novel, idx, { linkContext, kbContext, limit, extraPrompt })
  }

  let full = ''
  let truncated = false
  let finishReason = ''
  job.stage = 'draft'
  job.stageNote = ''
  job.stream = ''
  try {
    const drafted = await streamInto(job, conn, messages, chapterMaxTokens(novel, kind))
    full = drafted.full
    truncated = drafted.truncated
    finishReason = drafted.finishReason
  } catch (e) {
    // 停笔或中途失败时，把已生成的文字保存为草稿，避免劳动成果丢失。
    // 覆盖前先留版本快照：草稿会**整体替换**章节正文（润色/修改/降AI 尤其如此），
    // 失败路径原先既不留快照也不做防覆盖校验——中途停笔一次，整章成品就被半截草稿顶掉。
    // 注意取 job.stream 而不是 full：流中途抛错时 full 还没被赋值，已生成的部分只在 job.stream 里。
    const partial = cleanChapter(job.stream || full)
    if (!job.previewOnly && partial && countTextUnits(partial) > 50) {
      const draftContent = kind === 'continue' ? joinContinue(before?.content, partial) : partial
      const fresh = getNovel(job.novelId)
      const existing = (fresh?.chapters || []).find(c => c.index === idx)
      if (existing?.content?.trim()) pushHistory(fresh, `停笔存草稿前（第${idx}章）`)
      try {
        const saved = await saveChapterContent(job.novelId, idx, draftContent, 'draft', undefined, beforeHash)
        if (!saved) throw new Error('小说不存在')
        job.savedDraft = true
      } catch {
        // 草稿没写成（生成期间被手动修改，防覆盖校验拒绝 / 落盘失败）：
        // 保留真正的失败原因（已停止 / 网络原因），用户手改的正文保持原样不被覆盖
      }
    }
    throw e
  }

  // 输出被模型上限截断：保存草稿，绝不把半章标记为已完成
  if (truncated) {
    // 截断元数据先落，草稿写入若被防覆盖校验拒绝，错误信息也不会丢掉截断事实
    job.truncated = true
    job.finishReason = finishReason || 'length'
    const partial = cleanChapter(full)
    if (partial && !job.previewOnly) {
      const draftContent = kind === 'continue' ? joinContinue(before?.content, partial) : partial
      const fresh = getNovel(job.novelId)
      const existing = (fresh?.chapters || []).find(c => c.index === idx)
      if (existing?.content?.trim()) pushHistory(fresh, `截断存草稿前（第${idx}章）`)
      const saved = await saveChapterContent(job.novelId, idx, draftContent, 'draft', undefined, beforeHash)
      if (!saved) throw new Error('草稿保存失败，未能写入本地数据')
      job.savedDraft = true
    }
    job.outputChars = countTextUnits(partial)
    throw new Error(
      `模型输出达到上限被截断（finish_reason=${finishReason || 'length'}），已把已生成部分保存为草稿。可调低每章目标字数、更换输出上限更大的模型，或用「续写」接着写完。`
    )
  }

  // 第二阶段：自检 → 只改被指出的问题。
  // 任何一步失败都保留初稿：作者要的是能用的正文，不是一份完美但空白的报告。
  if (agentMode && job.agentDepth !== 'draft' && !truncated) {
    const draftText = cleanChapter(full)
    if (draftText && countTextUnits(draftText) > 300) {
      try {
        job.stage = 'review'
        job.stageNote = '正在自检'
        const reviewRaw = await collectOnce(
          job,
          conn,
          chapterReviewMessages(novel, idx, draftText, { limit: limit ? Math.min(limit, 30000) : 30000, extraPrompt }),
          2048
        )
        const report = extractJsonObject(reviewRaw) || null
        const issues = pickActionableIssues(report)
        job.review = { ...(report && typeof report === 'object' ? report : {}), issues }
        if (issues.length) {
          job.stage = 'revise'
          job.stageNote = `按 ${issues.length} 条意见修订`
          job.stream = ''
          const fixed = await streamInto(
            job,
            conn,
            chapterFixMessages(novel, idx, draftText, issues, {
              limit: limit ? Math.min(limit, 45000) : 45000,
              extraPrompt
            }),
            chapterMaxTokens(novel, kind)
          )
          const fixedText = cleanChapter(fixed.full)
          // 修订版被截断或明显短于初稿 → 判定为「改坏了」，回退初稿
          if (
            fixedText &&
            !fixed.truncated &&
            countTextUnits(fixedText) >= Math.floor(countTextUnits(draftText) * 0.6)
          ) {
            full = fixedText
            job.stream = fixedText
            job.revised = true
            job.stageNote = `已按 ${issues.length} 条意见修订`
          } else {
            job.stream = draftText
            job.stageNote = '修订未完成，保留初稿'
          }
        } else {
          job.stageNote = '自检通过，无需修订'
        }
      } catch (e) {
        if (job.stopRequested) throw e
        job.stream = cleanChapter(full)
        job.stageNote = `自检未完成，保留初稿：${e.message || e}`
        appendLog('writer-agent', `第 ${idx} 章自检失败：${e.message || e}`)
      }
    }
  }
  job.stage = 'done'

  let content = cleanChapter(full)
  if (!content) throw new Error('AI 未返回有效内容，请重试')

  if (job.previewOnly) {
    if (!before) throw new Error('待审校章节不存在')
    const candidate = kind === 'continue' ? joinContinue(before.content, content) : content
    job.proposals ||= []
    job.proposals.push({
      id: crypto.randomUUID(),
      index: idx,
      oid: before.oid,
      title: before.title,
      original: before.content,
      content: candidate,
      status: 'pending'
    })
    job.outputChars = countTextUnits(candidate)
    return
  }
  const fresh = getNovel(job.novelId)
  if (!fresh) throw new Error('小说不存在或已被删除，本次结果未写入')
  const existing = (fresh.chapters || []).find(c => c.index === idx)
  // 生成期间用户手改了本章 → 拒绝直接覆盖，避免接缝错乱。
  // 包含用户把正文清空的情况：beforeHash 非空、nowHash 为空也必须拒绝。
  const nowHash = existing?.content ? hashText(existing.content) : ''
  if (nowHash !== beforeHash) {
    throw new Error('本章在生成期间被手动修改过，为避免覆盖你的改动，本次结果未写入。可重新发起。')
  }
  if (kind === 'polish' && existing?.content?.trim()) pushHistory(fresh, `润色第${idx}章前`)
  if (kind === 'revise' && existing?.content?.trim()) pushHistory(fresh, `修改第${idx}章前`)
  if (kind === 'deai' && existing?.content?.trim()) pushHistory(fresh, `降AI第${idx}章前`)
  // 重写（write）也有正文被整章替换的风险：以前只有润色/修改/降AI 留档，
  // 对已有章节点「生成」会直接覆盖且无处回滚。这里补上同一道快照。
  if (kind === 'write' && existing?.content?.trim()) pushHistory(fresh, `重写第${idx}章前`)
  if (kind === 'continue') content = joinContinue(existing?.content, content)

  job.outputChars = countTextUnits(content)
  job.finishReason = finishReason || 'stop'
  // 审稿阶段顺带抽取的章末状态 / 待回收线索落进章节上下文，供后续章节的
  // 「人物当前状态」「连续性账本」提示词段使用（此前这两段恒空，跨章追踪未接线）
  const stateExtra =
    job.review && typeof job.review === 'object'
      ? { characterState: job.review.characterState, openThreads: job.review.openThreads }
      : undefined
  const saved = await saveChapterContent(job.novelId, idx, content, 'done', stateExtra, beforeHash)
  if (!saved) throw new Error('章节保存失败，任务未能完成落盘')
}

// AI 痕迹检测：逐章分析，结果拼成一份报告文本
async function runDetectJob(job) {
  const novel = getNovel(job.novelId)
  if (!novel) throw new Error('小说不存在或已被删除')
  const conn = resolveConn(job.modelId || novel?.modelId)
  if (!conn) throw new Error('请先为本书或本次任务选择模型')
  const indices = Array.isArray(job.chapterIndices) ? job.chapterIndices : []
  if (!indices.length) throw new Error('未指定要检测的章节')
  let report = ''
  for (const idx of indices) {
    if (job.stopRequested) throw new Error('已停止')
    job.chapterIndex = idx
    job.stream = report
    for await (const part of callAI(conn, {
      temperature: 0.3,
      messages: detectAIMessages(novel, idx),
      signal: job.ctrl.signal
    })) {
      if (job.stopRequested) throw new Error('已停止')
      if (part.type === 'reasoning') {
        // 传输层重试会发 restart：不清空就把上一轮思考整段重复拼进来
        job.reasoning = part.restart ? '' : job.reasoning + part.text
      } else if (part.type === 'meta') {
        if (part.truncated) job.truncated = true
      } else if (part.type === 'content') {
        report += part.text
        job.stream = report
      }
    }
    report += '\n\n---\n\n'
    job.stream = report
  }
  if (job.truncated) {
    report += '\n\n⚠️ 部分章节的检测输出被模型长度上限截断，结论可能不完整，可分小批重试。\n'
    job.stream = report
  }
}

// 拆书（对标星月）：逐块逆向参考作品的技法，再汇总成报告落盘。
// 早期是 HTTP 内联多轮 AI 调用（10+ 块要烧几分钟，请求必超时且无法中止），
// 迁入任务系统后：关弹窗 / 关窗口都不影响，轮询 job.stream 能看到逐块进度，
// job.result = { chunks, report, file }。
async function runDeconstructJob(job) {
  const novel = getNovel(job.novelId)
  const conn = resolveConn(job.modelId || novel?.modelId)
  if (!conn) throw new Error('请先为本书或本次任务选择模型')
  const folderPath = String(job.folderPath || novel?.folderPath || '').trim()
  if (!folderPath) throw new Error('请先指定参考小说文件夹路径')
  if (!fs.existsSync(folderPath)) throw new Error(`文件夹不存在：${folderPath}`)

  const SUPPORTED_EXTS = ['.txt', '.md', '.text']
  const files = []
  try {
    for (const entry of fs.readdirSync(folderPath)) {
      if (!SUPPORTED_EXTS.includes(path.extname(entry).toLowerCase())) continue
      try {
        const content = decodeRefText(fs.readFileSync(path.join(folderPath, entry)))
        if (countTextUnits(content) > 100) files.push({ name: entry, content })
      } catch {
        /* 跳过读不出的文件 */
      }
    }
  } catch (e) {
    throw new Error(`读取文件夹失败：${e.message}`)
  }
  if (!files.length) throw new Error('文件夹中没有找到有效的参考小说文件（.txt 或 .md）')

  // 分块：优先按章节标题切（第X章/回），切不出来再按字数硬切。总量封顶，防止一口气烧掉太多 token。
  const MAX_CHUNKS = 10
  const CHUNK_CHARS = 4200
  const chunks = []
  for (const f of files) {
    const flat = f.content.replace(/\r\n/g, '\n').trim()
    const parts = flat.split(/\n(?=\s*第[一二三四五六七八九十百千0-9]+[章节回])/g).filter(p => p.trim().length > 400)
    const units = parts.length > 1 ? parts : flat.match(new RegExp('.{1,' + CHUNK_CHARS + '}', 'gs')) || []
    for (const u of units) {
      if (chunks.length >= MAX_CHUNKS) break
      chunks.push({ label: f.name, text: u.slice(0, CHUNK_CHARS + 600) })
    }
    if (chunks.length >= MAX_CHUNKS) break
  }
  if (!chunks.length) throw new Error('参考内容太短，不值得拆（至少需要 400 字）')

  job.chunkTotal = chunks.length
  job.chunkDone = 0
  const findings = []
  for (let i = 0; i < chunks.length; i++) {
    if (job.stopRequested) throw new Error('已停止')
    const c = chunks[i]
    let out = ''
    let chunkTrunc = false
    for await (const part of callAI(conn, {
      temperature: 0.3,
      maxTokens: MAX_TOKENS,
      messages: deconstructChunkMessages(c.label, c.text),
      signal: job.ctrl.signal
    })) {
      if (job.stopRequested) throw new Error('已停止')
      if (part.type === 'reasoning') job.reasoning = part.restart ? '' : job.reasoning + part.text
      else if (part.type === 'meta') {
        if (part.truncated) chunkTrunc = true
      } else if (part.type === 'content') {
        out += part.text
        job.stream = [...findings, `### ${c.label}（第 ${i + 1} 块 · 拆解中）\n${out.trim()}`].join('\n\n')
      }
    }
    findings.push(
      `### ${c.label}（第 ${i + 1} 块）\n${out.trim()}${chunkTrunc ? '\n（注：本块输出被长度上限截断，结论可能不完整）' : ''}`
    )
    job.chunkDone = i + 1
    job.stream = findings.join('\n\n')
  }

  let report = ''
  for await (const part of callAI(conn, {
    temperature: 0.4,
    maxTokens: MAX_TOKENS,
    messages: deconstructReportMessages(files.map(f => f.name).join('、'), findings.join('\n\n')),
    signal: job.ctrl.signal
  })) {
    if (job.stopRequested) throw new Error('已停止')
    if (part.type === 'reasoning') job.reasoning = part.restart ? '' : job.reasoning + part.text
    else if (part.type === 'content') report += part.text
  }
  report = report.trim()
  if (!report) throw new Error('AI 未返回拆书报告，请重试或换模型')

  // 报告落盘：拆书结论是长期资产，只放在内存里下次就没了
  const dir = path.join(REFBOOKS_DIR, job.novelId)
  fs.mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')
  const file = `拆书报告-${stamp}.md`
  fs.writeFileSync(
    path.join(dir, file),
    `# 拆书报告 · ${files.map(f => f.name).join('、')}\n\n> 生成于 ${new Date().toLocaleString('zh-CN')} · 共拆 ${chunks.length} 块\n\n${report}`,
    'utf8'
  )
  appendLog('deconstruct', `${job.novelId} 拆书完成：${chunks.length} 块 → ${file}`)
  job.result = { chunks: chunks.length, report, file }
}

// 灵感：AI 读前文 + 总纲 + 大纲，给出后续剧情灵感
async function runInspireJob(job) {
  const novel = getNovel(job.novelId)
  const conn = resolveConn(job.modelId || novel?.modelId)
  if (!conn) throw new Error('请先为本书或本次任务选择模型')
  let full = ''
  for await (const part of callAI(conn, {
    messages: inspireMessages(novel),
    signal: job.ctrl.signal
  })) {
    if (job.stopRequested) throw new Error('已停止')
    if (part.type === 'reasoning') {
      if (part.restart) job.reasoning = ''
      else job.reasoning += part.text
    } else if (part.type === 'meta') {
      if (part.truncated) job.truncated = true
    } else if (part.type === 'content') {
      full += part.text
      job.stream = full
    }
  }
  if (!full.trim()) throw new Error('AI 未返回有效内容')
  if (job.truncated) job.stream = full + '\n\n⚠️ 灵感输出达到模型长度上限，后面部分被截断。'
}

// 全书一致性检查：通读设定与正文，输出结构化问题清单挂在 job.result
async function runConsistencyJob(job) {
  const novel = getNovel(job.novelId)
  const conn = resolveConn(job.modelId || novel?.modelId)
  if (!conn) throw new Error('请先为本书或本次任务选择模型')
  let full = ''
  for await (const part of callAI(conn, {
    messages: consistencyMessages(novel),
    temperature: 0.2,
    signal: job.ctrl.signal
  })) {
    if (job.stopRequested) throw new Error('已停止')
    if (part.type === 'reasoning') {
      if (part.restart) job.reasoning = ''
      else job.reasoning += part.text
    } else if (part.type === 'meta') {
      if (part.truncated) job.truncated = true
    } else if (part.type === 'content') {
      full += part.text
      job.stream = full
    }
  }
  if (!full.trim()) throw new Error('AI 未返回有效内容')
  if (job.truncated) job.stream = full + '\n\n⚠️ 一致性检查输出被长度上限截断，清单可能不完整，可缩小检查范围重试。'
  // 解析 JSON 问题清单；失败时保留原文供阅读
  const parsed =
    extractJsonArray(full) ||
    (() => {
      try {
        return JSON.parse(full)
      } catch {
        return null
      }
    })()
  job.result = Array.isArray(parsed)
    ? parsed
    : [{ severity: 'unknown', location: '', issue: 'AI 未返回规范 JSON', evidence: full.slice(0, 600), suggestion: '' }]
}

function joinContinue(prev, add) {
  const p = String(prev || '').trim()
  return p ? `${p}\n\n${add}` : add
}

function hashText(s) {
  return crypto.createHash('sha1').update(String(s)).digest('hex')
}

// 统一的章节落盘：保持 oid 关联、标题继承，并写入连续性上下文快照。
//
// 写入走 saveChapterContentAtomic（书级串行事务）：
// 早期实现是「同步读全书 → 改一章 → 同步写全书」，流式生成每 1.2s 落一次草稿，
// 若此时管家正好在改另一章的正文，两者会互相覆盖（表现为「刚写的章不见了」）。
// 现在起**返回 Promise**，调用方应 await（否则只能保证最终一致）。
function saveChapterContent(novelId, idx, content, status, extra, expectedHash) {
  // extra / expectedHash 必须透传：expectedHash 是「本章内容与我开写时一致才允许覆盖」的
  // 防覆盖校验（saveChapterContentAtomic 内比对），早期版本在这里被丢掉，导致校验成死代码。
  return saveChapterContentAtomic(novelId, idx, content, status, extra, expectedHash)
}

// 小说当前任务：同本小说同时只跑一个任务
function novelRunningJob(novelId) {
  for (const j of jobs.values()) {
    if (j.novelId === novelId && j.status === 'running') return j
  }
  return null
}

// 同书同类任务互斥：避免两个大纲/两个正文写同一本书互相覆盖；
// 不同类任务（生成正文 vs 精修）仍可并行，与前端「各页面认领自己的任务」一致。
function hasRunningSameKind(novelId, type, kind) {
  const k = kind || 'write'
  for (const j of jobs.values()) {
    if (j.novelId === novelId && j.status === 'running' && j.type === type && (j.kind || 'write') === k) return true
  }
  return false
}

// 任务分发：按类型选择执行器，统一处理「完成 / 失败 / 清理」。
// 所有类型（含检测/灵感/一致性）都走这里，HTTP 路由与管家动作因此共用同一套启动逻辑。
function dispatchJob(job) {
  Promise.resolve()
    .then(() =>
      job.type === 'master'
        ? runMasterJob(job)
        : job.type === 'outline' && job.mode === 'rewrite'
          ? runOutlineRewriteJob(job)
          : job.type === 'outline'
            ? runOutlineJob(job)
            : job.type === 'detect'
              ? runDetectJob(job)
              : job.type === 'inspire'
                ? runInspireJob(job)
                : job.type === 'consistency'
                  ? runConsistencyJob(job)
                  : job.type === 'deconstruct'
                    ? runDeconstructJob(job)
                    : runChapterJob(job)
    )
    .then(() => {
      job.status = 'done'
      job.endedAt = Date.now()
      scheduleCleanup(job)
    })
    .catch(e => {
      job.status = job.stopRequested ? 'stopped' : 'error'
      failJob(job, e)
      job.endedAt = Date.now()
      scheduleCleanup(job)
    })
}

// 启动任务：成功返回 job。供 HTTP 路由与「管家动作」共用。
// 正文单章生成按「章」粒度互斥：不同章可同时生成（多章并行），同章及与连续完稿互斥；
// 其余任务沿用同书同类互斥，避免两个大纲/批量写同一本书互相覆盖。
function spawnJob(job) {
  if (job.type === 'chapter' && (job.kind || 'write') === 'write' && !job.batch) {
    for (const j of jobs.values()) {
      if (
        j.novelId !== job.novelId ||
        j.status !== 'running' ||
        j.type !== 'chapter' ||
        (j.kind || 'write') !== 'write'
      )
        continue
      if (j.batch || j.chapterIndex === job.chapterIndex) {
        throw Object.assign(
          new Error(
            j.batch ? '连续完稿任务运行中，请等待完成或先停笔' : `第 ${j.chapterIndex} 章正在生成中，请等待完成或先停笔`
          ),
          { status: 409 }
        )
      }
    }
  } else if (hasRunningSameKind(job.novelId, job.type, job.kind)) {
    throw Object.assign(new Error('已有同类任务在本作品后台运行，请等待完成或先停笔'), { status: 409 })
  }
  registerJob(job)
  dispatchJob(job)
  return job
}

// 启动任务路由统一封装：同类互斥返回 409，其余错误返回 4xx
function startJobRoute(res, runner) {
  try {
    const job = spawnJob(runner())
    res.status(202).json({ jobId: job.id })
  } catch (e) {
    res.status(e.status || 400).json({ error: String(e.message || e) })
  }
}

// 启动：生成总纲（可指定大纲用模型）
app.post('/api/generate/master', (req, res) => {
  const novelId = req.body?.novelId
  const novel = getNovel(novelId)
  if (!novel) return res.status(404).json({ error: '小说不存在' })
  startJobRoute(res, () => ({ ...newJob(novelId, 'master'), modelId: req.body?.modelId }))
})

// 启动：生成分段大纲（append 续写 / replace 重写；isFinal 结局段；可指定大纲用模型）
app.post('/api/generate/outline', (req, res) => {
  const novelId = req.body?.novelId
  const novel = getNovel(novelId)
  if (!novel) return res.status(404).json({ error: '小说不存在' })
  const count = Math.min(Math.max(Math.floor(Number(req.body?.count) || 6), 1), 30)
  const mode = req.body?.mode === 'replace' ? 'replace' : 'append'
  const isFinal = !!req.body?.isFinal
  if (mode === 'append' && !novel.masterOutline?.trim() && (novel.outline || []).length === 0) {
    // 首段大纲也允许无总纲直接生成，但提示语已由提示词兜底
  }
  startJobRoute(res, () => ({ ...newJob(novelId, 'outline'), count, mode, isFinal, modelId: req.body?.modelId }))
})

// 启动：选择性重写大纲（只重写指定章节，保留其余；可指定大纲用模型）
app.post('/api/generate/outline-rewrite', (req, res) => {
  const novelId = req.body?.novelId
  const novel = getNovel(novelId)
  if (!novel) return res.status(404).json({ error: '小说不存在' })
  const indices = Array.isArray(req.body?.chapterIndices)
    ? [...new Set(req.body.chapterIndices.map(Number).filter(n => Number.isSafeInteger(n) && n > 0))]
    : []
  if (!indices.length) return res.status(400).json({ error: '请选择要重写的章节' })
  startJobRoute(res, () => ({
    ...newJob(novelId, 'outline'),
    mode: 'rewrite',
    chapterIndices: indices,
    chapterIndex: indices[0],
    modelId: req.body?.modelId
  }))
})

// 启动：生成单章（可指定正文用模型；linkContext=false 时不关联前文；agent=true 走四阶段写作）
app.post('/api/generate/chapter', (req, res) => {
  const novelId = req.body?.novelId
  const chapterIndex = Number(req.body?.chapterIndex)
  const novel = getNovel(novelId)
  if (!novel) return res.status(404).json({ error: '小说不存在' })
  if (!Number.isSafeInteger(chapterIndex) || chapterIndex < 1) return res.status(400).json({ error: '章节序号不合法' })
  const agent = !!req.body?.agent
  const kindRaw = String(req.body?.kind || 'write')
  const kind = ['write', 'continue', 'polish', 'revise'].includes(kindRaw) ? kindRaw : 'write'
  const extraPrompt = String(req.body?.extraPrompt || '').trim()
  const chapter = (novel.chapters || []).find(c => c.index === chapterIndex)
  if ((kind === 'continue' || kind === 'polish') && !chapter?.content?.trim())
    return res.status(400).json({ error: '本章还没有正文，无法续写或润色' })
  if (kind === 'revise' && !extraPrompt) return res.status(400).json({ error: '请描述需要修改的问题' })
  startJobRoute(res, () => {
    const job = newJob(novelId, 'chapter')
    job.chapterIndex = chapterIndex
    job.kind = kind
    job.extraPrompt = extraPrompt
    job.modelId = req.body?.modelId
    job.linkContext = typeof req.body?.linkContext === 'boolean' ? req.body.linkContext : undefined
    job.agent = agent && kind === 'write'
    job.agentDepth = req.body?.agentDepth === 'draft' ? 'draft' : 'full'
    // 写作页的 AI 面板只要一份候选稿，不直接覆盖正文：走 previewOnly，作者确认后才落盘
    job.previewOnly = !!req.body?.previewOnly
    return job
  })
})

// 启动：AI 续写本章（接在现有正文之后）
app.post('/api/generate/continue', (req, res) => {
  const novelId = req.body?.novelId
  const chapterIndex = Number(req.body?.chapterIndex)
  const novel = getNovel(novelId)
  if (!novel) return res.status(404).json({ error: '小说不存在' })
  if (!Number.isSafeInteger(chapterIndex) || chapterIndex < 1) return res.status(400).json({ error: '章节序号不合法' })
  const chapter = (novel.chapters || []).find(c => c.index === chapterIndex)
  if (!chapter?.content?.trim()) return res.status(400).json({ error: '本章还没有正文，无法续写' })
  startJobRoute(res, () => ({
    ...newJob(novelId, 'chapter'),
    chapterIndex,
    kind: 'continue',
    extraPrompt: String(req.body?.extraPrompt || '').trim(),
    modelId: req.body?.modelId
  }))
})

// 启动：AI 润色本章（重写整章文字，保留情节）
app.post('/api/generate/polish', (req, res) => {
  const novelId = req.body?.novelId
  const chapterIndex = Number(req.body?.chapterIndex)
  const novel = getNovel(novelId)
  if (!novel) return res.status(404).json({ error: '小说不存在' })
  if (!Number.isSafeInteger(chapterIndex) || chapterIndex < 1) return res.status(400).json({ error: '章节序号不合法' })
  const chapter = (novel.chapters || []).find(c => c.index === chapterIndex)
  if (!chapter?.content?.trim()) return res.status(400).json({ error: '本章还没有正文，无法润色' })
  startJobRoute(res, () => ({
    ...newJob(novelId, 'chapter'),
    chapterIndex,
    kind: 'polish',
    extraPrompt: String(req.body?.extraPrompt || '').trim(),
    modelId: req.body?.modelId
  }))
})

// 启动：AI 修改本章（作者指出问题，AI 通读全章后针对性修改）
app.post('/api/generate/revise', (req, res) => {
  const novelId = req.body?.novelId
  const chapterIndex = Number(req.body?.chapterIndex)
  const novel = getNovel(novelId)
  if (!novel) return res.status(404).json({ error: '小说不存在' })
  if (!Number.isSafeInteger(chapterIndex) || chapterIndex < 1) return res.status(400).json({ error: '章节序号不合法' })
  const chapter = (novel.chapters || []).find(c => c.index === chapterIndex)
  if (!chapter?.content?.trim()) return res.status(400).json({ error: '本章还没有正文，无法修改' })
  const issue = String(req.body?.issue || '').trim()
  if (!issue) return res.status(400).json({ error: '请描述需要修改的问题' })
  startJobRoute(res, () => ({
    ...newJob(novelId, 'chapter'),
    chapterIndex,
    kind: 'revise',
    extraPrompt: issue,
    modelId: req.body?.modelId
  }))
})

// 启动：连续生成（一个任务内串行写完剩余章节；可指定正文用模型与是否关联前文）
app.post('/api/generate/all', (req, res) => {
  const novelId = req.body?.novelId
  const novel = getNovel(novelId)
  if (!novel) return res.status(404).json({ error: '小说不存在' })

  if (hasRunningSameKind(novelId, 'chapter', 'write')) {
    return res.status(409).json({ error: '已有正文生成任务在本作品后台运行，请等待完成或先停笔' })
  }
  const job = registerJob(newJob(novelId, 'chapter'))
  job.batch = true
  job.modelId = req.body?.modelId
  if (typeof req.body?.linkContext === 'boolean') job.linkContext = req.body.linkContext
  ;(async () => {
    let written = 0
    let failures = 0
    const MAX_BATCH = 200
    let paused = false
    try {
      while (true) {
        if (job.stopRequested) throw new Error('已停止')
        if (written >= MAX_BATCH) {
          job.error = `已连续生成 ${MAX_BATCH} 章，为控制成本自动暂停，可再次点击继续。`
          paused = true
          break
        }
        const cur = getNovel(novelId)
        if (!cur) throw new Error('小说不存在或已被删除，批量生成已停止')
        const chapters = cur.chapters || []
        const total = (cur.outline || []).length
        const next = (() => {
          for (const o of (cur.outline || []).slice().sort((a, b) => a.index - b.index)) {
            const c = chapters.find(x => x.index === o.index)
            if (!c || !c.content?.trim() || c.status === 'draft') return o.index
          }
          return null
        })()
        if (next == null || total === 0) break
        job.chapterIndex = next
        job.stream = ''
        job.reasoning = ''
        job.error = ''
        // 每章开写前复位上一章的阶段/截断/草稿标志：否则某章截断后，
        // 后续成功的章节仍带着旧的 truncated/savedDraft，前端误报「被截断」
        job.stage = ''
        job.stageNote = ''
        job.brief = null
        job.review = null
        job.revised = false
        job.truncated = false
        job.savedDraft = false
        job.finishReason = ''
        try {
          await runChapterJob(job)
          written++
          failures = 0
        } catch (e) {
          if (job.stopRequested) throw e
          failures++
          job.error = `第 ${next} 章失败（第 ${failures} 次）：${e.message || e}`
          if (failures >= 3) throw new Error(`连续 3 章生成失败，已自动暂停。最后一次错误：${e.message || e}`)
          await new Promise(r => setTimeout(r, 2000))
        }
      }
      job.status = 'done'
      job.paused = paused
      job.endedAt = Date.now()
      scheduleCleanup(job)
    } catch (e) {
      job.status = job.stopRequested ? 'stopped' : 'error'
      failJob(job, e)
      job.endedAt = Date.now()
      scheduleCleanup(job)
    }
  })()
  res.status(202).json({ jobId: job.id })
})

// 启动：批量精修（选中多个章节，依次续写/润色/修改/降AI）
app.post('/api/generate/batch-refine', (req, res) => {
  const novelId = req.body?.novelId
  const novel = getNovel(novelId)
  if (!novel) return res.status(404).json({ error: '小说不存在' })
  const mode =
    req.body?.mode === 'polish'
      ? 'polish'
      : req.body?.mode === 'revise'
        ? 'revise'
        : req.body?.mode === 'deai'
          ? 'deai'
          : 'continue'
  const indices = Array.isArray(req.body?.chapterIndices)
    ? [...new Set(req.body.chapterIndices.map(Number).filter(n => Number.isSafeInteger(n) && n > 0))]
    : []
  if (!indices.length) return res.status(400).json({ error: '请选择要精修的章节' })
  if (mode === 'revise' && !String(req.body?.extraPrompt || '').trim())
    return res.status(400).json({ error: '修改模式需要描述问题' })
  const extraPrompt = String(req.body?.extraPrompt || '').trim()

  if (hasRunningSameKind(novelId, 'chapter', mode)) {
    return res.status(409).json({ error: '已有同类精修任务在本作品后台运行，请等待完成或先停笔' })
  }
  const job = registerJob(newJob(novelId, 'chapter'))
  job.batch = true
  job.previewOnly = req.body?.previewOnly === true
  job.proposals = []
  job.kind = mode
  job.chapterIndices = indices
  job.extraPrompt = extraPrompt
  job.chapterIndex = indices[0]
  job.modelId = req.body?.modelId
  ;(async () => {
    let failures = 0
    try {
      for (const idx of indices) {
        if (job.stopRequested) throw new Error('已停止')
        job.chapterIndex = idx
        job.stream = ''
        job.reasoning = ''
        job.error = ''
        try {
          await runChapterJob(job)
          failures = 0
        } catch (e) {
          if (job.stopRequested) throw e
          failures++
          job.error = `第 ${idx} 章${mode === 'polish' ? '润色' : mode === 'revise' ? '修改' : mode === 'deai' ? '降AI' : '续写'}失败（第 ${failures} 次）：${e.message || e}`
          if (failures >= 3) throw new Error(`连续 3 次失败，已暂停。最后错误：${e.message || e}`)
          await new Promise(r => setTimeout(r, 2000))
        }
      }
      job.status = 'done'
      job.endedAt = Date.now()
      scheduleCleanup(job)
    } catch (e) {
      job.status = job.stopRequested ? 'stopped' : 'error'
      failJob(job, e)
      job.endedAt = Date.now()
      scheduleCleanup(job)
    }
  })()
  res.status(202).json({ jobId: job.id })
})

// 采纳是独立操作：只认任务生成时的正文版本，已有改动时返回冲突。
app.post('/api/jobs/:id/proposals/:proposalId/accept', async (req, res) => {
  const job = jobs.get(req.params.id)
  const proposal = job?.proposals?.find(p => p.id === req.params.proposalId)
  if (!proposal || !job.previewOnly) return res.status(404).json({ error: '建议已过期或不存在' })
  if (job.status === 'running') return res.status(409).json({ error: '请等待审校结束后再采纳' })
  if (proposal.status === 'accepted') return res.json({ ok: true })
  const saved = await updateNovel(job.novelId, novel => {
    const chapter = novel.chapters.find(c => (proposal.oid ? c.oid === proposal.oid : c.index === proposal.index))
    if (!chapter || chapter.content !== proposal.original || chapter.title !== proposal.title) {
      const error = new Error('原稿已变化，未覆盖你的修改。请以最新原稿重新审校。')
      error.status = 409
      throw error
    }
    pushHistory(novel, '采纳 AI 审校建议前')
    chapter.content = proposal.content
    chapter.words = countTextUnits(proposal.content)
    chapter.status = 'done'
    chapter.context = {
      ...(chapter.context || {}),
      ...buildChapterContext(novel, chapter.index, proposal.content, 'manual')
    }
    return novel
  })
  if (!saved) return res.status(404).json({ error: '作品不存在' })
  proposal.status = 'accepted'
  res.json({ ok: true })
})

// AI 痕迹检测：选中章节，逐章分析 AI 味并输出报告
app.post('/api/ai/detect', (req, res) => {
  const novelId = req.body?.novelId
  const novel = getNovel(novelId)
  if (!novel) return res.status(404).json({ error: '小说不存在' })
  const indices = Array.isArray(req.body?.chapterIndices)
    ? [...new Set(req.body.chapterIndices.map(Number).filter(n => Number.isSafeInteger(n) && n > 0))]
    : []
  if (!indices.length) return res.status(400).json({ error: '请选择要检测的章节' })
  startJobRoute(res, () => ({
    ...newJob(novelId, 'detect'),
    chapterIndices: indices,
    chapterIndex: indices[0],
    modelId: req.body?.modelId
  }))
})

// 灵感：AI 读前文+总纲+大纲，给出剧情灵感
app.post('/api/ai/inspire', (req, res) => {
  const novelId = req.body?.novelId
  const novel = getNovel(novelId)
  if (!novel) return res.status(404).json({ error: '小说不存在' })
  startJobRoute(res, () => ({ ...newJob(novelId, 'inspire'), modelId: req.body?.modelId }))
})

// ---------- 全书一致性检查：AI 通读全部设定与已写正文，找出前后矛盾/设定冲突 ----------
app.post('/api/ai/consistency', (req, res) => {
  const novelId = req.body?.novelId
  const novel = getNovel(novelId)
  if (!novel) return res.status(404).json({ error: '小说不存在' })
  startJobRoute(res, () => ({ ...newJob(novelId, 'consistency'), modelId: req.body?.modelId }))
})

// ---------- 诊断信息 ----------
// 排查「一对话就报 AI 接口错误」这类上游问题的入口：
// 给出当前生效的模型（名称/地址/协议）与最近的失败日志。
// 安全约束：只读且**绝不返回 apiKey**——密钥不入日志、不出接口。
app.get('/api/diagnostics', (req, res) => {
  const models = listModels()
  const def = models.find(m => m.isDefault) || null
  const novelId = String(req.query.novelId || '')
  const novel = novelId ? getNovel(novelId) : null
  const wantId = novel?.modelId || ''
  const picked = (wantId && models.find(m => m.id === wantId)) || def || null
  const brief = m => (m ? { name: m.name, model: m.model, baseUrl: m.baseUrl, provider: m.provider || 'openai' } : null)
  let errors = []
  try {
    const p = path.join(LOGS_DIR, 'app.log')
    if (fs.existsSync(p)) {
      errors = fs
        .readFileSync(p, 'utf8')
        .split('\n')
        .filter(l => l.includes('[job:error]'))
        .slice(-40)
    }
  } catch {
    /* 读取失败不影响诊断 */
  }
  res.json({
    dataDir: DATA_DIR,
    modelCount: models.length,
    hasKey: !!picked?.apiKey,
    defaultModel: brief(def),
    novelModel: brief(picked),
    novelModelSource: wantId ? (novel.modelId === picked?.id ? 'book' : 'fallback') : 'default',
    recentErrors: errors
  })
})

// ---------- 创作研讨（独立线程，与正文/大纲生成互不阻塞） ----------
// 作者可一边生成章节一边与 AI 对话：讨论剧情走向、爽点、节奏、改稿思路。
// 对话按书持久化到 data/chats/<novelId>.json，支持多会话（多线索）并行；
// 同一本书同时只允许一个研讨任务在跑。

// 会话列表（仅元信息，不含消息体）
function chatRouteError(res, e) {
  const status = Number(e?.status)
  if (status === 400 || status === 404 || status === 409)
    return res.status(status).json({ error: String(e.message || e) })
  console.error('[chat]', e)
  return res.status(500).json({ error: '对话历史读取失败，请检查本地数据文件是否可读' })
}

app.get('/api/novels/:id/chat', (req, res) => {
  try {
    const store = readChatStore(req.params.id)
    res.json({ activeId: store.activeId, sessions: store.sessions.map(sessionMeta) })
  } catch (e) {
    chatRouteError(res, e)
  }
})

// 新建会话
app.post('/api/novels/:id/chat', async (req, res) => {
  try {
    const session = await createChatSession(req.params.id, req.body?.title)
    res.status(201).json({ session, activeId: session.id })
  } catch (e) {
    chatRouteError(res, e)
  }
})

// 读取某个会话的完整消息
app.get('/api/novels/:id/chat/:sid', (req, res) => {
  try {
    const store = readChatStore(req.params.id)
    const s = findSession(store, req.params.sid)
    if (!s) return res.status(404).json({ error: '会话不存在' })
    res.json({
      session: { id: s.id, title: s.title, createdAt: s.createdAt, updatedAt: s.updatedAt, messages: s.messages }
    })
  } catch (e) {
    chatRouteError(res, e)
  }
})

// 重命名会话
app.patch('/api/novels/:id/chat/:sid', async (req, res) => {
  try {
    const title = String(req.body?.title || '').trim()
    if (!title) return res.status(400).json({ error: '标题不能为空' })
    let found = false
    const saved = await updateChatStore(req.params.id, store => {
      const s = findSession(store, req.params.sid)
      if (!s) return false
      s.title = title.slice(0, 60)
      s.updatedAt = Date.now()
      found = true
    })
    if (!found) return res.status(404).json({ error: '会话不存在' })
    res.json({ ok: true, session: sessionMeta(findSession(saved, req.params.sid)) })
  } catch (e) {
    chatRouteError(res, e)
  }
})

// 删除单个会话
app.delete('/api/novels/:id/chat/:sid', async (req, res) => {
  try {
    let found = false
    const saved = await updateChatStore(req.params.id, store => {
      const before = store.sessions.length
      store.sessions = store.sessions.filter(s => s.id !== req.params.sid)
      found = store.sessions.length !== before
      if (!found) return false
      if (store.activeId === req.params.sid) store.activeId = store.sessions[0]?.id || ''
    })
    if (!found) return res.status(404).json({ error: '会话不存在' })
    res.json({ ok: true, activeId: saved.activeId, sessions: saved.sessions.map(sessionMeta) })
  } catch (e) {
    chatRouteError(res, e)
  }
})

// 清空该书全部会话
app.delete('/api/novels/:id/chat', async (req, res) => {
  try {
    // 清空 = 覆写为空存储，而不是删除文件。
    // 注意：writeJson 会留一份 .bak，readJson 在主文件缺失时会回退到 .bak——
    // 若此处只 unlink 主文件，下次读取会从 .bak 把旧会话「复活」。
    await updateChatStore(req.params.id, store => {
      store.sessions = []
      store.activeId = ''
    })
    // 同步清掉可能残留的 .bak，避免任何回退路径读到已清空的会话
    try {
      const bak = chatFile(req.params.id) + '.bak'
      if (fs.existsSync(bak)) fs.unlinkSync(bak)
    } catch {
      /* 备份清理失败不影响清空结果 */
    }
    res.json({ ok: true, activeId: '', sessions: [] })
  } catch (e) {
    chatRouteError(res, e)
  }
})

// 管家动作的权限分级已收口到 server/agent/tools.mjs 的 TOOLS 表（ACTION_TIERS 由它派生）。
// 新增一种动作只需在注册表里加一条，分级 / 形态提示 / 交叉校验测试会一并跟上。

// 管家动作落库：把动作应用到小说字段，并返回每个动作的结果。
// 每条结果含 status（applied 已应用 / started 已启动任务 / rejected 被拒 / failed 执行失败）、
// reason（拒绝或失败原因）、tier（权限级别）、before（旧值快照，供撤销）。
// opts：{ spawnJob, models, allowDangerous }
export function applyChatActions(novel, actionsInput, opts = {}) {
  const actions = Array.isArray(actionsInput) ? actionsInput : actionsInput.actions || []
  const skillNames = Array.isArray(actionsInput) ? [] : actionsInput.skillNames || [] // [{id,name}]
  const modelList = Array.isArray(opts.models) ? opts.models : []
  const allowDangerous = opts.allowDangerous === true
  const spawn = typeof opts.spawnJob === 'function' ? opts.spawnJob : null
  const applied = []
  // 文本整体替换类：before/after 直接存字符串
  const TEXT_FIELD = {
    synopsis: '简介',
    title: '书名',
    genre: '类型',
    worldview: '世界观',
    masterOutline: '总纲',
    styleProfile: '风格档案'
  }
  // 追加类：合并到原字符串末尾（动作名 → 落库字段；提示词与撤销都读复数字段）
  const APPEND_FIELD = {
    element: { field: 'elements', label: '剧情元素' },
    extraRequirement: { field: 'extraRequirements', label: '额外要求' }
  }
  // 数值类：转合法数字后写入
  const NUMERIC_FIELD = { chapterCount: '章节数', targetWords: '每章目标字数' }
  // 需解析 text 为 JSON 的人物/剧情线/进度
  const safe = (fn, dflt) => {
    try {
      return fn()
    } catch {
      return dflt
    }
  }
  // 解析人物/剧情线 JSON；text 不是合法 JSON 时，兜底用动作顶层的扁平字段（模型常见输出）
  const OBJ_KEYS = ['name', 'role', 'personality', 'appearance', 'background', 'notes']
  const parseObj = (a, raw, keys = OBJ_KEYS) => {
    const o = safe(() => JSON.parse(raw), null)
    if (o && typeof o === 'object') return o
    const out = {}
    for (const k of keys) {
      if (a[k] != null && a[k] !== '') out[k] = typeof a[k] === 'object' ? JSON.stringify(a[k]) : String(a[k])
    }
    return Object.keys(out).length ? out : null
  }
  // 解析章号列表：支持动作自带 chapterIndices、JSON 数组、以及 "5" / "5,6,7" / "5、6" 文本
  const parseIndices = (a, raw) => {
    if (Array.isArray(a.chapterIndices))
      return [...new Set(a.chapterIndices.map(Number).filter(n => Number.isSafeInteger(n) && n > 0))]
    const s = String(raw || '').trim()
    if (!s) return []
    const arr = safe(() => JSON.parse(s), null)
    if (Array.isArray(arr)) return [...new Set(arr.map(Number).filter(n => n > 0))]
    return [
      ...new Set(
        s
          .split(/[,，、\s]+/)
          .map(Number)
          .filter(n => n > 0)
      )
    ]
  }
  // 解析布尔：支持 true/false、1/0、开/关、启用/停用等写法
  const asBool = v => {
    const s = String(v ?? '')
      .trim()
      .toLowerCase()
    if (['1', 'true', 'on', 'yes', '开', '是', '启用', '开启', '打开'].includes(s)) return true
    if (['0', 'false', 'off', 'no', '关', '否', '停用', '关闭', '禁用'].includes(s)) return false
    return null
  }

  for (const a of actions) {
    const raw = String(a.text ?? '').trim()
    const idx = Number(a.chapter ?? a.chapterIndex) || 0
    const tier = ACTION_TIERS[a.type] || 'unknown'
    const meta = { type: a.type, chapter: idx, text: raw, before: '', tier }
    // push = 已应用；reject = 被拒（附原因）；fail = 执行异常（附原因）；start = 已启动后台任务
    const push = e => applied.push({ ...meta, status: 'applied', ...e })
    const reject = (reason, e = {}) => applied.push({ ...meta, status: 'rejected', reason, ...e })
    const fail = e =>
      applied.push({ ...meta, status: 'failed', reason: String(e?.message || e), label: `执行失败：${a.type}` })
    const start = e => applied.push({ ...meta, status: 'started', ...e })
    if (tier === 'unknown') {
      reject(`不支持的动作类型「${a.type}」`, { label: `未知动作：${a.type}` })
      continue
    }
    if (tier === 'danger' && !allowDangerous) {
      reject('危险操作未授权：请在输入框下方勾选「允许危险操作」后再让管家执行', { label: `未授权：${a.type}` })
      continue
    }
    // 联网检索由 /api/chat 在「应用动作」之前执行（检索结果要回喂给模型）。
    // 这里保留一条只读记录：既让动作目录测试有落点，也避免误走后面的写库分支。
    if (a.type === 'webSearch' || a.type === 'fetchPage') {
      push({
        label: a.type === 'webSearch' ? `检索：${raw.slice(0, 60)}` : `读取网页：${raw.slice(0, 80)}`,
        noUndo: true
      })
      continue
    }
    try {
      if (a.type === 'createNovel') {
        reject('创建新书需要在创作管家首页使用「创建新书」入口，并由作者确认后执行')
        continue
      }
      if (TEXT_FIELD[a.type]) {
        const key = a.type
        const before = String(novel[key] || '')
        if (!raw) {
          reject(`「${TEXT_FIELD[key]}」的内容为空，没有可写入的文本`)
        } else if (raw === before) {
          reject(`「${TEXT_FIELD[key]}」与当前内容一致，无需修改`)
        } else {
          novel[key] = raw
          push({ type: key, chapter: 0, text: raw, before, label: `修改${TEXT_FIELD[key]}` })
        }
        continue
      }
      if (APPEND_FIELD[a.type]) {
        const { field, label } = APPEND_FIELD[a.type]
        const before = String(novel[field] || '')
        if (!raw) {
          reject(`「${label}」的内容为空，没有可追加的文本`)
          continue
        }
        novel[field] = before ? (before.endsWith('\n') ? before + raw : before + '\n' + raw) : raw
        push({ type: a.type, chapter: 0, text: raw, before, label: `追加${label}` })
        continue
      }
      if (NUMERIC_FIELD[a.type]) {
        const key = a.type
        const before = novel[key]
        const rawNum = raw || (a.value != null ? String(a.value) : a.count != null ? String(a.count) : '')
        const n = safe(() => Math.floor(Number(rawNum)), NaN)
        if (!Number.isFinite(n) || n <= 0) {
          reject(`「${NUMERIC_FIELD[key]}」需要一个大于 0 的数字，收到「${rawNum || '（空）'}」`)
        } else if (n === before) {
          reject(`「${NUMERIC_FIELD[key]}」已经是 ${n}，无需修改`)
        } else {
          // 计划章节数不设上限（它是规模参考，由作者自己定）
          if (key === 'chapterCount') novel.chapterCount = n
          else novel.targetWords = n
          push({
            type: key,
            chapter: 0,
            text: String(novel[key]),
            before,
            label: `调整${NUMERIC_FIELD[key]} → ${novel[key]}`
          })
        }
        continue
      }
      if (a.type === 'protagonist') {
        const obj = parseObj(a, raw)
        if (!obj) {
          reject('主角设定需要 JSON，如 {"name":"沈砚","personality":"…"}')
          continue
        }
        const before = { ...novel.protagonist }
        // 人物照片只由作者上传，模型给的 portrait 一律不认
        delete obj.portrait
        novel.protagonist = { ...newChar(), ...before, ...obj }
        push({
          type: 'protagonist',
          chapter: 0,
          text: JSON.stringify(novel.protagonist),
          before: JSON.stringify(before),
          label: '更新主角'
        })
        continue
      }
      if (a.type === 'addCharacter' || a.type === 'updateCharacter') {
        const obj = parseObj(a, raw)
        if (!obj) continue
        const name = String(obj.name || a.name || '').trim()
        if (!name) {
          reject('人物设定缺少 name 字段')
          continue
        }
        delete obj.portrait
        if (a.type === 'addCharacter') {
          const rest = (novel.characters || []).filter(c => String(c.name || '').trim() !== name)
          // 同名重建时保留作者上传过的照片
          const prior = (novel.characters || []).find(c => String(c.name || '').trim() === name)
          const item = { ...newChar(), ...(prior?.portrait ? { portrait: prior.portrait } : {}), ...obj }
          novel.characters = [...rest, item]
          push({
            type: 'updateCharacter',
            chapter: 0,
            text: JSON.stringify(item),
            before: JSON.stringify({ _removed: true, name }),
            label: `新增角色「${name}」`
          })
        } else {
          const target = (novel.characters || []).find(c => String(c.name || '').trim() === name)
          if (!target) {
            reject(`没有找到人物「${name}」（updateCharacter 只能改已有角色，新增请用 addCharacter）`)
            continue
          }
          const before = JSON.stringify({ ...target })
          Object.assign(target, obj)
          push({
            type: 'updateCharacter',
            chapter: 0,
            text: JSON.stringify(obj),
            before,
            name,
            label: `更新角色「${name}」`
          })
        }
        continue
      }
      if (a.type === 'addPlotline') {
        const obj =
          safe(() => JSON.parse(raw), null) || parseObj(a, raw, ['name', 'type', 'goal', 'description', 'status'])
        if (!obj || !String(obj.name || '').trim()) {
          reject('新增剧情线需要 JSON 且必须含 name，如 {"name":"主线","type":"主线","goal":"…"}')
          continue
        }
        const rest = (novel.plotlines || []).filter(l => String(l.name || '').trim() !== String(obj.name).trim())
        const item = {
          name: String(obj.name).trim(),
          type: obj.type || '剧情线',
          goal: obj.goal || '',
          description: obj.description || '',
          status: 'active',
          beats: []
        }
        novel.plotlines = [...rest, item]
        push({
          type: 'addPlotline',
          chapter: 0,
          text: JSON.stringify(item),
          before: JSON.stringify({ _removed: true, name: item.name }),
          name: item.name,
          label: `新增剧情线「${item.name}」`
        })
        continue
      }
      if (a.type === 'plotlineStatus') {
        const obj = safe(() => JSON.parse(raw), null) || parseObj(a, raw, ['name', 'status'])
        if (!obj) {
          reject('剧情线状态需要 JSON，如 {"name":"主线","status":"paused"}')
          continue
        }
        const list = (novel.plotlines || []).filter(l => String(l.name || '').trim() !== String(obj.name || '').trim())
        const target = (novel.plotlines || []).find(l => String(l.name || '').trim() === String(obj.name || '').trim())
        if (!target) {
          reject(`没有找到剧情线「${obj.name || ''}」`)
          continue
        }
        const before = JSON.stringify({ ...target })
        const st = ['active', 'paused', 'done', 'pending'].includes(obj.status) ? obj.status : target.status
        novel.plotlines = [...list, { ...target, status: st }]
        push({
          type: 'plotlineStatus',
          chapter: 0,
          text: JSON.stringify({ name: target.name, status: st }),
          before,
          name: target.name,
          label: `剧情线「${target.name}」→ ${st}`
        })
        continue
      }
      if (
        a.type === 'applyStyle' ||
        a.type === 'applyTemplate' ||
        a.type === 'applySkill' ||
        a.type === 'removeSkill'
      ) {
        const name = raw
        if (!name) {
          reject('套用预置需要提供预置的精确名称（请核对预置清单）')
          continue
        }
        if (a.type === 'applyStyle') {
          const hit = AUTHOR_STYLES.find(s => s.name === name) || customStyles.list().find(s => s.name === name)
          if (!hit) {
            reject(`文风「${name}」不存在（请核对预置清单）`, { label: `套用文风「${name}」` })
            continue
          }
          const before = novel.authorStyleId || ''
          novel.authorStyleId = hit.id
          push({ type: 'applyStyle', chapter: 0, text: name, before, label: `套用文风「${name}」` })
        } else if (a.type === 'applyTemplate') {
          const hit = PROMPT_TEMPLATES.find(t => t.name === name) || customTemplates.list().find(t => t.name === name)
          if (!hit) {
            reject(`模板「${name}」不存在（请核对预置清单）`, { label: `套用模板「${name}」` })
            continue
          }
          const before = novel.templateId || ''
          novel.templateId = hit.id
          push({ type: 'applyTemplate', chapter: 0, text: name, before, label: `套用模板「${name}」` })
        } else {
          const cur = Array.isArray(novel.skillIds) ? novel.skillIds : []
          const shouldAdd = a.type === 'applySkill'
          const label = shouldAdd ? `启用技能「${name}」` : `停用技能「${name}」`
          const before = JSON.stringify(cur)
          const named = (Array.isArray(skillNames) ? skillNames : []).find(ss => ss.name === name)
          const sid = named ? named.id : name
          const set = new Set(cur)
          if (shouldAdd && !set.has(sid)) {
            set.add(sid)
            novel.skillIds = [...set]
          }
          if (!shouldAdd) novel.skillIds = cur.filter(x => x !== sid)
          push({ type: shouldAdd ? 'applySkill' : 'removeSkill', chapter: 0, text: name, before, label })
        }
        continue
      }
      // 章节类（chapterPrompt / outlineSummary / outlineTitle）
      if (a.type === 'chapterPrompt' || a.type === 'outlineSummary' || a.type === 'outlineTitle') {
        if (!raw) {
          reject('内容为空，没有可写入的文本')
          continue
        }
        if (!idx) {
          reject('请指定章号')
          continue
        }
        const o = (novel.outline || []).find(x => x.index === idx)
        if (!o) {
          reject(`没有找到第 ${idx} 章的大纲`)
          continue
        }
        if (a.type === 'chapterPrompt') {
          const before = o.customPrompt || ''
          if (raw === before) {
            reject(`第${idx}章的本章指令与当前一致，无需修改`)
          } else {
            o.customPrompt = raw
            push({ type: 'chapterPrompt', chapter: idx, text: raw, before, label: `第${idx}章 · 本章指令` })
          }
        } else if (a.type === 'outlineSummary') {
          const before = o.summary || ''
          if (raw === before) {
            reject(`第${idx}章的大纲摘要与当前一致，无需修改`)
          } else {
            o.summary = raw
            push({ type: 'outlineSummary', chapter: idx, text: raw, before, label: `第${idx}章 · 大纲摘要` })
          }
        } else {
          const before = o.title || ''
          if (raw === before) {
            reject(`第${idx}章的标题与当前一致，无需修改`)
          } else {
            o.title = raw
            const ch = (novel.chapters || []).find(c => c.index === idx)
            if (ch && ch.title === before) ch.title = raw
            push({ type: 'outlineTitle', chapter: idx, text: raw, before, label: `第${idx}章 · 章节标题` })
          }
        }
        continue
      }
      if (a.type === 'removeCharacter') {
        const name = String(a.name || raw || '').trim()
        const target = (novel.characters || []).find(c => String(c.name || '').trim() === name)
        if (!target) {
          reject(`没有找到角色「${name}」`, { label: `删除角色「${name}」` })
          continue
        }
        novel.characters = (novel.characters || []).filter(c => c !== target)
        push({
          type: 'removeCharacter',
          text: JSON.stringify(target),
          before: JSON.stringify(target),
          name,
          label: `删除角色「${name}」`
        })
        continue
      }
      if (a.type === 'removePlotline') {
        const obj = safe(() => JSON.parse(raw), null)
        const name = String(obj?.name || a.name || raw || '').trim()
        const target = (novel.plotlines || []).find(l => String(l.name || '').trim() === name)
        if (!target) {
          reject(`没有找到剧情线「${name}」`, { label: `删除剧情线「${name}」` })
          continue
        }
        novel.plotlines = (novel.plotlines || []).filter(l => l !== target)
        push({
          type: 'removePlotline',
          text: JSON.stringify(target),
          before: JSON.stringify(target),
          name,
          label: `删除剧情线「${name}」`
        })
        continue
      }
      if (a.type === 'addPlotBeat') {
        const obj =
          safe(() => JSON.parse(raw), null) || parseObj(a, raw, ['plotline', 'name', 'title', 'summary', 'chapter'])
        if (!obj) {
          reject('剧情节点需要 JSON，如 {"plotline":"主线","title":"节点名","summary":"...","chapter":5}')
          continue
        }
        const pname = String(obj.plotline || obj.line || obj.plotlineName || '').trim()
        const target = (novel.plotlines || []).find(l => String(l.name || '').trim() === pname)
        if (!target) {
          reject(`没有找到剧情线「${pname}」`, { label: '新增剧情节点' })
          continue
        }
        const beat = {
          id: crypto.randomUUID(),
          title: String(obj.title || obj.name || '').trim(),
          summary: String(obj.summary || ''),
          chapter: Number(obj.chapter) || 0
        }
        if (!beat.title) {
          reject('剧情节点缺少标题')
          continue
        }
        target.beats = [...(target.beats || []), beat]
        push({
          type: 'addPlotBeat',
          text: JSON.stringify({ plotline: pname, ...beat }),
          before: JSON.stringify({ _removed: true, plotline: pname, beatId: beat.id }),
          name: pname,
          label: `剧情线「${pname}」新增节点「${beat.title}」`
        })
        continue
      }
      if (a.type === 'addOutline') {
        const obj = safe(() => JSON.parse(raw), null) || { title: raw, summary: String(a.summary || '') }
        const title = String(obj.title || obj.name || '').trim()
        const summary = String(obj.summary || obj.desc || '').trim()
        if (!title && !summary) {
          reject('新增大纲缺少标题或摘要')
          continue
        }
        const list = novel.outline || []
        const index = Math.max(0, ...list.map(o => o.index || 0)) + 1
        const item = { index, title: title || `第${index}章`, summary, customPrompt: '', oid: crypto.randomUUID() }
        novel.outline = [...list, item].sort((x, y) => x.index - y.index)
        push({
          type: 'addOutline',
          chapter: index,
          text: JSON.stringify({ title: item.title, summary }),
          before: JSON.stringify({ _removed: true, oid: item.oid }),
          label: `新增大纲 第${index}章《${item.title}》`
        })
        continue
      }
      if (a.type === 'deleteOutline') {
        if (!idx) {
          reject('请指定要删除的大纲章号')
          continue
        }
        const target = (novel.outline || []).find(o => o.index === idx)
        if (!target) {
          reject(`没有找到第 ${idx} 章大纲`, { label: `删除大纲 第${idx}章` })
          continue
        }
        novel.outline = (novel.outline || []).filter(o => o !== target)
        push({
          type: 'deleteOutline',
          chapter: idx,
          text: JSON.stringify(target),
          before: JSON.stringify(target),
          label: `删除大纲 第${idx}章《${target.title}》`
        })
        continue
      }
      if (a.type === 'pov') {
        const low = raw.toLowerCase()
        const v = /first|第一/.test(low) ? 'first' : /third|第三/.test(low) ? 'third' : null
        if (!v) {
          reject('视角只能是「第一人称」或「第三人称」')
          continue
        }
        const before = novel.pov || 'third'
        if (v === before) {
          reject('视角没有变化')
          continue
        }
        novel.pov = v
        push({ type: 'pov', text: v, before, label: `视角 → ${v === 'first' ? '第一人称' : '第三人称'}` })
        continue
      }
      if (a.type === 'linkContext' || a.type === 'mobileReading') {
        const v = asBool(raw)
        if (v === null) {
          reject('需要一个布尔值（开 / 关）')
          continue
        }
        const before = !!novel[a.type]
        if (v === before) {
          reject('设置没有变化')
          continue
        }
        novel[a.type] = v
        push({
          type: a.type,
          text: String(v),
          before: String(before),
          label: `${a.type === 'linkContext' ? '关联前文' : '手机阅读优化'} → ${v ? '开' : '关'}`
        })
        continue
      }
      if (a.type === 'model') {
        const key = String(raw || a.modelId || '').trim()
        const hit = modelList.find(m => m.id === key) || modelList.find(m => String(m.name || '').trim() === key)
        if (!hit) {
          reject(`没有找到模型「${key}」（请到模型设置核对名称）`, { label: `切换模型「${key}」` })
          continue
        }
        const before = novel.modelId || ''
        if (hit.id === before) {
          reject('本书已经在使用该模型')
          continue
        }
        novel.modelId = hit.id
        push({ type: 'model', text: hit.name || hit.id, before, label: `本书模型 → 「${hit.name || hit.id}」` })
        continue
      }
      if (a.type === 'chapterContent' || a.type === 'appendChapter') {
        if (!idx) {
          reject('请指定章号')
          continue
        }
        if (!raw) {
          reject('正文内容为空')
          continue
        }
        const existing = (novel.chapters || []).find(c => c.index === idx)
        const before = existing?.content || ''
        const o = (novel.outline || []).find(x => x.index === idx)
        const content = a.type === 'appendChapter' ? (before ? `${before.replace(/\s+$/, '')}\n\n${raw}` : raw) : raw
        const chapters = (novel.chapters || []).filter(c => c.index !== idx)
        chapters.push({
          index: idx,
          title: existing?.title || o?.title || `第${idx}章`,
          content,
          words: countTextUnits(content),
          status: 'done',
          oid: existing?.oid || o?.oid || '',
          // 必须重建连续性快照：summary / endingHook 会被「全书章节速览」和后续续写引用。
          // 此前漏掉，导致管家写出的章节在速览里没有摘要、也接不上前文状态。
          // source=generated：AI 产出的正文（作者手改后会变成 manual）。
          context: { ...(existing?.context || {}), ...buildChapterContext(novel, idx, content, 'generated') }
        })
        novel.chapters = chapters.sort((x, y) => x.index - y.index)
        push({
          type: a.type,
          chapter: idx,
          text: `第${idx}章正文（${countTextUnits(content)} 字）`,
          before,
          label: `${a.type === 'appendChapter' ? '追加' : '写入'} 第${idx}章正文`
        })
        continue
      }
      // 正文段落级编辑（段号从 1 开始，段 = 按空行/连续换行划分的自然段落）：
      //   editParagraph    改写某段或连续几段：text 为 JSON {"start","count"?,"replacement"}
      //   insertParagraph  在第 start 段之前插入：text 为 JSON {"start","replacement"}
      //   deleteParagraph  删除某段或几段：text 为 JSON {"start","count"?} 或 "5" / "5,6,7"
      if (a.type === 'editParagraph' || a.type === 'insertParagraph' || a.type === 'deleteParagraph') {
        if (!idx) {
          reject('请指定章号')
          continue
        }
        const ch = (novel.chapters || []).find(c => c.index === idx)
        if (!ch || !String(ch.content || '').trim()) {
          reject(`没有第 ${idx} 章正文`, { label: `段落编辑 第${idx}章` })
          continue
        }
        const paras = String(ch.content || '')
          .replace(/\r\n/g, '\n')
          .split(/\n+/)
          .map(s => s.trim())
          .filter(Boolean)
        const originalParas = [...paras] // 撤销快照：任意顺序撤销段落动作都准确
        // deleteParagraph 承诺过 "5" / "5,6,7" 这类纯文本格式（注册表 summary）：
        // 先归一成 JSON 再走统一解析，否则数字被当「非对象」拒掉、逗号串解析失败落到第 0 段
        let effRaw = raw
        if (a.type === 'deleteParagraph' && /^\s*\d+(?:\s*[,，]\s*\d+)*\s*$/.test(raw)) {
          const nums = [...new Set(raw.split(/[,，]/).map(s => Number(s.trim())))]
            .filter(n => n > 0)
            .sort((x, y) => x - y)
          if (nums.length) {
            const contiguous = nums.every((n, i) => i === 0 || n === nums[i - 1] + 1)
            effRaw = JSON.stringify(contiguous ? { start: nums[0], count: nums.length } : { list: nums })
          }
        }
        const obj = safe(() => JSON.parse(effRaw), null)
        if (obj !== null && (typeof obj !== 'object' || Array.isArray(obj))) {
          reject('段落的 text 需为 JSON，含 start / count / replacement 字段')
          continue
        }
        const arg = obj || {}
        const start = Number(arg.start ?? a.start ?? a.paragraph ?? 0) | 0
        const replacement = String(arg.replacement ?? a.replacement ?? '')
        const countOf = v => Math.max(1, Math.floor(Number(v) || 1))
        const rangeLabel = (s, n) => (n > 1 ? `${s}~${s + n - 1}段` : `${s}段`)
        if (a.type === 'editParagraph') {
          if (start < 1 || start > paras.length) {
            reject(`第 ${idx} 章段落范围为 1~${paras.length}，没有第 ${start || 0} 段`, { label: `改写 第${idx}章` })
            continue
          }
          const count = arg.count === 0 || arg.count === '0' ? 0 : countOf(arg.count ?? a.count ?? 1)
          if (count > 0 && start + count - 1 > paras.length) {
            reject(`第 ${idx} 章只有 ${paras.length} 段，无法改写第 ${rangeLabel(start, count)}`, {
              label: `改写 第${idx}章`
            })
            continue
          }
          if (!replacement.trim()) {
            reject('改写内容为空', { label: `改写 第${idx}章 ${rangeLabel(start, count)}` })
            continue
          }
          const newParas = replacement
            .split(/\n+/)
            .map(s => s.trim())
            .filter(Boolean)
          const removed = count === 0 ? paras.slice(start - 1) : paras.slice(start - 1, start - 1 + count)
          paras.splice(start - 1, count === 0 ? paras.length - start + 1 : count, ...newParas)
          ch.content = paras.join('\n\n')
          ch.words = countTextUnits(ch.content)
          push({
            type: 'editParagraph',
            chapter: idx,
            text: JSON.stringify({ start, count: newParas.length, paras: newParas }),
            before: JSON.stringify({ start, count: removed.length, paras: removed }),
            snapshot: JSON.stringify(originalParas),
            label: `改写 第${idx}章 ${rangeLabel(start, removed.length)}`
          })
          continue
        }
        if (a.type === 'insertParagraph') {
          if (start < 1 || start > paras.length + 1) {
            reject(`插入位置需为 1~${paras.length + 1}（表示插入到第 start 段之前）`)
            continue
          }
          if (!replacement.trim()) {
            reject('插入内容为空', { label: `插入 第${idx}章 第${start}段前` })
            continue
          }
          const newParas = replacement
            .split(/\n+/)
            .map(s => s.trim())
            .filter(Boolean)
          paras.splice(start - 1, 0, ...newParas)
          ch.content = paras.join('\n\n')
          ch.words = countTextUnits(ch.content)
          push({
            type: 'insertParagraph',
            chapter: idx,
            text: JSON.stringify({ start, count: newParas.length, paras: newParas }),
            before: JSON.stringify({ start, count: 0, paras: [] }),
            snapshot: JSON.stringify(originalParas),
            label: `在第${idx}章 第${start}段前插入 ${newParas.length} 段`
          })
          continue
        }
        // deleteParagraph
        // 非连续段号（"5,7,9" 归一出的 list）：倒序逐段删，快照仍存整章原段落
        if (a.type === 'deleteParagraph' && Array.isArray(arg.list)) {
          const wanted = arg.list.map(Number)
          const valid = wanted.filter(n => Number.isSafeInteger(n) && n >= 1 && n <= paras.length)
          if (valid.length !== wanted.length || !valid.length) {
            reject(`第 ${idx} 章段落范围为 1~${paras.length}，段号列表里有无效项`, { label: `删除 第${idx}章` })
            continue
          }
          if (valid.length >= paras.length) pushHistory(novel, `管家删空第${idx}章前`)
          const removedP = []
          for (const n of [...valid].sort((x, y) => y - x)) removedP.unshift(...paras.splice(n - 1, 1))
          ch.content = paras.join('\n\n')
          ch.words = countTextUnits(ch.content)
          push({
            type: 'deleteParagraph',
            chapter: idx,
            text: JSON.stringify({ start: 0, count: 0, paras: [] }),
            before: JSON.stringify({ start: 0, count: removedP.length, paras: removedP }),
            snapshot: JSON.stringify(originalParas),
            label: `删除 第${idx}章 第${valid.join('、')}段`
          })
          continue
        }
        if (start < 1 || start > paras.length) {
          reject(`第 ${idx} 章段落范围为 1~${paras.length}，没有第 ${start || 0} 段`, { label: `删除 第${idx}章` })
          continue
        }
        const count =
          arg.count === 0 || arg.count === '0' ? paras.length - start + 1 : countOf(arg.count ?? a.count ?? 1)
        if (start + count - 1 > paras.length) {
          reject(`第 ${idx} 章只有 ${paras.length} 段，无法删除第 ${rangeLabel(start, count)}`, {
            label: `删除 第${idx}章`
          })
          continue
        }
        // 整章删空是破坏性结果：edit 级动作也留历史快照，不依赖动作撤销兜底
        if (start === 1 && count >= paras.length) pushHistory(novel, `管家删空第${idx}章前`)
        const removedP = paras.splice(start - 1, count)
        ch.content = paras.join('\n\n')
        ch.words = countTextUnits(ch.content)
        push({
          type: 'deleteParagraph',
          chapter: idx,
          text: JSON.stringify({ start, count: 0, paras: [] }),
          before: JSON.stringify({ start, count: removedP.length, paras: removedP }),
          snapshot: JSON.stringify(originalParas),
          label: `删除 第${idx}章 ${rangeLabel(start, removedP.length)}`
        })
        continue
      }
      if (a.type === 'addMaterial') {
        const obj = safe(() => JSON.parse(raw), null) || { title: String(a.title || ''), content: raw, tags: a.tags }
        const title = String(obj.title || '').trim() || raw.slice(0, 20) || '管家素材'
        const items = readShelf()
        items.push({
          id: crypto.randomUUID(),
          title,
          content: String(obj.content || raw),
          kind: obj.kind === 'draft' ? 'draft' : 'material',
          tags: Array.isArray(obj.tags) ? obj.tags.map(String).filter(Boolean).slice(0, 20) : [],
          createdAt: Date.now(),
          updatedAt: Date.now()
        })
        saveShelf(items)
        push({ type: 'addMaterial', text: title, before: '', label: `存入素材库「${title}」` })
        continue
      }
      // ---- 触发后台任务（execute 级） ----
      if (tier === 'execute') {
        // 这五个动作已下线（提示词明令禁止输出）：后端也必须拒绝执行，
        // 否则模型不守规矩时仍能触发整书连写，白白烧掉大量 token
        if (['generateMaster', 'generateOutline', 'rewriteOutline', 'writeChapter', 'generateAll'].includes(a.type)) {
          reject('该动作已下线：请到对应页面手动发起，或直接让我把正文写出来')
          continue
        }
        if (!spawn) {
          reject('生成功能当前不可用（服务端未就绪）')
          continue
        }
        const spec = (() => {
          switch (a.type) {
            case 'generateMaster':
              return { type: 'master', label: '开始生成总纲' }
            case 'generateOutline': {
              const o = safe(() => JSON.parse(raw), null) || {}
              const count = Math.min(Math.max(Math.floor(Number(o.count ?? raw ?? 6)) || 6, 1), 30)
              const mode = o.mode === 'replace' ? 'replace' : 'append'
              return {
                type: 'outline',
                count,
                mode,
                isFinal: !!o.isFinal,
                label: `开始${mode === 'replace' ? '重排' : '续排'} ${count} 章大纲`
              }
            }
            case 'rewriteOutline': {
              const inds = parseIndices(a, raw)
              if (!inds.length) throw new Error('请指定要重写的大纲章号')
              return {
                type: 'outline',
                mode: 'rewrite',
                chapterIndices: inds,
                chapterIndex: inds[0],
                label: `重写大纲 第 ${inds.join('、')} 章`
              }
            }
            case 'writeChapter': {
              if (!idx) throw new Error('请指定要写的章号')
              return { type: 'chapter', chapterIndex: idx, kind: 'write', label: `开始写 第${idx}章` }
            }
            case 'generateAll':
              return { type: 'chapter', batch: true, label: '开始连续生成剩余章节' }
            case 'continueChapter': {
              if (!idx) throw new Error('请指定章号')
              return {
                type: 'chapter',
                chapterIndex: idx,
                kind: 'continue',
                extraPrompt: raw,
                label: `续写 第${idx}章`
              }
            }
            case 'polishChapter': {
              if (!idx) throw new Error('请指定章号')
              return { type: 'chapter', chapterIndex: idx, kind: 'polish', extraPrompt: raw, label: `润色 第${idx}章` }
            }
            case 'reviseChapter': {
              if (!idx) throw new Error('请指定章号')
              return { type: 'chapter', chapterIndex: idx, kind: 'revise', extraPrompt: raw, label: `修改 第${idx}章` }
            }
            case 'deaiChapter': {
              if (!idx) throw new Error('请指定章号')
              return { type: 'chapter', chapterIndex: idx, kind: 'deai', extraPrompt: raw, label: `降AI 第${idx}章` }
            }
            case 'detectAI': {
              const inds = parseIndices(a, raw)
              if (!inds.length) throw new Error('请指定要检测的章号')
              return {
                type: 'detect',
                chapterIndices: inds,
                chapterIndex: inds[0],
                label: `检测 AI 痕迹 第 ${inds.join('、')} 章`
              }
            }
            case 'inspire':
              return { type: 'inspire', label: '开始灵感启发' }
            case 'consistencyCheck':
              return { type: 'consistency', label: '开始全书一致性检查' }
            default:
              throw new Error('未实现的生成动作')
          }
        })()
        let job
        try {
          job = spawn({ ...newJob(novel.id, spec.type), ...spec, modelId: a.modelId || undefined })
        } catch (e) {
          reject(String(e?.message || e), { label: spec.label })
          continue
        }
        start({
          type: a.type,
          chapter: spec.chapterIndex || 0,
          text: '',
          before: '',
          label: spec.label,
          jobId: job.id,
          jobType: spec.type,
          jobKind: spec.kind || 'write'
        })
        continue
      }
      if (a.type === 'deleteNovel') {
        push({
          type: 'deleteNovel',
          chapter: 0,
          text: '',
          before: JSON.stringify({ id: novel.id, title: novel.title || '' }),
          label: '移入回收站'
        })
        continue
      }
      if (a.type === 'deleteChapter') {
        if (!idx) {
          reject('请指定要删除的章号')
          continue
        }
        const target = (novel.chapters || []).find(c => c.index === idx)
        if (!target) {
          reject(`没有第 ${idx} 章正文`, { label: `删除 第${idx}章` })
          continue
        }
        pushHistory(novel, `管家删除第${idx}章前`)
        const removed = removeChapterFromNovel(novel, idx)
        push({
          type: 'deleteChapter',
          chapter: idx,
          text: `第${idx}章正文`,
          before: JSON.stringify({ chapter: removed.chapter, outline: removed.outline }),
          label: `删除 第${idx}章正文及对应大纲`
        })
        continue
      }
      if (a.type === 'clearChapters') {
        if (!(novel.chapters || []).length) {
          reject('当前没有可清空的正文')
          continue
        }
        // 清空全部正文是不可逆度最高的一类动作：先进版本历史，
        // 消息里的 before 只是短期撤销手段，会被 400 条消息上限挤掉
        pushHistory(novel, '管家清空全部正文前')
        push({
          type: 'clearChapters',
          text: '清空全部正文',
          before: JSON.stringify(novel.chapters || []),
          label: '清空全部章节正文'
        })
        novel.chapters = []
        continue
      }
      if (a.type === 'navigate') {
        push({ type: 'navigate', chapter: 0, text: raw, before: '', label: `前往「${raw}」页` })
        continue
      }
      reject(`动作「${a.type}」暂未实现`)
    } catch (e) {
      fail(e)
    }
  }
  return applied
}

// 撤销管家动作：根据旧值快照反向恢复；deleteNovel 例外（恢复书）用回收站接口
export function undoChatAction(novel, a) {
  if (!a) return { ok: false, error: '动作不合法' }
  const before = String(a.before)
  const idx = Number(a.chapter) || 0
  const safe = (fn, dflt) => {
    try {
      return fn()
    } catch {
      return dflt
    }
  }
  try {
    if (a.type === 'masterOutline') novel.masterOutline = before
    else if (a.type === 'styleProfile') novel.styleProfile = before
    else if (a.type === 'synopsis') novel.synopsis = before
    else if (a.type === 'title') novel.title = before
    else if (a.type === 'genre') novel.genre = before
    else if (a.type === 'worldview') novel.worldview = before
    else if (a.type === 'element') novel.elements = before
    else if (a.type === 'extraRequirement') novel.extraRequirements = before
    else if (a.type === 'chapterCount' || a.type === 'targetWords') {
      const n = Number(before)
      if (Number.isFinite(n) && n > 0) novel[a.type] = n
      else if (!before) novel[a.type] = ''
    } else if (a.type === 'protagonist') {
      const obj = safe(() => JSON.parse(before || '{}'), {})
      if (Object.keys(obj).length) novel.protagonist = obj
    } else if (a.type === 'addCharacter' || a.type === 'updateCharacter') {
      const obj = safe(() => JSON.parse(before || '{}'), {})
      if (obj._removed) {
        const nm = obj.name || a.name
        novel.characters = (novel.characters || []).filter(c => String(c.name || '').trim() !== nm)
      } else {
        const nm = obj.name || a.name
        const rest = (novel.characters || []).filter(c => String(c.name || '').trim() !== nm)
        novel.characters = [...rest, obj]
      }
    } else if (a.type === 'addPlotline') {
      const obj = safe(() => JSON.parse(before || '{}'), {})
      const nm = obj?.name || a.name
      novel.plotlines = (novel.plotlines || []).filter(l => String(l.name || '').trim() !== nm)
    } else if (a.type === 'plotlineStatus') {
      const prev = safe(() => JSON.parse(before || '{}'), {})
      const nm = prev?.name || a.name
      const rest = (novel.plotlines || []).filter(l => String(l.name || '').trim() !== nm)
      novel.plotlines = [...rest, prev].filter(Boolean)
    } else if (a.type === 'applyStyle') novel.authorStyleId = before
    else if (a.type === 'applyTemplate') novel.templateId = before
    else if (a.type === 'applySkill' || a.type === 'removeSkill')
      novel.skillIds = safe(() => JSON.parse(before || '[]'), [])
    else if (a.type === 'chapterPrompt' || a.type === 'outlineSummary' || a.type === 'outlineTitle') {
      const o = (novel.outline || []).find(x => x.index === idx)
      if (!o) return { ok: false, error: '找不到对应章节' }
      if (a.type === 'outlineTitle') o.title = before
      else if (a.type === 'chapterPrompt') o.customPrompt = before
      else o.summary = before
    } else if (a.type === 'removeCharacter') {
      const obj = safe(() => JSON.parse(before || '{}'), {})
      const nm = String(obj.name || a.name || '').trim()
      if (nm && !(novel.characters || []).some(c => String(c.name || '').trim() === nm)) {
        novel.characters = [...(novel.characters || []), obj]
      }
    } else if (a.type === 'removePlotline') {
      const obj = safe(() => JSON.parse(before || '{}'), {})
      const nm = String(obj.name || a.name || '').trim()
      if (nm && !(novel.plotlines || []).some(l => String(l.name || '').trim() === nm)) {
        novel.plotlines = [...(novel.plotlines || []), obj]
      }
    } else if (a.type === 'addPlotBeat') {
      const info = safe(() => JSON.parse(before || '{}'), {})
      const target = (novel.plotlines || []).find(
        l => String(l.name || '').trim() === String(info.plotline || '').trim()
      )
      if (target) target.beats = (target.beats || []).filter(b => b.id !== info.beatId)
    } else if (a.type === 'addOutline') {
      const info = safe(() => JSON.parse(before || '{}'), {})
      novel.outline = (novel.outline || []).filter(o => o.oid !== info.oid)
    } else if (a.type === 'deleteOutline') {
      const obj = safe(() => JSON.parse(before || '{}'), {})
      if (obj && obj.index) {
        const rest = (novel.outline || []).filter(o => o.index !== obj.index)
        novel.outline = [...rest, obj].sort((x, y) => x.index - y.index)
      }
    } else if (a.type === 'pov') {
      novel.pov = before === 'first' ? 'first' : 'third'
    } else if (a.type === 'linkContext' || a.type === 'mobileReading') {
      novel[a.type] = before === 'true'
    } else if (a.type === 'model') {
      novel.modelId = before
    } else if (a.type === 'chapterContent' || a.type === 'appendChapter') {
      if (!idx) return { ok: false, error: '找不到对应章节' }
      const chapters = (novel.chapters || []).filter(c => c.index !== idx)
      if (before) {
        const existing = (novel.chapters || []).find(c => c.index === idx)
        const o = (novel.outline || []).find(x => x.index === idx)
        chapters.push({
          index: idx,
          title: existing?.title || o?.title || `第${idx}章`,
          content: before,
          words: countTextUnits(before),
          status: 'done',
          oid: existing?.oid || o?.oid || ''
        })
      }
      novel.chapters = chapters.sort((x, y) => x.index - y.index)
    } else if (a.type === 'deleteChapter') {
      const info = safe(() => JSON.parse(before || '{}'), {})
      const chapter = info?.chapter || (info?.content ? info : null)
      const outline = info?.outline || null
      if (!chapter || !Number.isSafeInteger(Number(chapter.index))) return { ok: false, error: '删除信息缺失' }
      const originalIndex = Number(chapter.index)
      const shift = arr => (arr || []).map(x => (x.index >= originalIndex ? { ...x, index: x.index + 1 } : x))
      const chapters = shift(novel.chapters)
      chapters.push({ ...chapter, index: originalIndex })
      novel.chapters = chapters.sort((x, y) => x.index - y.index)
      if (outline) {
        const outlines = shift(novel.outline)
        outlines.push({ ...outline, index: originalIndex })
        novel.outline = outlines.sort((x, y) => x.index - y.index)
      }
    } else if (a.type === 'clearChapters') {
      const arr = safe(() => JSON.parse(before || '[]'), [])
      if (Array.isArray(arr)) novel.chapters = arr.sort((x, y) => x.index - y.index)
    } else if (a.type === 'editParagraph' || a.type === 'insertParagraph' || a.type === 'deleteParagraph') {
      if (!idx) return { ok: false, error: '找不到对应章节' }
      const ch = (novel.chapters || []).find(c => c.index === idx)
      if (!ch) return { ok: false, error: '找不到对应章节' }
      // 优先用整章快照：任意顺序撤销段落动作都准确
      if (a.snapshot) {
        const snap = JSON.parse(String(a.snapshot))
        if (Array.isArray(snap)) {
          ch.content = snap.join('\n\n')
          ch.words = countTextUnits(ch.content)
          return { ok: true }
        }
      }
      // 兜底：按「当前段落置回 before 记录的原文」恢复（兼容旧版动作）
      const beforeObj = safe(() => JSON.parse(before || '{}'), {})
      const afterObj = JSON.parse(String(a.text || '{}'))
      if (!(beforeObj && typeof beforeObj === 'object' && Array.isArray(beforeObj.paras)))
        return { ok: false, error: '撤销信息缺失' }
      if (!(afterObj && typeof afterObj === 'object' && Array.isArray(afterObj.paras)))
        return { ok: false, error: '撤销信息缺失' }
      const paras = String(ch.content || '')
        .replace(/\r\n/g, '\n')
        .split(/\n+/)
        .map(s => s.trim())
        .filter(Boolean)
      const st = Number(beforeObj.start) || 1
      paras.splice(st - 1, afterObj.paras.length, ...beforeObj.paras)
      ch.content = paras.join('\n\n')
      ch.words = countTextUnits(ch.content)
    } else if (a.type === 'addMaterial') {
      // 素材写入跨书素材库，撤销请到「素材与草稿」手动删除
    } else if (a.type === 'navigate' || a.type === 'deleteNovel') {
      // 界面/删书动作不在此撤销（删书请用回收站恢复）
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e.message || e) }
  }
}

// 发送研讨消息：回复在后台流式生成（job.type='chat'），期间其他生成任务照常运行
// ---------- 管家自愈回环 ----------
// 参考 coding agent（OpenCode / Claude Code 一类）的「工具调用 → 结果回喂」范式：
// 模型给出的动作若被拒（JSON 不合法、章号超界、缺必填字段…），把拒因原样回喂一次，
// 让它在同一轮对话里自己改正，而不是把一句「动作未执行」直接甩给作者。
//
// 两条硬约束：
//   1. 只重试 MAX_REPAIR_ROUNDS 次，防止模型反复产出坏动作把任务拖死；
//   2. 只在确有被拒 / 失败动作时触发 —— 成功路径的行为与之前完全一致。
const MAX_REPAIR_ROUNDS = 1

/** 把被拒 / 失败的动作整理成给模型看的回执清单；没有坏动作时返回空串 */
function renderActionRejections(applied) {
  const bad = (applied || []).filter(a => a.status === 'rejected' || a.status === 'failed')
  if (!bad.length) return ''
  return bad
    .map(a => {
      // 附上该动作对 text 形态的要求：模型十次失败里有八次是 text 给错了形态
      const hint = actionHint(a.type)
      return `- ${a.type}${a.chapter > 0 ? `（第 ${a.chapter} 章）` : ''}：${a.reason || '未执行'}${hint ? ` ${hint}` : ''}`
    })
    .join('\n')
}

// ---------- 联网检索回合 ----------
// 模型输出 webSearch / fetchPage 时，服务端先真的去查，再把来源回喂给模型重写回答。
// 只做一轮，避免一次对话把等待时间拖到不可用；单轮请求数、去重与截断由 research.mjs 负责。
const MAX_RESEARCH_ROUNDS = 1

app.post('/api/chat', async (req, res) => {
  const novelId = req.body?.novelId
  const novel = getNovel(novelId)
  if (!novel) return res.status(404).json({ error: '小说不存在' })
  const message = String(req.body?.message || '').trim()
  if (!message) return res.status(400).json({ error: '请输入内容' })
  // 研讨内部同类互斥；与 write/outline 等其他类型任务互不影响
  if (hasRunningSameKind(novelId, 'chat', 'write')) {
    return res.status(409).json({ error: '上一条回复还在生成中，可先停止或稍候再发' })
  }
  const conn = resolveConn(req.body?.modelId || novel.modelId)
  if (!conn) return res.status(400).json({ error: '请先在模型设置中选择有效模型，并确认模型名称与地址正确' })
  // 管家权限：applyActions=允许代改与执行（edit+execute）；allowDangerous=允许破坏性操作（danger）
  const applyActions = !!req.body?.applyActions
  const allowDangerous = applyActions && !!req.body?.allowDangerous

  // 把可用的预置名称注入管家提示词，使其能准确输出 applyStyle/applyTemplate/applySkill 动作
  const skillNames = allSkills().map(s => ({ id: s.id, name: s.name }))
  const styleNames = [...AUTHOR_STYLES.map(s => s.name), ...customStyles.list().map(s => s.name)]
  const templateNames = [...PROMPT_TEMPLATES.map(t => t.name), ...customTemplates.list().map(t => t.name)]
  const modelList = listModels().map(m => ({ id: m.id, name: m.name }))
  // 知识库检索：用作者这句话当查询，从全部知识库捞相关块（前端可关）。
  // 刻意放在读会话之前：检索是纯本地计算，失败了也不该阻塞对话。
  const kbHits = req.body?.useKb === false ? [] : searchKb(String(message || ''), { topK: 6, budget: 1600 }).hits
  // 素材库：原先只写不读 —— 这里把最近的素材带进管家上下文，它才真的「被用到」
  const materials = readShelf()
    .filter(i => i.kind === 'material' && String(i.content || '').trim())
    .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0))
    .slice(0, 8)

  // 会话：优先用前端传来的 sessionId；没有活跃会话时自动新建一个。
  // 存储读写错误必须在这里转成明确的 500，不能让 Express 4 把 async rejection 吞掉，
  // 否则前端只会看到「请求失败」或长时间等待，误以为历史功能消失。
  let store
  let session
  try {
    store = readChatStore(novelId)
    session = findSession(store, req.body?.sessionId)
    if (!session) {
      session = await createChatSession(novelId, deriveSessionTitle([{ role: 'user', content: message }]))
      store = readChatStore(novelId)
    }
  } catch (e) {
    return chatRouteError(res, e)
  }
  const sid = session.id

  const history = session.messages
  // 附件：文本类由前端直接内联进正文；这里只处理图片（读盘转 data:URL 交给多模态消息）
  const rawAtts = Array.isArray(req.body?.attachments) ? req.body.attachments : []
  const attachments = []
  const images = []
  for (const a of rawAtts.slice(0, ATTACH_LIMIT)) {
    if (!a || a.kind !== 'image') continue
    const file = String(a.file || '')
    if (!ATTACH_FILE_RE.test(file)) continue
    const p = path.join(ATTACHMENTS_DIR, file)
    const mime = ATTACH_MIME_BY_EXT[path.extname(file).slice(1).toLowerCase()]
    if (!mime) continue
    // 图片可达数 MB×N：同步 readFileSync 会卡住整个事件循环（所有在跑的流式任务一起顿一下）
    let buf
    try {
      buf = await fs.promises.readFile(p)
    } catch {
      continue // 不存在或读失败：跳过这张图，与旧的 existsSync 分支等价
    }
    attachments.push({ kind: 'image', name: String(a.name || file).slice(0, 120), file })
    images.push({
      name: String(a.name || file),
      dataUrl: `data:${mime};base64,${buf.toString('base64')}`
    })
  }

  const nextHistory = [
    ...history,
    { role: 'user', content: message, at: Date.now(), ...(attachments.length ? { attachments } : {}) }
  ]
  // 互斥复查：上面的检查与注册之间隔着若干 await，并发请求可能同时过闸；
  // 注册前再同步查一次，保证同书同类任务真正互斥。
  // 必须先过闸再存消息：409 时若消息已落盘，会留下一条永无回复的孤儿消息
  if (hasRunningSameKind(novelId, 'chat', 'write')) {
    return res.status(409).json({ error: '上一条回复还在生成中，可先停止或稍候再发' })
  }
  const job = registerJob({ ...newJob(novelId, 'chat'), modelId: conn.id })
  job.sessionId = sid
  // 用户消息先行落盘：即使回复失败，对话也不丢；落盘失败要立刻收回任务，不留 running 空壳
  try {
    await saveChat(novelId, nextHistory, sid)
  } catch (e) {
    failJob(job, e)
    job.status = 'error'
    job.endedAt = Date.now()
    scheduleCleanup(job)
    return chatRouteError(res, e)
  }
  // 首轮 / 检索回喂 / 自愈回喂共用同一份提示词上下文，避免三处参数漂移
  const promptOpts = {
    applyActions,
    allowDangerous,
    // 本地模型按 contextTokens 折算预算；云端模型返回 0 → 走默认大预算
    limit: promptLimitFor(conn) || undefined,
    styles: styleNames,
    templates: templateNames,
    skills: skillNames.map(s => s.name),
    models: modelList,
    images,
    materials,
    kbHits
  }
  ;(async () => {
    let full = ''
    // 提到 try 外：停笔 / 出错收尾时要把「已应用动作快照」与「检索来源」一并存进消息，
    // 否则章节被改过却没有撤销入口
    let research = null
    let applied = []
    const finish = status => {
      job.status = status
      job.endedAt = Date.now()
      scheduleCleanup(job)
    }
    try {
      for await (const part of callAI(conn, {
        messages: chatMessages(novel, nextHistory, promptOpts),
        signal: job.ctrl.signal,
        // 管家代改要输出 JSON 动作块，给足输出上限，防止批量加角色时响应被截断
        maxTokens: MAX_TOKENS
      })) {
        if (job.stopRequested) throw new Error('已停止')
        if (part.type === 'reasoning') {
          if (part.restart) job.reasoning = ''
          else job.reasoning += part.text
        } else if (part.type === 'meta') {
          if (part.truncated) job.truncated = true
        } else if (part.type === 'content') {
          full += part.text
          job.stream = full
        }
      }
      let reply = full.trim()
      if (!reply) throw new Error('AI 未返回有效内容，请重试')
      // 解析管家动作块：应用并落库，动作快照（含旧值）挂在 job 与消息上，供前端展示/撤销
      let { actions, reply: cleanReply } = applyActions ? extractChatActions(reply) : { actions: [], reply }

      // 联网检索回合：模型发出 webSearch / fetchPage 时，先真的去查，把来源回喂给它重写回答。
      // 检索本身不改书稿；只做一轮，最多 3 次搜索 + 2 次读页。
      if (applyActions) {
        for (let round = 0; round < MAX_RESEARCH_ROUNDS; round++) {
          const asks = actions.filter(a => a.type === 'webSearch' || a.type === 'fetchPage')
          if (!asks.length) break
          const found = await collectResearch(asks, { signal: job.ctrl.signal })
          if (job.stopRequested) throw new Error('已停止')
          research = mergeResearch(research, found)
          const followHistory = [
            ...nextHistory,
            { role: 'assistant', content: cleanReply || reply },
            {
              role: 'user',
              content:
                formatResearchContext(research) +
                '\n\n以上是你刚才请求的联网检索结果。请基于这些真实来源重新回答：' +
                '引用外部事实时用 [1][2] 标注来源序号；来源之间冲突时指出冲突并说明取舍；' +
                '没有查到就如实说明，绝不编造。如果任务需要写正文或改设定，照常输出动作块（不要再输出 webSearch / fetchPage）。'
            }
          ]
          let nextRaw = ''
          job.stream = ''
          try {
            for await (const part of callAI(conn, {
              messages: chatMessages(novel, followHistory, promptOpts),
              signal: job.ctrl.signal,
              maxTokens: MAX_TOKENS
            })) {
              if (job.stopRequested) throw new Error('已停止')
              if (part.type === 'content') {
                nextRaw += part.text
                job.stream = nextRaw
              } else if (part.type === 'meta' && part.truncated) {
                job.truncated = true
              }
            }
          } catch (e) {
            // 停笔沿原路径抛；上游在「整理检索结果」这一步失败时，不能让作者看到裸 JSON 动作块
            if (job.stopRequested) throw e
            appendLog('chat-research', `整理检索结果失败 ${novelId}: ${e.message}`)
            cleanReply = '检索已完成，但整理回答时上游中断。来源已附在下方，可以查看后再让我继续整理。'
            actions = []
            break
          }
          const nextReply = nextRaw.trim()
          if (!nextReply) break
          const parsed = extractChatActions(nextReply)
          // 第二轮是「重写回答」，模型常忘了重发首轮委托的编辑动作；
          // 把首轮未被重发的非检索动作合并回来（按 type+chapter+text 去重），避免静默丢失
          const isResearchAsk = a => a.type === 'webSearch' || a.type === 'fetchPage'
          const carried = actions.filter(
            a =>
              !isResearchAsk(a) &&
              !parsed.actions.some(b => b.type === a.type && b.chapter === a.chapter && b.text === a.text)
          )
          actions = [...parsed.actions, ...carried]
          cleanReply = parsed.reply
          reply = nextReply
          if (!actions.some(isResearchAsk)) break
        }
        // 检索动作本身只用于触发检索，不进入「已应用动作」列表
        actions = actions.filter(a => a.type !== 'webSearch' && a.type !== 'fetchPage')
      }

      // 截断的回复要明确告知，否则用户只看到半句话，不知道是上限问题还是模型没说完
      if (job.truncated) cleanReply += '\n\n（回复达到长度上限被截断——需要后半段的话再发一句「继续」即可。）'
      if (actions.length) {
        try {
          await updateNovel(novelId, fresh => {
            applied = applyChatActions(fresh, { actions, skillNames }, { spawnJob, models: modelList, allowDangerous })
            // 事务内读取最新书稿并应用动作，避免删除/写入与后台生成并发时旧快照覆盖新内容。
            const mutated = applied.some(
              a => a.status === 'applied' && !['navigate', 'addMaterial', 'deleteNovel'].includes(a.type)
            )
            return mutated ? fresh : null
          })
        } catch {
          /* 动作落盘失败不阻塞对话；消息仍会记录实际动作结果 */
        }
      }

      // 自愈回环：把被拒动作的原因回喂一次，让模型自己修正
      for (let round = 0; round < MAX_REPAIR_ROUNDS; round++) {
        const rejections = renderActionRejections(applied)
        if (!rejections) break
        const current = getNovel(novelId) || novel
        const repairHistory = [
          ...nextHistory,
          { role: 'assistant', content: cleanReply || reply },
          {
            role: 'user',
            content:
              '【系统回执】你上面这些动作没有被执行，原因如下：\n' +
              rejections +
              '\n\n请只输出修正后的动作块（不要重复已经执行成功的动作）。本轮是系统纠错回执，豁免「回复正文说明改了哪里」的常规要求：不要输出任何解释性正文。'
          }
        ]
        let fixRaw = ''
        try {
          for await (const part of callAI(conn, {
            messages: chatMessages(current, repairHistory, promptOpts),
            signal: job.ctrl.signal,
            maxTokens: MAX_TOKENS
          })) {
            if (job.stopRequested) throw new Error('已停止')
            if (part.type === 'content') fixRaw += part.text
          }
        } catch (e) {
          // 停笔要沿着原路径向上抛，交给外层统一收尾；其它失败只记日志、放弃修正
          if (job.stopRequested) throw e
          appendLog('chat-repair', `修正调用失败 ${novelId}: ${e.message}`)
          break
        }

        const { actions: fixActions } = extractChatActions(fixRaw.trim())
        if (!fixActions.length) {
          appendLog('chat-repair', `${novelId} 第 ${round + 1} 轮未产出动作，放弃修正`)
          break
        }

        let fixed = []
        try {
          await updateNovel(novelId, freshNovel => {
            fixed = applyChatActions(
              freshNovel,
              { actions: fixActions, skillNames },
              {
                spawnJob,
                models: modelList,
                allowDangerous
              }
            )
            const mutated = fixed.some(
              a => a.status === 'applied' && !['navigate', 'addMaterial', 'deleteNovel'].includes(a.type)
            )
            return mutated ? freshNovel : null
          })
        } catch {
          /* 修正动作落盘失败：不阻塞对话，消息仍记录实际结果 */
        }

        // 修正动作并入同一条消息的动作快照，前端可逐条撤销、语义上属于同一轮交付
        applied = [...applied, ...fixed]
        appendLog(
          'chat-repair',
          `${novelId} 第 ${round + 1} 轮修正：被拒 ${rejections.split('\n').length} 项 → 修正后 applied ${fixed.filter(f => f.status === 'applied').length} 项`
        )
      }

      // 兜底标记：模型偶尔写完正文却忘了输出落库动作块，作者就得再说一句「存进成书」。
      // 这里识别「像是交付了正文、但一个章节写入动作都没有」的回复，打上 needsPersist，
      // 前端据此给出一键「写入成书」入口。
      const wroteChapter = applied.some(
        a =>
          a.status === 'applied' &&
          ['chapterContent', 'appendChapter', 'editParagraph', 'insertParagraph', 'deleteParagraph'].includes(a.type)
      )
      const needsPersist = applyActions && !wroteChapter && looksLikeDeliveredProse(cleanReply || reply)
      const assistantMsg = {
        role: 'assistant',
        content: cleanReply || reply,
        at: Date.now(),
        actions: applied,
        ...(research && research.sources.length ? { research } : {}),
        ...(needsPersist ? { needsPersist: true } : {})
      }
      // 先持久化消息（含动作快照），再执行删书：recycleNovel 会把会话文件一起挪进回收站
      await saveChat(novelId, [...nextHistory, assistantMsg], sid)
      if (actions.length && applied.some(a => a.type === 'deleteNovel' && a.status === 'applied')) {
        const fresh = getNovel(novelId)
        if (fresh) {
          try {
            recycleNovel(fresh.id)
          } catch {
            /* 删书失败不阻塞对话 */
          }
        }
      }
      if (needsPersist) job.needsPersist = true
      job.actions = applied
      finish('done')
    } catch (e) {
      // 收尾保存「作者最后看到的那一轮」：job.stream 可能是检索轮 / 自愈轮前的正文，
      // 只存首轮 full 会丢掉已流式展示的内容；已落库的动作必须带快照，供前端逐条撤销
      const partial = String(job.stream || full || '').trim()
      const cleaned = (extractChatActions(partial).reply || '').trim()
      const hasSnapshot = applied.length > 0 || (research && research.sources.length > 0)
      if (cleaned || hasSnapshot) {
        // 落盘失败不能掩盖原始错误，否则 finish 不执行、job 永久卡 running
        try {
          await saveChat(
            novelId,
            [
              ...nextHistory,
              {
                role: 'assistant',
                content: cleaned,
                at: Date.now(),
                ...(applied.length ? { actions: applied } : {}),
                ...(research && research.sources.length ? { research } : {})
              }
            ],
            sid
          )
        } catch {
          /* 保留原始错误语义 */
        }
      }
      failJob(job, e)
      finish(job.stopRequested ? 'stopped' : 'error')
    }
  })()
  res.status(202).json({ jobId: job.id, sessionId: sid })
})

// 撤销管家动作：根据旧值快照恢复（deleteNovel 撤销：从回收站恢复，需单独路由 /api/recycle/:id/restore）
app.post('/api/novels/:id/chat/undo', async (req, res) => {
  const a = req.body?.action
  if (!a || !a.type) return res.status(400).json({ error: '动作不合法' })
  if (a.type === 'deleteNovel') return res.status(400).json({ error: '删书撤销请用「回收站→恢复」' })
  let result = null
  try {
    result = await updateNovel(req.params.id, novel => {
      const r = undoChatAction(novel, a)
      return r.ok ? novel : null
    })
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) })
  }
  if (!result) {
    const novel = getNovel(req.params.id)
    return res.status(novel ? 400 : 404).json({ error: novel ? '撤销信息缺失或动作已失效' : '小说不存在' })
  }
  res.json({ ok: true })
})

// 一键把一条管家回复的正文写进章节。
// 兜底用：模型偶尔写完正文却忘了输出落库动作块，前端在消息上给出「写入成书」按钮，
// 作者点一下即可，不必再打字要求。
// mode=replace 覆盖整章（新写）/ mode=append 追加到章末（接着写）。
app.post('/api/novels/:id/chat/persist', async (req, res) => {
  const index = Number(req.body?.chapter) || 0
  const text = String(req.body?.text || '').trim()
  const mode = req.body?.mode === 'append' ? 'append' : 'replace'
  if (!index) return res.status(400).json({ error: '请指定章号' })
  if (!text) return res.status(400).json({ error: '内容为空' })

  // 一键落库也走书级事务：管家点击落库时，生成任务可能正在写同一本书，
  // 必须在队列内读取最新章节并只合并目标章，不能用请求开始时的旧整书快照覆盖生成结果。
  const result = await updateNovel(req.params.id, novel => {
    const existing = (novel.chapters || []).find(c => c.index === index)
    const before = existing?.content || ''
    const content = mode === 'append' && before ? `${before.replace(/\s+$/, '')}\n\n${text}` : text
    const o = (novel.outline || []).find(x => x.index === index)
    pushHistory(novel, `管家回复写入第${index}章前`)
    const chapters = (novel.chapters || []).filter(c => c.index !== index)
    chapters.push({
      index,
      title: existing?.title || o?.title || `第${index}章`,
      content,
      words: countTextUnits(content),
      status: 'done',
      oid: existing?.oid || o?.oid || '',
      // 经作者手动点按落库的 AI 正文，仍标 generated，与「作者亲笔」（manual）区分
      context: { ...(existing?.context || {}), ...buildChapterContext(novel, index, content, 'generated') }
    })
    novel.chapters = chapters.sort((a, b) => a.index - b.index)
    return novel
  })
  if (!result) return res.status(404).json({ error: '小说不存在' })
  res.json({ ok: true, chapter: result.chapters.find(c => c.index === index) })
})

// 查询任务（含流式文本进度）
// ?since=<streamLen>,<reasoningLen> 时改为返回增量（见 jobDelta），前端轮询用这条路径。
app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id)
  if (!job) return res.status(404).json({ error: '任务不存在或已过期' })
  const since = req.query.since
  if (typeof since === 'string') {
    const [sl, rl] = since.split(',')
    return res.json(jobDelta(job, { streamLen: sl, reasoningLen: rl }))
  }
  res.json(jobPublic(job))
})

// 任务实时通道（SSE）：约 100ms 推一批增量，正文接近逐字出现。
// 前端优先走这里；连接失败 / 中断时退回上面的 ?since= 轮询。
app.get('/api/jobs/:id/events', (req, res) => {
  const job = jobs.get(req.params.id)
  if (!job) return res.status(404).json({ error: '任务不存在或已过期' })

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  })

  let sLen = Math.max(0, Number(req.query.sl) || 0)
  let rLen = Math.max(0, Number(req.query.rl) || 0)
  let closed = false
  let timer = null

  const send = payload => {
    if (!closed) res.write(`data: ${JSON.stringify(payload)}\n\n`)
  }
  const finish = () => {
    if (closed) return
    closed = true
    if (timer) clearInterval(timer)
    res.end()
  }
  // 首帧只给元信息：正文/思考走增量，避免连接瞬间整包重传
  const meta = jobPublic(job)
  delete meta.stream
  delete meta.reasoning
  send({ meta })

  const tick = () => {
    if (closed) return
    const stream = typeof job.stream === 'string' ? job.stream : ''
    const reasoning = typeof job.reasoning === 'string' ? job.reasoning : ''
    // 任务被重建导致长度回退：清空游标，让前端也从零开始接
    if (stream.length < sLen || reasoning.length < rLen) {
      sLen = 0
      rLen = 0
      send({ reset: true })
    }
    if (stream.length > sLen) {
      send({ stream: stream.slice(sLen) })
      sLen = stream.length
    }
    if (reasoning.length > rLen) {
      send({ reasoning: reasoning.slice(rLen) })
      rLen = reasoning.length
    }
    if (job.status !== 'running') {
      send({ done: true, job: jobPublic(job) })
      finish()
    }
  }

  timer = setInterval(tick, 100)
  timer.unref?.()
  tick()
  req.on('close', finish)
})

// 查询某本书当前任务（返回第一个运行中的）
app.get('/api/novels/:id/job', (req, res) => {
  const job = novelRunningJob(req.params.id)
  res.json(job ? jobPublic(job) : null)
})

// 查询某本书全部运行中任务（支持多任务并行时各页面认领自己的）
app.get('/api/novels/:id/jobs', (req, res) => {
  const list = []
  for (const j of jobs.values()) {
    if (j.novelId === req.params.id && j.status === 'running') list.push(jobPublic(j))
  }
  res.json(list)
})

// 强制停止任务：直接掐断底层请求（思考中无数据块也能立刻停下）
app.post('/api/jobs/:id/stop', (req, res) => {
  const job = jobs.get(req.params.id)
  if (!job) return res.status(404).json({ error: '任务不存在' })
  if (job.status === 'running') {
    job.stopRequested = true
    job.ctrl.abort()
  }
  res.json(jobPublic(job))
})

// 章节标题的形态：第X章/卷/回、Chapter N、序章楔子、【标题】等
const CHAPTER_TITLE_RE =
  /^\s*(?:#{1,6}\s*)?(?:(?:第\s*[0-9一二三四五六七八九十百千万零两]+\s*[章卷回节部集]|Chapter\s*\d+|CHAPTER\s*\d+|序章|楔子|引子|番外[^\n]{0,20})[^\n]{0,40}|[【[]\s*[^\n】\]]{1,40}\s*[】\]])\s*$/

/**
 * 判断一行是不是章节标题。
 *
 * 旧实现只要行里有「第N章」且行不长就当标题，于是正文段落「第二章的第一段。」会被切成
 * 一个新章、原章正文进了空块后被丢弃——作者看到的是「导入 3 章只进来 1 章」。这里补三道闸门：
 * 整行不能出现句读（。！？，；），章号后面不能紧跟虚词，且标题整体要短。
 */
function looksLikeChapterTitle(line) {
  const t = String(line || '').trim()
  if (!t || t.length > 42 || !CHAPTER_TITLE_RE.test(t)) return false
  const bare = t.replace(/^#{1,6}\s*/, '')
  if (/[。！？，；]/.test(bare)) return false
  const marker = /^第\s*[0-9一二三四五六七八九十百千万零两]+\s*[章卷回节部集]/
  if (!marker.test(bare)) return true
  const rest = bare.replace(marker, '').trim()
  // 「第三章里有三个人」这类以章号开头的正文：后面跟虚词，是句子不是标题
  if (rest && /^[的是在有着会要就才时中里上下内外前后与和及把被让给到从对向为]/.test(rest)) return false
  return bare.length <= 30
}

/** 章号已由 index 表达，标题再带一次会显示成「第 1 章 第1章 初雪」 */
function stripChapterMarker(title) {
  const t = String(title || '').trim()
  const m = t.match(/^第\s*[0-9一二三四五六七八九十百千万零两]+\s*([章卷回节部集])(?!分)\s*[：:·.、,，—-]?\s*/)
  return m ? t.slice(m[0].length).trim() : t
}

// 导入小说（txt / md 文本，自动识别章节切分）
app.post('/api/novels/:id/import', async (req, res) => {
  const novel = getNovel(req.params.id)
  if (!novel) return res.status(404).json({ error: '小说不存在' })
  const { text, replace } = req.body || {}
  if (!text || !String(text).trim()) return res.status(400).json({ error: '导入内容为空' })

  const raw = String(text)
    .replace(/\r\n/g, '\n')
    .replace(/^\uFEFF/, '')

  // 章节标题识别：第X章/卷/回、Chapter N、序章楔子等；行长度与句读闸门见 looksLikeChapterTitle

  const raw2 = raw.replace(/\r/g, '')
  const lines = raw2.split('\n')
  const blocks = [] // { title, lines: [] }
  let cur = { title: '', lines: [] }
  for (const line of lines) {
    if (looksLikeChapterTitle(line)) {
      if (cur.title || cur.lines.join('').trim()) blocks.push(cur)
      cur = { title: line.trim().replace(/^#{1,6}\s*/, ''), lines: [] }
    } else {
      cur.lines.push(line)
    }
  }
  if (cur.title || cur.lines.join('').trim()) blocks.push(cur)

  // 无法识别出章节标题时，按每 4000 字切一段
  const merged = blocks.filter(b => b.title || b.lines.join('').trim())
  const titled = merged.filter(b => b.title && b.lines.join('').trim())
  // 只要识别到了章节标题，就保留所有**有正文**的块——包括第一个标题之前的无题片段。
  // 旧实现把无题块直接扔掉，序言/前言/章号没被认出来的开头正文在导入时静默丢失。
  let finalBlocks = titled.length ? merged.filter(b => b.lines.join('').trim()) : []
  if (finalBlocks.length === 0) {
    const body = raw2.trim()
    if (!body) return res.status(400).json({ error: '导入内容为空' })
    const chunkSize = 4000
    const paras = body.split(/\n{2,}/)
    let buf = []
    let count = 0
    const chunks = []
    for (const p of paras) {
      buf.push(p)
      count += p.length
      if (count >= chunkSize) {
        chunks.push(buf.join('\n\n'))
        buf = []
        count = 0
      }
    }
    if (buf.length) chunks.push(buf.join('\n\n'))
    finalBlocks = chunks.map((c, i) => ({ title: `第${i + 1}部分`, lines: c.split('\n') }))
  }

  const imported = finalBlocks.map((b, i) => {
    const content = b.lines.join('\n').trim()
    const rawTitle = String(b.title || '').trim()
    // 标题里的「第1章」和列表/页眉的章号重复，去掉它，显示成「第 1 章 初雪」
    const cleanTitle = stripChapterMarker(rawTitle)
    return {
      index: i + 1,
      title: cleanTitle || rawTitle || `第${i + 1}章`,
      content,
      words: countTextUnits(content),
      status: 'done'
    }
  })

  // 落库走书级事务：导入的「读-改-写」若绕过写队列，恰好撞上章节生成任务
  // 事务的读写间隙时，整批导入章节会被过期整书快照静默覆盖掉
  await updateNovel(req.params.id, n => {
    if ((n.chapters || []).length) pushHistory(n, replace ? '替换导入前' : '追加导入前')

    // 追加时按现有最大章号续编，避免与删除后留下的空洞撞号
    const base = replace
      ? 0
      : Math.max(0, ...(n.chapters || []).map(c => c.index), ...(n.outline || []).map(o => o.index))
    const shifted = imported.map(c => {
      const index = base + c.index
      // 导入的旧书没有章节摘要：立即生成可追踪的估算上下文，避免后续续写只看到正文开头。
      return {
        ...c,
        index,
        oid: crypto.randomUUID(),
        context: {
          summary: `导入章节估算：本章 ${c.words} 字；开头：${
            c.content
              .split(/\n+/)
              .map(s => s.trim())
              .filter(Boolean)[0]
              ?.slice(0, 120) || '（无）'
          }；结尾：${c.content.replace(/\s+/g, ' ').slice(-160)}`,
          characterState: '',
          openThreads: '',
          endingHook: c.content.replace(/\s+/g, ' ').slice(-120),
          source: 'imported-estimate',
          updatedAt: Date.now()
        }
      }
    })

    if (replace) {
      n.chapters = shifted
      n.outline = shifted.map(c => ({ index: c.index, title: c.title, summary: '', customPrompt: '', oid: c.oid }))
    } else {
      n.chapters = [...(n.chapters || []), ...shifted]
      n.outline = [
        ...(n.outline || []),
        ...shifted.map(c => ({ index: c.index, title: c.title, summary: '', customPrompt: '', oid: c.oid }))
      ].sort((a, b) => a.index - b.index)
    }
    // 注意：这里**不要**用大纲条数回写 chapterCount。
    // 计划章节数是作者设定的「全书规模」，导入既有文稿只说明「已经有多少章」，
    // 不代表作者的规划变了；早期版本在这里回写，导致用户设好的数字被悄悄改掉。
    return n
  })
  res.json({ ok: true, chapters: imported.length, words: imported.reduce((s, c) => s + c.words, 0) })
})

// 更新单章（标题 + 正文手工编辑）
// 每日码字统计：{ date: total }，可选 ?novelId= 只看某本书、?days= 回看天数（默认 370）
app.get('/api/stats/daily', (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 370, 1), 3700)
  const novelId = typeof req.query.novelId === 'string' && ID_RE.test(req.query.novelId) ? req.query.novelId : undefined
  res.json({ daily: dailyTotals({ novelId, days }) })
})

// 敏感词 / 过审检测：items: [{ key, label, text }]（本章检测传 1 项，全书检测传每章 1 项）。
// 只做提示不做拦截；命中按出现位置排序，每章最多回 60 条防止响应失控。
app.post('/api/analysis/sensitive', (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items.slice(0, 3000) : []
  if (!items.length) return res.status(400).json({ error: '没有可检测的文本' })
  const { total, byCategory, groups } = detectSensitive(items)
  res.json({
    ok: true,
    total,
    byCategory,
    categoryNames: CATEGORY_NAMES,
    groups: groups.map(g => ({ ...g, hits: g.hits.map(h => ({ ...h, context: h.context.replace(/\n/g, ' ') })) }))
  })
})

// 手写入口独立于 AI：在作品写队列内创建章节，已有规划优先复用。
app.post('/api/novels/:id/chapters', async (req, res) => {
  let created
  const result = await updateNovel(req.params.id, novel => {
    novel.outline ||= []
    novel.chapters ||= []
    const available = novel.outline
      .slice()
      .sort((a, b) => a.index - b.index)
      .find(o => !novel.chapters.some(c => c.oid === o.oid || c.index === o.index))
    const index =
      available?.index || Math.max(0, ...novel.outline.map(o => o.index), ...novel.chapters.map(c => c.index)) + 1
    const title = String(req.body?.title || available?.title || `第 ${index} 章`)
      .trim()
      .slice(0, 200)
    const oid = available?.oid || crypto.randomUUID()
    if (!available) novel.outline.push({ index, title, oid, summary: '', customPrompt: '' })
    created = { index, title, oid, content: '', words: 0, status: 'draft' }
    novel.chapters.push(created)
    novel.chapterCount = Math.max(novel.chapterCount || 0, novel.outline.length)
    return novel
  })
  if (!result) return res.status(404).json({ error: '作品不存在' })
  res.status(201).json({ chapter: created })
})

app.put('/api/novels/:id/chapters/:index', async (req, res) => {
  const idx = Number(req.params.index)
  if (!Number.isSafeInteger(idx) || idx < 1) return res.status(400).json({ error: '章节序号不合法' })
  let wordsDelta = 0
  const result = await updateNovel(req.params.id, novel => {
    const { title, content, oid, expectedContent, expectedTitle } = req.body || {}
    const chapter = (novel.chapters || []).find(c => (oid ? c.oid === oid : c.index === idx))
    if (!chapter) return null
    if (
      (typeof expectedContent === 'string' && chapter.content !== expectedContent) ||
      (typeof expectedTitle === 'string' && chapter.title !== expectedTitle)
    ) {
      const error = new Error('本章已被其他操作更新，草稿已保留。请重新打开章节，核对后再保存。')
      error.status = 409
      throw error
    }
    const contentChanged = typeof content === 'string' && content !== chapter.content
    if (contentChanged) pushHistory(novel, `手动编辑第${idx}章前`)
    if (typeof title === 'string' && title.trim()) {
      chapter.title = title.trim()
      const o = (novel.outline || []).find(x => (chapter.oid ? x.oid === chapter.oid : x.index === chapter.index))
      if (o) o.title = chapter.title
    }
    if (typeof content === 'string') {
      const prevContext = chapter.context || {}
      const prevWords = contentChanged ? countTextUnits(chapter.content || '') : 0
      chapter.content = content
      chapter.words = countTextUnits(content)
      if (contentChanged) wordsDelta = chapter.words - prevWords
      chapter.status = 'done'
      chapter.context = { ...prevContext, ...buildChapterContext(novel, chapter.index, content, 'manual') }
      if (contentChanged) chapter.context.manualEdits = (Number(prevContext.manualEdits) || 0) + 1
    }
    return novel
  })
  if (!result) return res.status(404).json({ error: '小说或章节不存在' })
  // 码字统计只记正增量：删字/回退不冲减，导入与 AI 生成不走这条路由。
  // await 是为了「保存完立刻看日历」读到最新值；统计失败不影响保存本身。
  await recordWords(req.params.id, wordsDelta).catch(() => {})
  res.json({ ok: true, chapter: result.chapters.find(c => (req.body?.oid ? c.oid === req.body.oid : c.index === idx)) })
})

// 删除单章：同时删除对应大纲行，并把后续章节的 index 前移，保证大纲与正文一致。
// 这条规则也由管家 deleteChapter 动作复用，避免两条入口产生不同的书稿状态。
function removeChapterFromNovel(novel, idx) {
  const chapter = (novel.chapters || []).find(c => c.index === idx)
  if (!chapter) return null
  const outline = (novel.outline || []).find(o => o.index === idx) || null
  const renumber = arr =>
    arr
      .slice()
      .sort((a, b) => a.index - b.index)
      .map((x, i) => ({ ...x, index: i + 1 }))
  novel.chapters = renumber((novel.chapters || []).filter(c => c.index !== idx))
  novel.outline = renumber((novel.outline || []).filter(o => o.index !== idx))
  return { chapter, outline }
}

app.delete('/api/novels/:id/chapters/:index', async (req, res) => {
  const idx = Number(req.params.index)
  if (!Number.isSafeInteger(idx) || idx < 1) return res.status(400).json({ error: '章节序号不合法' })
  const result = await updateNovel(req.params.id, novel => {
    if (!(novel.chapters || []).some(c => c.index === idx)) return null
    pushHistory(novel, `删除第${idx}章前`)
    removeChapterFromNovel(novel, idx)
    return novel
  })
  if (!result) {
    const novel = getNovel(req.params.id)
    return res.status(404).json({ error: novel ? '章节不存在' : '小说不存在' })
  }
  res.json({ ok: true })
})

// 一键排版：把整本书或某一章的正文套用标准版式（首行缩进、段间空行、清理多余空白）。
// 与「成书」页的「一键排版」按钮对应：chapterIndex 缺省时对全书生效。
// 整段读-改-写跑在书级事务里，排到一半遇到并发生成也不会互相覆盖。
app.post('/api/novels/:id/typeset', async (req, res) => {
  const only = Number(req.body?.chapterIndex) || 0
  // 缩进用作者设置里的「首行缩进」；一键排版走标准版式，未设置时落到两格
  const settings = readJson(SETTINGS_FILE, {})
  const indent = Number.isFinite(Number(req.body?.indent))
    ? Number(req.body.indent)
    : Number.isFinite(Number(settings.indent))
      ? Number(settings.indent)
      : 2
  let changed = 0
  let total = 0
  let paragraphs = 0
  let missing = false
  const result = await updateNovel(req.params.id, novel => {
    const targets = (novel.chapters || []).filter(c => !only || c.index === only)
    if (!targets.length) {
      missing = true
      return null
    }
    total = targets.length
    const drafts = []
    for (const c of targets) {
      const before = String(c.content || '')
      const after = typesetChapterText(before, indent)
      if (after === before) continue
      drafts.push({ chapter: c, content: after })
    }
    if (!drafts.length) return null
    pushHistory(novel, only ? `一键排版 第${only}章前` : '一键排版全书前')
    for (const { chapter, content } of drafts) {
      chapter.content = content
      chapter.words = countTextUnits(content)
      // 正文只是换了版式，语义没变：保留原 context（作者亲笔标记、摘要与线索都不动），
      // 只把末尾钩子对齐到新的正文结尾。
      if (chapter.context) chapter.context.endingHook = content.replace(/\s+/g, ' ').slice(-160)
      paragraphs += content.split(/\n+/).filter(s => s.trim()).length
      changed++
    }
    return novel
  })
  if (!result) {
    const novel = getNovel(req.params.id)
    if (!novel) return res.status(404).json({ error: '小说不存在' })
    if (missing) return res.status(404).json({ error: `没有第 ${only} 章正文` })
    return res.json({ ok: true, changed: 0, total, paragraphs: 0, indent, unchanged: true })
  }
  res.json({ ok: true, changed, total, paragraphs, indent })
})

// 全书查找替换（人名、设定改动后批量修正）
app.post('/api/novels/:id/replace', async (req, res) => {
  const novel = getNovel(req.params.id)
  if (!novel) return res.status(404).json({ error: '小说不存在' })
  const find = String(req.body?.find || '')
  const to = String(req.body?.replace ?? '')
  const scope = req.body?.scope === 'chapter' ? Number(req.body?.chapterIndex) : 'all'
  const dryRun = !!req.body?.dryRun
  if (!find) return res.status(400).json({ error: '请填写要查找的内容' })

  const targets = (novel.chapters || []).filter(c => scope === 'all' || c.index === scope)
  let count = 0
  const hits = []
  for (const c of targets) {
    const n = (String(c.content || '').match(new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length
    if (n > 0) {
      count += n
      hits.push({ index: c.index, title: c.title, count: n })
    }
  }
  if (dryRun) return res.json({ ok: true, count, hits })

  if (count > 0) {
    const updated = await updateNovel(req.params.id, latest => {
      pushHistory(latest, `全书替换「${find}」前`)
      for (const c of latest.chapters) {
        if (scope !== 'all' && c.index !== scope) continue
        if (!c.content.includes(find)) continue
        const prevContext = c.context || {}
        c.content = c.content.split(find).join(to)
        c.words = countTextUnits(c.content)
        // 机械改名不是作者亲笔：保留原 source / manualEdits / 人物状态 / 线索，
        // 否则「作者亲笔」文风样本（按 source=manual 或 manualEdits>0 挑选）会被机器文本污染。
        // 只把摘要与章末钩子对齐到替换后的正文
        const rebuilt = buildChapterContext(latest, c.index, c.content, prevContext.source || 'generated')
        c.context = {
          ...prevContext,
          summary: rebuilt.summary,
          endingHook: rebuilt.endingHook,
          updatedAt: Date.now()
        }
      }
      return latest
    })
    if (!updated) return res.status(404).json({ error: '小说不存在' })
  }
  res.json({ ok: true, count, hits })
})

// 写作统计
app.get('/api/novels/:id/stats', (req, res) => {
  const novel = getNovel(req.params.id)
  if (!novel) return res.status(404).json({ error: '小说不存在' })
  const chapters = (novel.chapters || []).filter(c => c.content?.trim())
  const words = chapters.reduce((s, c) => s + c.words, 0)
  const total = (novel.outline || []).length
  const target = novel.targetWords || 0
  // 每章字数 vs 目标的偏差清单：超过上限或不足下限视为异常（波动告警）
  const THRESH = 0.3 // 目标 ±30% 内视为正常
  const deviations =
    target > 0
      ? chapters
          .map(c => {
            const dev = Math.round(((c.words - target) / target) * 100)
            if (Math.abs(dev) > THRESH * 100) {
              return { index: c.index, title: c.title || '', words: c.words, target, deviation: dev }
            }
            return null
          })
          .filter(Boolean)
      : []
  res.json({
    chapters: chapters.length,
    drafts: chapters.filter(c => c.status === 'draft').length,
    outlineCount: total,
    words,
    avgWords: chapters.length ? Math.round(words / chapters.length) : 0,
    targetWords: target,
    deviations, // 字数偏离目标的章节
    progress: total ? Math.round((chapters.length / total) * 100) : 0,
    longest: chapters.reduce((m, c) => (c.words > (m?.words || 0) ? c : m), null),
    updatedAt: novel.updatedAt
  })
})

// 一键备份：打包全部数据为 JSON（含版本历史、研讨对话，不含模型密钥）
app.get('/api/backup', (_req, res) => {
  const payload = buildBackupPayload()
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader(
    'Content-Disposition',
    `attachment; filename*=UTF-8''${encodeURIComponent(`小说工坊备份_${new Date().toISOString().slice(0, 10)}.json`)}`
  )
  res.send(JSON.stringify(payload, null, 2))
})

// 还原备份（body 上限已在全局中间件里按路径放宽到 1gb，见文件开头的 jsonRestore）
app.post('/api/backup/restore', (req, res) => {
  if (pendingFileWriteCount() || [...jobs.values()].some(job => job.status === 'running'))
    return res.status(409).json({ error: '当前仍有保存或 AI 任务运行，请等待完成后恢复备份。' })
  const data = req.body
  if (!data || !Array.isArray(data.novels)) return res.status(400).json({ error: '备份文件格式不正确' })
  // 整批预检先于任何正式写入：损坏的后续作品不得留下半次恢复。
  const ids = new Set()
  try {
    // 同一 ID 出现多次时沿用旧行为「后者覆盖前者」，但两份都要通过校验
    const deduped = new Map()
    for (const novel of data.novels) deduped.set(novel?.id, novel)
    for (const novel of deduped.values()) {
      if (!novel || typeof novel.id !== 'string' || !ID_RE.test(novel.id)) throw new Error('作品 ID 缺失或不合法')
      ids.add(novel.id)
      for (const key of ['outline', 'chapters']) {
        if (
          novel[key] !== undefined &&
          (!Array.isArray(novel[key]) || novel[key].some(row => !row || typeof row !== 'object' || Array.isArray(row)))
        )
          throw new Error('作品的 ' + key + ' 结构不正确')
      }
      normalizeNovel(structuredClone(novel))
    }
    for (const key of ['histories', 'historyBlobs', 'chats']) {
      if (data[key] !== undefined && (!data[key] || typeof data[key] !== 'object' || Array.isArray(data[key])))
        throw new Error(key + ' 结构不正确')
      for (const [id, value] of Object.entries(data[key] || {})) {
        if (!ID_RE.test(id)) throw new Error(key + ' 中的作品 ID 不合法')
        // 作品已不在备份里（曾被删除但历史/对话残留）时跳过，与旧行为一致，不因此拒绝整份备份
        if (!ids.has(id)) continue
        if (key === 'histories' && !Array.isArray(value)) throw new Error('历史列表不正确')
        if (key === 'chats' && !Array.isArray(value) && !Array.isArray(value?.sessions))
          throw new Error('对话结构不正确')
        if (
          key === 'historyBlobs' &&
          (!value ||
            typeof value !== 'object' ||
            Array.isArray(value) ||
            Object.entries(value).some(([hash, text]) => !/^[a-f0-9]{32}$/.test(hash) || typeof text !== 'string'))
        )
          throw new Error('历史正文块不正确')
      }
    }
    for (const key of ['customStyles', 'customTemplates', 'customSkills'])
      if (data[key] !== undefined && !Array.isArray(data[key])) throw new Error(key + ' 应为列表')
    for (const key of ['shelf', 'prefs', 'dailyStats'])
      if (data[key] !== undefined && (!data[key] || typeof data[key] !== 'object' || Array.isArray(data[key])))
        throw new Error(key + ' 结构不正确')
    for (const skill of data.customSkills || [])
      if (
        !skill ||
        !ID_RE.test(String(skill.id || '')) ||
        !String(skill.name || '').trim() ||
        !String(skill.content || '').trim()
      )
        throw new Error('自定义技能字段不完整')
  } catch (error) {
    return res.status(400).json({ error: '备份预检失败，现有作品未修改：' + error.message })
  }
  // 按 ID 合并恢复：先用当前状态生成一份「恢复前快照」，失败就停止执行——
  // 旧备份盖掉新工作却没有退路，是全书级别丢数据的最大入口
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true })
    writeJson(path.join(BACKUP_DIR, 'pre_restore.json'), buildBackupPayload())
  } catch (e) {
    return res.status(500).json({ error: `无法生成恢复前快照，已取消恢复：${e.message}` })
  }
  // 文件级回滚点包含写前副本、历史正文块和技能原件；错误时恢复整个受影响集合。
  const checkpoint = path.join(BACKUP_DIR, 'restore-checkpoint-' + crypto.randomUUID())
  const targets = [
    NOVELS_DIR,
    HISTORY_DIR,
    CHATS_DIR,
    path.join(DATA_DIR, 'skills'),
    path.join(DATA_DIR, 'custom_styles.json'),
    path.join(DATA_DIR, 'custom_templates.json'),
    SHELF_FILE,
    SETTINGS_FILE,
    STATS_FILE,
    STATION_NAMES_FILE
  ]
  const existed = targets.map(target => fs.existsSync(target))
  try {
    fs.mkdirSync(checkpoint, { recursive: true })
    targets.forEach((target, i) => {
      if (existed[i]) fs.cpSync(target, path.join(checkpoint, String(i)), { recursive: true })
    })
  } catch (error) {
    return res.status(500).json({ error: '建立恢复回滚点失败，作品未修改：' + error.message })
  }
  let restored = 0
  try {
    for (const n of data.novels) {
      if (!n?.id || !ID_RE.test(n.id)) continue
      writeJson(novelFile(n.id), normalizeNovel(n))
      restored++
    }
    // 还原版本历史与研讨对话（旧备份无对应字段则跳过）
    if (data.histories && typeof data.histories === 'object') {
      for (const [nid, list] of Object.entries(data.histories)) {
        // 任一写入失败都要冒泡到外层回滚点：恢复不能停在半途
        if (ID_RE.test(nid) && Array.isArray(list)) writeJson(historyFile(nid), list)
      }
    }
    if (data.historyBlobs && typeof data.historyBlobs === 'object') {
      for (const [nid, blobs] of Object.entries(data.historyBlobs)) {
        if (!ID_RE.test(nid) || !blobs || typeof blobs !== 'object' || Array.isArray(blobs)) continue
        const dir = historyBlobDir(nid)
        fs.mkdirSync(dir, { recursive: true })
        for (const [hash, content] of Object.entries(blobs)) {
          if (/^[a-f0-9]{32}$/.test(hash) && typeof content === 'string') {
            fs.writeFileSync(path.join(dir, `${hash}.txt`), content, 'utf8')
          }
        }
      }
    }
    if (data.chats && typeof data.chats === 'object') {
      for (const [nid, payload] of Object.entries(data.chats)) {
        // 兼容两种备份：v1 为消息数组，v2 为 { sessions:[…] }
        if (!ID_RE.test(nid)) continue
        if (Array.isArray(payload) || (payload && Array.isArray(payload.sessions))) {
          writeChatStore(nid, normalizeChatStore(payload))
        }
      }
    }
    if (Array.isArray(data.customStyles)) writeJson(path.join(DATA_DIR, 'custom_styles.json'), data.customStyles)
    if (Array.isArray(data.customTemplates))
      writeJson(path.join(DATA_DIR, 'custom_templates.json'), data.customTemplates)
    // 素材与草稿 / 写作偏好 / 码字统计：旧备份没有这些字段则跳过，保留当前值
    if (data.shelf && typeof data.shelf === 'object')
      writeJson(SHELF_FILE, { items: Array.isArray(data.shelf.items) ? data.shelf.items : [] })
    if (data.prefs && typeof data.prefs === 'object' && Object.keys(data.prefs).length)
      writeJson(SETTINGS_FILE, data.prefs)
    if (data.dailyStats && typeof data.dailyStats === 'object') writeJson(STATS_FILE, data.dailyStats)
    if (data.stationNames && typeof data.stationNames === 'object') writeJson(STATION_NAMES_FILE, data.stationNames)
    // 还原自定义技能（旧备份无 customSkills 字段则跳过）
    if (Array.isArray(data.customSkills)) {
      for (const s of data.customSkills) {
        if (s?.id && ID_RE.test(s.id) && s.name) saveCustomSkill(s)
      }
    }
  } catch (error) {
    try {
      targets.forEach((target, i) => {
        fs.rmSync(target, { recursive: true, force: true })
        if (existed[i]) fs.cpSync(path.join(checkpoint, String(i)), target, { recursive: true })
      })
      fs.rmSync(checkpoint, { recursive: true, force: true })
      invalidateJsonCache()
      return res.status(500).json({ error: '恢复失败，已回滚到恢复前状态：' + error.message })
    } catch (rollbackError) {
      return res
        .status(500)
        .json({ error: '恢复中断，回滚点已保留于 ' + checkpoint + '。请保留此目录：' + rollbackError.message })
    }
  }
  try {
    fs.rmSync(checkpoint, { recursive: true, force: true })
  } catch {
    /* 完成后的回滚点清理失败不影响书稿 */
  }
  res.json({ ok: true, restored })
})

// ---------- 参考小说分析：扫描文件夹、AI 分析、自动补充设定 ----------
// 智能解码：优先 UTF-8（严格校验，非法字节自动回退 GB18030/GBK）
const utf8Strict = new TextDecoder('utf-8', { fatal: true })
const gbDecoder = new TextDecoder('gb18030')
export function decodeRefText(buf) {
  try {
    return utf8Strict.decode(buf)
  } catch {
    return gbDecoder.decode(buf)
  }
}

// 扫描指定文件夹中的参考小说文件（.txt / .md）
// ---------- 参考作品差异跟踪 ----------
// novel.refAnalyzed = { at, files: { "文件名": "wordcount" } } —— 上次分析时的文件指纹。
// 扫描时对比当前文件，标注新增（new）/变化（changed）文件，供前端提示「是否有新参考内容未分析」。
function referenceScan(novel, folderPath) {
  const SUPPORTED_EXTS = ['.txt', '.md', '.text']
  const files = []
  try {
    for (const entry of fs.readdirSync(folderPath)) {
      const ext = path.extname(entry).toLowerCase()
      if (!SUPPORTED_EXTS.includes(ext)) continue
      const fullPath = path.join(folderPath, entry)
      try {
        const content = decodeRefText(fs.readFileSync(fullPath))
        const words = countTextUnits(content)
        if (words <= 100) continue
        const prevFp = novel.refAnalyzed?.files?.[entry]
        let status = 'same'
        if (prevFp === undefined) status = 'new'
        else if (prevFp !== String(words)) status = 'changed'
        files.push({ name: entry, path: fullPath, words, preview: content.replace(/\s+/g, ' ').slice(0, 200), status })
      } catch {
        /* 跳过无法读取的文件 */
      }
    }
  } catch {
    /* 读取失败返回空 */
  }
  return files
}

// 扫描参考文件夹：返回文件清单，并标注与上次分析的差异
app.post('/api/novels/:id/scan-folder', (req, res) => {
  const novel = getNovel(req.params.id)
  if (!novel) return res.status(404).json({ error: '小说不存在' })
  const folderPath = String(req.body?.folderPath || novel.folderPath || '').trim()
  if (!folderPath) return res.status(400).json({ error: '请先指定参考小说文件夹路径' })
  if (!fs.existsSync(folderPath)) return res.status(400).json({ error: `文件夹不存在：${folderPath}` })
  try {
    const stat = fs.statSync(folderPath)
    if (!stat.isDirectory()) return res.status(400).json({ error: `路径不是文件夹：${folderPath}` })
  } catch {
    return res.status(400).json({ error: `无法访问文件夹：${folderPath}` })
  }
  const files = referenceScan(novel, folderPath)
  const newOrChanged = files.filter(f => f.status === 'new' || f.status === 'changed')
  res.json({ ok: true, files, count: files.length, newCount: newOrChanged.length, hasNew: newOrChanged.length > 0 })
})

/**
 * 拆书（对标星月）：把参考作品按章/按块切开，逐块做技法逆向，再汇总成一份报告落盘。
 * 与 analyze-references 的区别：那条是「设定提取」（人物/世界观，给同人文用），每本只看前 8000 字；
 * 这条是「技法逆向」（结构/节奏/爽点/钩子），并且**不写进本书设定**，避免参考信息污染自己的档案。
 *
 * 现在是后台任务：立刻返回 jobId（202），进度轮 job.stream，结果在 job.result。
 */
app.post('/api/novels/:id/deconstruct-references', (req, res) => {
  const novel = getNovel(req.params.id)
  if (!novel) return res.status(404).json({ error: '小说不存在' })
  const folderPath = String(req.body?.folderPath || novel.folderPath || '').trim()
  if (!folderPath) return res.status(400).json({ error: '请先指定参考小说文件夹路径' })
  if (!fs.existsSync(folderPath)) return res.status(400).json({ error: `文件夹不存在：${folderPath}` })
  try {
    if (!fs.statSync(folderPath).isDirectory()) return res.status(400).json({ error: `路径不是文件夹：${folderPath}` })
  } catch {
    return res.status(400).json({ error: `无法访问文件夹：${folderPath}` })
  }
  const conn = resolveConn(req.body?.modelId || novel.modelId)
  if (!conn) return res.status(400).json({ error: '请先选择模型' })
  startJobRoute(res, () => ({ ...newJob(novel.id, 'deconstruct'), folderPath, modelId: conn.id }))
})

/**
 * 把拆书报告写进本书「风格档案」。
 * 档案是写作的宪法（优先级高于文风预设），写进去之后所有正文都会以它校准 —— 这是「学它的写法」的落点。
 * 与 analyze-references 的区别：那条改设定字段（剧情/世界观），这条改**怎么写**。
 */
app.post('/api/novels/:id/apply-deconstruct', async (req, res) => {
  const novel = getNovel(req.params.id)
  if (!novel) return res.status(404).json({ error: '小说不存在' })
  const report = String(req.body?.report || '').trim()
  if (!report) return res.status(400).json({ error: '报告内容为空' })

  try {
    // 快照必须在写入之前留：pushHistory 需要完整小说对象（旧代码传了 id 字符串，静默失效）
    pushHistory(novel, '拆书报告写入风格档案前')
    const updated = await updateJson(novelFile(novel.id), cur => {
      if (!cur) return null
      const existing = String(cur.styleProfile || '').trim()
      const stamp = new Date().toLocaleDateString('zh-CN')
      cur.styleProfile = `${existing ? existing + '\n\n' : ''}【拆书技法 · ${stamp}】\n${report.slice(0, 8000)}`
      cur.updatedAt = Date.now()
      return cur
    })
    appendLog('deconstruct', `${novel.id} 拆书技法已写入风格档案`)
    res.json({ ok: true, novel: updated ? normalizeNovel(updated) : null })
  } catch (e) {
    chatRouteError(res, e)
  }
})

// AI 分析参考小说：读取文件夹中的所有小说，提取人物、事件、剧情线等
app.post('/api/novels/:id/analyze-references', async (req, res) => {
  const novel = getNovel(req.params.id)
  if (!novel) return res.status(404).json({ error: '小说不存在' })
  const folderPath = String(req.body?.folderPath || novel.folderPath || '').trim()
  if (!folderPath) return res.status(400).json({ error: '请先指定参考小说文件夹路径' })
  if (!fs.existsSync(folderPath)) return res.status(400).json({ error: `文件夹不存在：${folderPath}` })

  const conn = resolveConn(req.body?.modelId || novel.modelId)
  if (!conn) return res.status(400).json({ error: '请先选择模型' })

  const SUPPORTED_EXTS = ['.txt', '.md', '.text']
  const files = []
  try {
    const entries = fs.readdirSync(folderPath)
    for (const entry of entries) {
      const ext = path.extname(entry).toLowerCase()
      if (SUPPORTED_EXTS.includes(ext)) {
        const fullPath = path.join(folderPath, entry)
        try {
          const content = decodeRefText(fs.readFileSync(fullPath))
          const words = countTextUnits(content)
          if (words > 100) {
            files.push({ name: entry, content, words })
          }
        } catch {
          /* 跳过无法读取的文件 */
        }
      }
    }
  } catch (e) {
    return res.status(500).json({ error: `读取文件夹失败：${e.message}` })
  }
  if (!files.length) return res.status(400).json({ error: '文件夹中没有找到有效的参考小说文件（.txt 或 .md）' })

  // 合并所有参考小说内容（每本截取前 8000 字，总量再截一次，避免 prompt 过长）
  const MAX_CHARS_PER_FILE = 8000
  const MAX_TOTAL_CHARS = 50000
  const combined = files
    .map(f => {
      const content = f.content.replace(/\s+/g, ' ').trim()
      const truncated =
        content.length > MAX_CHARS_PER_FILE ? content.slice(0, MAX_CHARS_PER_FILE) + '……（内容截断）' : content
      return `【${f.name}】（约 ${f.words} 字）\n${truncated}`
    })
    .join('\n\n---\n\n')
  const finalCombined =
    combined.length > MAX_TOTAL_CHARS
      ? combined.slice(0, MAX_TOTAL_CHARS) + '\n……（参考内容过多，仅分析前一段）'
      : combined

  try {
    let out = ''
    for await (const part of callAI(conn, {
      temperature: 0.3,
      maxTokens: MAX_TOKENS,
      messages: referenceNovelMessages(
        novel,
        finalCombined,
        files.map(f => f.name)
      )
    })) {
      if (part.type === 'content') out += part.text
    }
    const analysis = extractReferenceAnalysis(out)
    if (!analysis) {
      return res.status(422).json({ error: 'AI 返回的内容无法解析，请换一个模型或重试' })
    }
    // 分析成功后记录文件指纹（供下次差异对比）
    const fp = {}
    for (const f of files) fp[f.name] = String(f.words)
    // AI 调用期间用户可能编辑了作品；只在最新文件上合并参考文件指纹，
    // 不要用请求开始时的整书快照覆盖新标题、设定或章节。
    const updated = await updateNovel(req.params.id, current => {
      current.refAnalyzed = { at: Date.now(), files: fp }
      return current
    })
    if (!updated) return res.status(404).json({ error: '小说已不存在' })
    res.json({ ok: true, analysis })
  } catch (e) {
    res.status(502).json({ error: upstreamFailHint(e) })
  }
})

// 应用分析结果：将 AI 分析出的人物、剧情元素、世界观等补充进小说设定
app.post('/api/novels/:id/apply-analysis', async (req, res) => {
  const novel = getNovel(req.params.id)
  if (!novel) return res.status(404).json({ error: '小说不存在' })
  const analysis = req.body?.analysis
  if (!analysis || typeof analysis !== 'object') return res.status(400).json({ error: '分析结果不合法' })

  // 落库走书级事务（同导入/回滚）：绕过写队列的整书读改写，撞上章节任务
  // 事务的读写间隙时，这次写入会被过期整书快照静默覆盖
  const updated = await updateNovel(req.params.id, n => {
    pushHistory(n, '应用参考小说分析结果前')
    applyAnalysisToNovel(n, analysis)
    normalizeNovel(n)
    return n
  })
  res.json({ ok: true, novel: updated })
})

// 把参考作品分析结果合并进 novel（apply-analysis 的落库部分，抽出来以便在书级事务内执行）
function applyAnalysisToNovel(novel, analysis) {
  // 补充人物设定
  if (Array.isArray(analysis.characters)) {
    const existingNames = new Set(
      [novel.protagonist?.name, ...(novel.characters || []).map(c => c.name)].filter(Boolean)
    )
    for (const c of analysis.characters) {
      if (!c?.name || existingNames.has(c.name)) continue
      const newChar = {
        id: crypto.randomUUID(),
        name: c.name || '',
        role: c.role || '',
        personality: c.personality || '',
        appearance: c.appearance || '',
        background: c.background || '',
        notes: c.notes || ''
      }
      // 如果没有主角或主角没名字，第一个角色补为主角
      if (!novel.protagonist?.name && !novel.protagonist?.role) {
        novel.protagonist = newChar
      } else {
        novel.characters = [...(novel.characters || []), newChar]
      }
      existingNames.add(c.name)
    }
  }

  // 补充剧情走向（仅在尚无简介时）
  if (analysis.plotSummary && typeof analysis.plotSummary === 'string' && !String(novel.synopsis || '').trim()) {
    novel.synopsis = `【参考作品剧情走向】\n${analysis.plotSummary}`
  }

  // 补充世界观
  if (analysis.worldBuilding && typeof analysis.worldBuilding === 'string') {
    const existing = novel.worldview || ''
    if (existing) {
      novel.worldview = `${existing}\n\n【参考作品世界观补充】\n${analysis.worldBuilding}`
    } else {
      novel.worldview = analysis.worldBuilding
    }
  }

  // 补充剧情元素
  if (analysis.plotEvents && typeof analysis.plotEvents === 'string') {
    const existing = novel.elements || ''
    if (existing) {
      novel.elements = `${existing}\n\n【参考作品剧情元素】\n${analysis.plotEvents}`
    } else {
      novel.elements = analysis.plotEvents
    }
  } else if (Array.isArray(analysis.plotEvents)) {
    const existing = novel.elements || ''
    const newEvents = analysis.plotEvents.join('\n')
    if (existing) {
      novel.elements = `${existing}\n\n【参考作品剧情元素】\n${newEvents}`
    } else {
      novel.elements = newEvents
    }
  }

  // 补充写作风格
  if (analysis.writingStyle && typeof analysis.writingStyle === 'string') {
    const existing = novel.extraRequirements || ''
    novel.extraRequirements = `${existing}\n\n【参考作品文风】\n${analysis.writingStyle}`
  }

  // 补充核心关系
  if (analysis.keyRelationships && typeof analysis.keyRelationships === 'string') {
    const existing = novel.extraRequirements || ''
    if (existing) {
      novel.extraRequirements = `${existing}\n\n【参考作品核心关系】\n${analysis.keyRelationships}`
    } else {
      novel.extraRequirements = `【参考作品核心关系】\n${analysis.keyRelationships}`
    }
  }

  // 补充主题
  if (analysis.themes && typeof analysis.themes === 'string') {
    const existing = novel.extraRequirements || ''
    novel.extraRequirements = `${existing}\n\n【参考作品主题】\n${analysis.themes}`
  }
}

// 导出全文
app.get('/api/novels/:id/export', (req, res) => {
  const novel = getNovel(req.params.id)
  if (!novel) return res.status(404).send('小说不存在')
  let content = `《${novel.title}》\n`
  if (novel.synopsis) content += `\n【简介】${novel.synopsis}\n`
  if (novel.masterOutline) content += `\n\n${'—'.repeat(6)} 总纲 ${'—'.repeat(6)}\n${novel.masterOutline}\n`
  const chapters = [...(novel.chapters || [])].sort((a, b) => a.index - b.index)
  for (const ch of chapters) {
    content += `\n\n${'='.repeat(24)}\n第${ch.index}章 ${ch.title}\n${'='.repeat(24)}\n\n${ch.content}\n`
  }
  const fmt = req.query.format === 'txt' ? 'txt' : 'md'
  const filename = encodeURIComponent(`${novel.title}_全文.${fmt}`)
  res.setHeader('Content-Type', 'text/plain; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${filename}`)
  res.send(content)
})

// ---------- 导出 EPUB / HTML（手动触发，含 EPUB 所需的 zip 打包） ----------
// 极简 ZIP 存储格式打包，仅用于本地导出（无压缩，兼容常见阅读器）

// crc32 查表实现：ZIP 本地文件头与中央目录都要求真实 crc（本打包不启用
// data-descriptor 尾部结构，crc 置 0 会被严格解析器 / CRC 校验类库判为损坏）
const CRC32_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC32_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function buildZip(files) {
  let central = []
  let offset = 0
  const chunks = []
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8')
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data || '', 'utf8')
    const crc = crc32(data)
    const lfh = Buffer.alloc(30)
    lfh.writeUInt32LE(0x04034b50, 0)
    lfh.writeUInt16LE(20, 4)
    lfh.writeUInt16LE(0x0800, 6)
    lfh.writeUInt16LE(0, 8)
    lfh.writeUInt16LE(0, 10)
    lfh.writeUInt16LE(0, 12)
    // 本地文件头布局（ZIP 规范）：crc@14 / 压缩尺寸@18 / 原始尺寸@22 /
    // 文件名长度@26 / 扩展字段长度@28。早期版本按中央目录的偏移写（crc@16、
    // 尺寸@20/24、文件名长度@28），整个头错位，仅因中央目录正确才被宽松阅读器容忍。
    lfh.writeUInt32LE(crc, 14)
    lfh.writeUInt32LE(data.length, 18)
    lfh.writeUInt32LE(data.length, 22)
    lfh.writeUInt16LE(nameBuf.length, 26)
    lfh.writeUInt16LE(0, 28)
    const local = Buffer.concat([lfh, nameBuf, data])
    chunks.push(local)
    central.push({ nameBuf, dataLen: data.length, crc, localOffset: offset })
    offset += local.length
  }
  const cdStart = offset
  const cdParts = []
  for (const c of central) {
    const h = Buffer.alloc(46)
    h.writeUInt32LE(0x02014b50, 0)
    h.writeUInt16LE(20, 4)
    h.writeUInt16LE(20, 6)
    h.writeUInt16LE(0x0800, 8)
    h.writeUInt16LE(0, 10)
    h.writeUInt16LE(0, 12)
    h.writeUInt16LE(0, 14)
    h.writeUInt32LE(c.crc, 16)
    h.writeUInt32LE(c.dataLen, 20)
    h.writeUInt32LE(c.dataLen, 24)
    h.writeUInt16LE(c.nameBuf.length, 28)
    h.writeUInt16LE(0, 30)
    h.writeUInt16LE(0, 32)
    h.writeUInt16LE(0, 34)
    h.writeUInt16LE(0, 36)
    h.writeUInt32LE(c.localOffset, 42)
    cdParts.push(Buffer.concat([h, c.nameBuf]))
  }
  const cd = Buffer.concat(cdParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(central.length, 8)
  eocd.writeUInt16LE(central.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(cdStart, 16)
  eocd.writeUInt16LE(0, 20)
  return Buffer.concat([...chunks, cd, eocd])
}

function htmlEscape(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function chapterHtmlBody(novel, chapters) {
  const head = []
  if (novel.synopsis) head.push(`<h2>简介</h2><p>${htmlEscape(novel.synopsis).replace(/\n/g, '<br/>')}</p>`)
  if (novel.masterOutline)
    head.push(`<h2>全书总纲</h2><p>${htmlEscape(novel.masterOutline).replace(/\n/g, '<br/>')}</p>`)
  const body = head.join('\n')
  const content = chapters
    .map(
      c =>
        `<h1>第${c.index}章 ${htmlEscape(c.title || '')}</h1>\n${htmlEscape(c.content || '').replace(/\n/g, '<br/>')}\n`
    )
    .join('\n')
  return { body, content }
}

app.get('/api/novels/:id/export/epub', (req, res) => {
  const novel = getNovel(req.params.id)
  if (!novel) return res.status(404).send('小说不存在')
  const chapters = novelChaptersSorted(novel)
  const { body } = chapterHtmlBody(novel, chapters)
  const spine = chapters.map((_, i) => `<itemref idref="c${i}"/>`).join('\n')
  const manifest = chapters
    .map((_, i) => `<item id="c${i}" href="c${i}.xhtml" media-type="application/xhtml+xml"/>`)
    .join('\n')
  const chapterDocs = chapters.map(
    (c, _i) =>
      `<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml"><head><title>第${c.index}章 ${htmlEscape(c.title || '')}</title><link rel="stylesheet" type="text/css" href="style.css"/></head><body><h1>第${c.index}章 ${htmlEscape(c.title || '')}</h1>${htmlEscape(c.content || '').replace(/\n/g, '<br/>')}</body></html>`
  )
  const frontPage = `<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${htmlEscape(novel.title)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head><body><h1>${htmlEscape(novel.title)}</h1>${body}</body></html>`
  const ncx = `<?xml version="1.0" encoding="utf-8"?>\n<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="urn:uuid:${crypto.randomUUID()}"/><meta name="dtb:depth" content="1"/></head><docTitle><text>${htmlEscape(novel.title)}</text></docTitle><navMap><navPoint id="front" playOrder="0"><navLabel><text>前言</text></navLabel><content src="front.xhtml"/></navPoint>${chapters.map((c, i) => `<navPoint id="n${i}" playOrder="${i + 1}"><navLabel><text>第${c.index}章 ${htmlEscape(c.title || '')}</text></navLabel><content src="c${i}.xhtml"/></navPoint>`).join('')}</navMap></ncx>`
  const opf = `<?xml version="1.0" encoding="utf-8"?>\n<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">urn:uuid:${crypto.randomUUID()}</dc:identifier><dc:title>${htmlEscape(novel.title)}</dc:title><dc:language>zh-CN</dc:language><meta property="dcterms:modified">${new Date().toISOString()}</meta></metadata><manifest><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/><item id="front" href="front.xhtml" media-type="application/xhtml+xml"/><item id="style" href="style.css" media-type="text/css"/>${manifest}</manifest><spine toc="ncx"><itemref idref="front"/>${spine}</spine></package>`
  const css =
    'body { font-family: serif; line-height: 1.8; padding: 1em; }\nh1 { font-size: 1.6em; margin: 1em 0 .5em; }\np { margin: .6em 0; text-indent: 2em; }\n'
  const files = [
    { name: 'mimetype', data: Buffer.from('application/epub+zip') },
    {
      name: 'META-INF/container.xml',
      data: Buffer.from(
        `<?xml version="1.0" encoding="utf-8"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`
      )
    },
    { name: 'OEBPS/content.opf', data: Buffer.from(opf) },
    { name: 'OEBPS/toc.ncx', data: Buffer.from(ncx) },
    { name: 'OEBPS/style.css', data: Buffer.from(css) },
    { name: 'OEBPS/front.xhtml', data: Buffer.from(frontPage) },
    ...chapters.map((_, i) => ({ name: `OEBPS/c${i}.xhtml`, data: Buffer.from(chapterDocs[i]) }))
  ]
  const zip = buildZip(files)
  const filename = encodeURIComponent(`${novel.title || 'novel'}.epub`)
  res.setHeader('Content-Type', 'application/epub+zip')
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${filename}`)
  res.send(zip)
})

app.get('/api/novels/:id/export/html', (req, res) => {
  const novel = getNovel(req.params.id)
  if (!novel) return res.status(404).send('小说不存在')
  const chapters = novelChaptersSorted(novel)
  const { body, content } = chapterHtmlBody(novel, chapters)
  const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"/><title>${htmlEscape(novel.title)}</title><style>body{max-width:760px;margin:40px auto;font-family:serif;line-height:1.9;padding:0 16px}h1{font-size:1.6em;margin:2em 0 .5em}</style></head><body><h1>${htmlEscape(novel.title)}</h1>${body}\n\n${content}</body></html>`
  const filename = encodeURIComponent(`${novel.title || 'novel'}.html`)
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${filename}`)
  res.send(html)
})

// ---------- 素材与草稿库（跨书共享） ----------
// 共用同一套全局 JSON：kind 分为 'material'（素材）与 'draft'（草稿）

function novelChaptersSorted(novel) {
  return [...(novel.chapters || [])].filter(c => c.content?.trim()).sort((a, b) => a.index - b.index)
}

app.get('/api/shelf', (req, res) => {
  const kind = req.query.kind === 'draft' ? 'draft' : 'material'
  const items = readShelf().filter(i => i.kind === kind)
  res.json(
    items
      .map(i => ({
        id: i.id,
        title: i.title,
        kind: i.kind,
        content: String(i.content || '').slice(0, 200),
        tags: i.tags || [],
        createdAt: i.createdAt,
        updatedAt: i.updatedAt
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  )
})

app.get('/api/shelf/:id', (req, res) => {
  const item = readShelf().find(i => i.id === req.params.id)
  if (!item) return res.status(404).json({ error: '素材不存在' })
  res.json(item)
})

app.post('/api/shelf', async (req, res) => {
  const { title, content, kind, tags } = req.body || {}
  if (!String(title || '').trim()) return res.status(400).json({ error: '请输入标题' })
  const item = {
    id: crypto.randomUUID(),
    title: String(title).trim(),
    content: String(content || ''),
    kind: kind === 'draft' ? 'draft' : 'material',
    tags: Array.isArray(tags) ? tags.map(String).filter(Boolean).slice(0, 20) : [],
    createdAt: Date.now(),
    updatedAt: Date.now()
  }
  // 读-改-写走文件事务：并发添加素材不会互相覆盖
  await withFile(SHELF_FILE, () => {
    saveShelf([...readShelf(), item])
  })
  res.status(201).json(item)
})

app.put('/api/shelf/:id', async (req, res) => {
  const { title, content, kind, tags } = req.body || {}
  if (title !== undefined && !String(title).trim()) return res.status(400).json({ error: '请输入标题' })
  let found = false
  let updated = null
  await withFile(SHELF_FILE, () => {
    const items = readShelf()
    const item = items.find(i => i.id === req.params.id)
    if (!item) return
    found = true
    if (title !== undefined) item.title = String(title).trim()
    if (content !== undefined) item.content = String(content || '')
    if (kind === 'draft' || kind === 'material') item.kind = kind
    if (Array.isArray(tags)) item.tags = tags.map(String).filter(Boolean).slice(0, 20)
    item.updatedAt = Date.now()
    saveShelf(items)
    updated = item
  })
  if (!found) return res.status(404).json({ error: '素材不存在' })
  res.json(updated)
})

app.delete('/api/shelf/:id', async (req, res) => {
  await withFile(SHELF_FILE, () => {
    saveShelf(readShelf().filter(i => i.id !== req.params.id))
  })
  res.json({ ok: true })
})

// ---------- 打包模式下托管前端静态文件（SPA）----------
const distDir = path.join(ROOT, 'dist')
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir))
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next()
    res.sendFile(path.join(distDir, 'index.html'))
  })
}

// ---------- 全局错误兜底：任何路由抛错都回 JSON，不再挂死或回 HTML ----------
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err)
  // body 超限说人话：body-parser 默认只回 "request entity too large"，用户不知道是哪一步、
  // 也不知道该改什么。这里点明是请求体过大并给出可操作建议。
  if (err?.type === 'entity.too.large' || Number(err?.status) === 413) {
    appendLog('error', `${req.method} ${req.originalUrl} → 413 请求体过大`)
    const limit = err?.limit ? `（上限 ${Math.round(err.limit / 1024 / 1024)}mb）` : ''
    return res.status(413).json({
      error: `请求体过大${limit}，请分批提交或改用较小的备份文件。`
    })
  }
  const status = Number(err?.status)
  appendLog('error', `${req.method} ${req.originalUrl} → ${status || 500} ${String(err?.message || err)}`)
  res.status(status >= 400 && status < 600 ? status : 500).json({ error: String(err?.message || '服务器内部错误') })
})

// ---------- 启动（供 Electron 与独立运行复用）----------
let activeServer = null
function listen(port) {
  return new Promise((resolve, reject) => {
    const srv = app.listen(port, '127.0.0.1', () => resolve(srv))
    srv.on('error', reject)
  })
}

export async function stopServer() {
  if (!activeServer) return
  abortAllJobs('服务已停止，任务已中止')
  const srv = activeServer
  activeServer = null
  await new Promise(resolve => srv.close(resolve))
  releaseInstanceLock()
}

/**
 * 跨进程实例锁：同一数据目录同时只允许一个后端进程写入。
 * Electron 侧已有 requestSingleInstanceLock，但「独立运行 server/index.mjs」
 * 或「用户双击了两次便携版」时仍可能起两个进程读写同一份 data/，
 * 表现为写盘互相覆盖、备份互相抢占。
 *
 * 用「带 pid 的锁文件 + 身份核验」实现：
 *  - 锁文件存在，且其中 pid 现在仍是本程序 → 拒绝启动（抛出可读错误）
 *  - 锁文件存在但持有者已消失（崩溃/强杀），或该 pid 已被系统回收给别的进程 → 视为陈旧锁，抢占
 *
 * 「持有者是不是本程序」不能只看进程是否活着：PID 回收后锁里的号码会落到任意一个无关
 * 进程上（用户自己的 node 脚本、编辑器、甚至系统组件），只判断存活就会把别人的进程
 * 当成「另一个小说工坊」而拒绝启动。核验身份改用进程创建时间：startedAt 是持有者写下锁的
 * 时刻，而持有者必然在写锁之前就已存在；若该 pid 现在的创建时间晚于 startedAt，说明号码
 * 是回收后重新分配的，可直接抢锁。创建时间取不到时退化为命令行特征判断，再取不到就保守
 * 认定「还是本程序」，绝不误抢正在写数据的实例。
 * 锁文件另存一个随机 token，仅用于释放/抢占时自证「这个锁确实是我写的」，不参与占用判定。
 */
const LOCK_FILE = path.join(DATA_DIR, '.instance.lock')
const LOCK_TOKEN = crypto.randomBytes(16).toString('hex')
const LOCK_SELF_RE = /node|electron|小说工坊|novelwriter|novel-writer/i
/** 锁的持有者只可能是本项目的后端：Electron 主进程（NovelWriter.exe）或独立 node 进程 */
const LOCK_SELF_IMAGE_RE = /^(novelwriter(-portable)?|node|electron)\.exe$/i
/**
 * 租约：持有者每 5 秒刷新锁文件时间戳；超过 180 秒没有刷新即视为「持有者已经不在」。
 * 这是 PID 判定之外的兜底——Windows 的 PID 会被系统回收给无关进程，
 * 遇到这种情况「进程还活着」并不代表「还有人正在写这个数据目录」。
 */
const LOCK_HEARTBEAT_MS = 5000
const LOCK_LEASE_MS = 180000
let lockOwned = false
let lockHeartbeat = null

function readLock() {
  try {
    const raw = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'))
    return raw && typeof raw.pid === 'number' ? raw : null
  } catch {
    return null
  }
}

/**
 * 系统级反查某个 pid：返回创建时刻（ms）与命令行，取不到的字段为 null。
 * Windows 走一次 CIM 查询（比 tasklist 多拿创建时间，正是判定 PID 回收的关键）；
 * POSIX 读 /proc/<pid>/cmdline 与 /proc/<pid> 目录 mtime（即进程启动时刻）。
 */
function readProcessInfo(pid) {
  if (process.platform === 'win32') {
    try {
      const ps = path.join(
        process.env.SystemRoot || 'C:\\Windows',
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe'
      )
      // Ticks 差值换算成 Unix 毫秒：绕开本地时区与日期序列化差异
      const out = execSync(
        `${JSON.stringify(ps)} -NoProfile -NonInteractive -Command "` +
          `$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; ` +
          // 格式串必须用单引号：cmd.exe 会先吃掉双引号，剩下的 {0}|{1} 会被 PowerShell 当成脚本块解析
          `if($p){'{0}|{1}' -f [int64](($p.CreationDate.ToUniversalTime().Ticks-621355968000000000)/10000), $p.CommandLine}"`,
        { encoding: 'utf8', timeout: 10000, windowsHide: true }
      )
      const line = String(out || '')
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .pop()
      if (!line) return { startedAt: null, cmdline: null }
      const cut = line.indexOf('|')
      const ms = Number(cut >= 0 ? line.slice(0, cut) : line)
      return {
        startedAt: Number.isFinite(ms) && ms > 0 ? ms : null,
        cmdline: cut >= 0 ? line.slice(cut + 1) : null
      }
    } catch {
      return { startedAt: null, cmdline: null }
    }
  }
  try {
    const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim()
    const st = fs.statSync(`/proc/${pid}`)
    return { startedAt: st.mtimeMs || null, cmdline: cmd || null }
  } catch {
    return { startedAt: null, cmdline: null }
  }
}

/**
 * 快速反查：进程还在不在、镜像名是什么。
 *
 * 比 CIM 轻得多（tasklist 不依赖 WMI 服务冷启动），而且镜像名能直接区分
 * 「PID 被系统回收给别的程序」——这正是「进程还活着但锁早已作废」的主因。
 * 取不到就返回 null（当作进程不存在），后续还有租约兜底。
 */
function readProcessImage(pid) {
  if (!pid) return null
  try {
    const out = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, {
      encoding: 'utf8',
      timeout: 8000,
      windowsHide: true
    })
    const m = String(out || '').match(/"([^"]+)","(\d+)"/)
    if (!m) return null
    return { name: m[1], pid: Number(m[2]) }
  } catch {
    return null
  }
}

/** 锁文件是否还在被持有者续租 */
function lockLeaseFresh() {
  try {
    const st = fs.statSync(LOCK_FILE)
    return Date.now() - st.mtimeMs < LOCK_LEASE_MS
  } catch {
    return false
  }
}

/** 开始续租：持有锁期间定期刷新锁文件时间戳 */
function startLockHeartbeat() {
  stopLockHeartbeat()
  lockHeartbeat = setInterval(() => {
    try {
      const now = new Date()
      fs.utimesSync(LOCK_FILE, now, now)
    } catch {
      /* 锁文件已不在（被别的实例接管或删除）时无需续租 */
    }
  }, LOCK_HEARTBEAT_MS)
  lockHeartbeat.unref?.()
}

function stopLockHeartbeat() {
  if (lockHeartbeat) {
    clearInterval(lockHeartbeat)
    lockHeartbeat = null
  }
}

/**
 * 锁里的持有者是否还活着且确实是本程序。判定顺序即优先级：
 *  - 进程已经不存在 → 持有者早已消失，锁是陈旧的，可直接抢
 *  - 进程还在但镜像不是本项目（node / electron / NovelWriter）→ PID 被系统回收给别的
 *    程序，锁同样是陈旧的，可直接抢
 *  - 镜像对得上 → 再用创建时间核对：创建时间晚于写锁时刻说明号码被回收过，可抢；
 *    创建时间对得上才认定为真持有者
 *  - 创建时间拿不到 → 看租约：持有者已死就不会再刷新锁文件时间戳
 *  - 什么都查不到 → 保守认定「还在跑」，绝不误抢正在写数据的实例
 */
function lockHolderAlive(existing) {
  if (!existing || !Number.isFinite(existing.pid)) return false
  if (existing.pid === process.pid) return true

  const task = readProcessImage(existing.pid)
  if (!task) return false
  if (!LOCK_SELF_IMAGE_RE.test(task.name)) return false

  const info = readProcessInfo(existing.pid)
  if (info.startedAt != null && existing.startedAt) {
    // 持有者必然在写锁之前就已存在；创建时间晚于写锁时刻 → 号码被回收
    return info.startedAt <= existing.startedAt + 1000
  }
  if (info.cmdline != null && !LOCK_SELF_RE.test(info.cmdline)) return false
  return lockLeaseFresh()
}

/** 仅供测试：陈旧锁判定的探针（生产路径不依赖它） */
export function __probeLockHolderAlive(lock) {
  return lockHolderAlive(lock)
}

/** 写锁（wx 保证「不存在才建」，绝不覆盖别人的锁） */
function writeLock() {
  const fd = fs.openSync(LOCK_FILE, 'wx')
  try {
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: Date.now(), token: LOCK_TOKEN }), 'utf8')
  } finally {
    fs.closeSync(fd)
  }
  startLockHeartbeat()
}

function acquireInstanceLock() {
  // 幂等：本进程已持有锁（如 macOS 关窗后再点 Dock 图标重建窗口，startServer 会被
  // 再次调用）时直接复用，绝不把自己的锁当成「另一个进程占用」报错
  if (lockOwned) return
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    writeLock()
    lockOwned = true
    return
  } catch (e) {
    if (e.code !== 'EEXIST') throw e
  }

  const existing = readLock()
  if (existing && existing.pid === process.pid) {
    // 锁里的 pid 就是本进程（上次 startServer 留下、release 未被调用）→ 视为已持有
    lockOwned = true
    return
  }
  if (existing && lockHolderAlive(existing)) {
    const startedAt = existing.startedAt ? new Date(existing.startedAt).toLocaleString() : '未知时间'
    throw new Error(
      `数据目录已被另一个「小说工坊」进程占用（PID ${existing.pid}，启动于 ${startedAt}）。\n` +
        '为避免两处同时写入导致数据互相覆盖，本次启动已中止。请先关闭已运行的窗口/终端后重试；\n' +
        `若确认没有其它实例在跑，可手动删除锁文件后重启：${LOCK_FILE}`
    )
  }
  try {
    // 抢占前再核对一次：若锁在这几毫秒里被另一个实例重建了，就让它赢
    const again = readLock()
    if (again && again.pid !== process.pid && again.token !== LOCK_TOKEN && lockHolderAlive(again)) {
      throw new Error('锁已被另一个实例接管，本次启动已中止')
    }
    if (fs.existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE)
    writeLock()
    lockOwned = true
  } catch (e) {
    if (String(e?.message || '').includes('锁已被另一个实例接管')) throw e
    throw new Error('无法取得数据目录锁，请稍后重试')
  }
}

function releaseInstanceLock() {
  stopLockHeartbeat()
  if (!lockOwned) return
  try {
    const cur = readLock()
    // 锁已被别人接管（pid 与 token 都不是我的）就不要误删
    if (cur && cur.pid !== process.pid && cur.token !== LOCK_TOKEN) return
    if (fs.existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE)
    lockOwned = false
  } catch {
    /* 清理失败无害，下次启动会按「陈旧锁」处理 */
  }
}

export async function startServer(preferredPort = 3789, options = {}) {
  // 幂等：Electron 的 activate 会重建窗口并再次调用 startServer；
  // 已在监听时直接返回现有端口，不要二次 listen / 抢锁
  if (activeServer) return activeServer.address().port
  const strictPort = !!options.strictPort
  acquireInstanceLock()
  const lastPort = strictPort ? preferredPort : preferredPort + 19
  for (let p = preferredPort; p <= lastPort; p++) {
    try {
      const srv = await listen(p)
      activeServer = srv
      const actual = srv.address().port
      console.log(`[novel-writer] 服务已启动: http://127.0.0.1:${actual}`)
      installShutdownHooks()
      scheduleAutoBackup()
      return actual
    } catch {
      // 端口被占用，尝试下一个
    }
  }
  releaseInstanceLock()
  throw new Error(strictPort ? `端口 ${preferredPort} 已被占用` : '无可用端口')
}

// ---------- 进程退出清理 ----------
// 退出时：① 停掉所有在跑的任务（掐断上游请求）② 释放实例锁，避免下次启动被自己的陈旧锁拦住
let shutdownHooksInstalled = false
function installShutdownHooks() {
  if (shutdownHooksInstalled) return
  shutdownHooksInstalled = true
  const cleanup = () => {
    abortAllJobs()
    releaseInstanceLock()
  }
  process.once('exit', cleanup)
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.once(sig, () => {
      cleanup()
      process.exit(0)
    })
  }
}

/** 停掉所有运行中的后台任务（窗口关闭 / 进程退出时调用） */
export function abortAllJobs(reason = '应用已关闭') {
  for (const job of jobs.values()) {
    if (job.status !== 'running') continue
    job.stopRequested = true
    job.error = reason
    try {
      job.ctrl.abort()
    } catch {
      /* 已中止 */
    }
  }
}

/**
 * 退出宽限：abortAllJobs 只是掐断上游请求，任务收尾里的「半截正文落草稿」是异步的，
 * 主进程紧接着 app.quit() 就会把这步带走。关窗路径先 await 这个函数再退出。
 */
export function drainJobs(ms = 1500) {
  const until = Date.now() + ms
  return new Promise(resolve => {
    const tick = () => {
      let running = 0
      for (const j of jobs.values()) if (j.status === 'running') running++
      if (!running || Date.now() >= until) return resolve()
      setTimeout(tick, 100)
    }
    tick()
  })
}

// ---------- 自动备份：每天首次启动时把全部数据打包存到 data/backups/ ----------
// 由偏好 autoBackup（默认开）控制；仅保留最近 7 份，不包含模型密钥
const BACKUP_KEEP = 7

// 与 /api/backup 共用同一份打包逻辑
export function buildBackupPayload() {
  const novels = fs
    .readdirSync(NOVELS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => readJson(path.join(NOVELS_DIR, f), null))
    .filter(Boolean)
  const histories = {}
  const historyBlobs = {}
  const chats = {}
  for (const n of novels) {
    try {
      const h = readJson(historyFile(n.id), [])
      if (Array.isArray(h) && h.length) histories[n.id] = h
      const dir = historyBlobDir(n.id)
      if (fs.existsSync(dir)) {
        const blobs = {}
        for (const file of fs.readdirSync(dir)) {
          if (!/^[a-f0-9]{32}\.txt$/.test(file)) continue
          const hash = file.slice(0, -4)
          const content = readBlob(dir, hash)
          if (content) blobs[hash] = content
        }
        if (Object.keys(blobs).length) historyBlobs[n.id] = blobs
      }
    } catch {
      /* 历史缺失不影响备份 */
    }
    try {
      const c = readChatStore(n.id)
      if (c.sessions.length) chats[n.id] = c
    } catch {
      /* 对话缺失不影响备份 */
    }
  }
  return {
    version: 3,
    exportedAt: Date.now(),
    novels,
    histories,
    historyBlobs,
    chats, // 创作研讨对话（v2 起纳入；旧版本还原时自动忽略）
    customStyles: readJson(path.join(DATA_DIR, 'custom_styles.json'), []),
    customTemplates: readJson(path.join(DATA_DIR, 'custom_templates.json'), []),
    customSkills: listCustomSkills(),
    // v3 起纳入：素材与草稿、写作偏好、码字统计（都是用户产出，不属于可再生成的缓存）
    shelf: readJson(SHELF_FILE, { items: [] }),
    prefs: readJson(SETTINGS_FILE, {}),
    dailyStats: readJson(STATS_FILE, {}),
    stationNames: readJson(STATION_NAMES_FILE, null)
    // 注意：不含 models.json（密钥）与 covers/attachments/portraits（二进制图片，需另行保留数据目录）
  }
}

function runAutoBackup() {
  try {
    const prefs = { ...DEFAULT_PREFS, ...readJson(SETTINGS_FILE, {}) }
    if (!prefs.autoBackup) return
    fs.mkdirSync(BACKUP_DIR, { recursive: true })
    const day = new Date().toISOString().slice(0, 10)
    const file = path.join(BACKUP_DIR, `auto_${day}.json`)
    // 同一天重复启动直接覆盖当天那份，不堆积
    writeJson(file, buildBackupPayload())
    // 只保留最近 N 份
    const olds = fs
      .readdirSync(BACKUP_DIR)
      .filter(f => /^auto_\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .sort()
    for (const f of olds.slice(0, Math.max(olds.length - BACKUP_KEEP, 0))) {
      try {
        fs.unlinkSync(path.join(BACKUP_DIR, f))
        fs.rmSync(path.join(BACKUP_DIR, f + '.bak'), { force: true })
      } catch {
        /* 清理失败不阻塞 */
      }
    }
    console.log(`[novel-writer] 自动备份完成: ${file}`)
  } catch (e) {
    console.error(`[novel-writer] 自动备份失败: ${String(e.message || e)}`)
  }
}

function scheduleAutoBackup() {
  const sweep = () => {
    gcAttachments()
    gcPortraits()
    pruneOldRecycle()
    pruneOrphanBaks()
  }
  const t = setTimeout(() => {
    runAutoBackup()
    sweep()
  }, 3000) // 启动稳定后再做，避开端口/窗口初始化
  t.unref?.()
  // 长期挂机不重启也要能回收：每天扫一遍
  const day = setInterval(
    () => {
      runAutoBackup()
      sweep()
    },
    24 * 3600 * 1000
  )
  day.unref?.()
}

/**
 * 孤儿 .bak 清理：原子写会给每个文件留一份 <name>.json.bak（解析失败时兜底读取）。
 * 但主文件被删/被移走后，.bak 就再没人引用，也不会被任何清理规则碰到——它带着完整正文
 * 留在 data/ 里，日积月累既是隐私残留也是磁盘垃圾。这里只在「主文件确实不存在」时才删，
 * 存在的主文件一律保留其 .bak（那正是崩溃恢复要用的）。
 */
function pruneOrphanBaks() {
  let pruned = 0
  for (const dir of [NOVELS_DIR, HISTORY_DIR, CHATS_DIR]) {
    let entries = []
    try {
      entries = fs.readdirSync(dir)
    } catch {
      continue
    }
    for (const f of entries) {
      if (!f.endsWith('.json.bak')) continue
      const main = path.join(dir, f.slice(0, -4))
      try {
        if (fs.existsSync(main)) continue
        const recovery = path.join(DATA_DIR, 'recovery-orphans', path.basename(dir))
        fs.mkdirSync(recovery, { recursive: true })
        fs.renameSync(
          path.join(dir, f),
          path.join(recovery, Date.now() + '-' + crypto.randomUUID().slice(0, 8) + '-' + f)
        )
        pruned++
      } catch {
        /* 清理失败不阻塞启动 */
      }
    }
  }
  if (pruned) appendLog('cleanup', `已隔离无主 .bak 文件 ${pruned} 份，原内容保留在 recovery-orphans`)
}

/** 回收站 90 天自动清理：删除超过三个月又一直没手动清空的书，大概率是真不要了 */
function pruneOldRecycle() {
  const LIMIT_MS = 90 * 24 * 3600 * 1000
  try {
    let pruned = 0
    for (const ent of fs.readdirSync(RECYCLE_DIR, { withFileTypes: true })) {
      if (!ent.isDirectory() || !ID_RE.test(ent.name)) continue
      const meta = readJson(path.join(RECYCLE_DIR, ent.name, 'meta.json'), null)
      const at = Number(meta?.deletedAt) || 0
      if (at && Date.now() - at > LIMIT_MS) {
        purgeRecycle(ent.name)
        pruned++
      }
    }
    if (pruned) appendLog('recycle', `清理回收站中超期条目 ${pruned} 本`)
  } catch {
    /* 清理失败不阻塞启动 */
  }
}

/**
 * 孤儿附件回收：图片落在扁平的 ATTACHMENTS_DIR，而清空会话、删除作品、回收站彻底删除
 * 都只动聊天 JSON，不会删文件——目录只进不出。这里扫描全部（含回收站的）会话收集被引用的
 * 文件名，把超过 12 小时无人引用的图片删掉。宽限期是必需的：刚上传还没随消息发出的图
 * 此刻就是「无引用」状态。任一会话文件解析失败则本轮放弃，宁可不清也别误删。
 */
function gcAttachments() {
  try {
    const files = fs.readdirSync(ATTACHMENTS_DIR).filter(f => ATTACH_FILE_RE.test(f))
    if (!files.length) return
    const referenced = new Set()
    const collect = content => {
      const store = JSON.parse(content)
      const sessions = Array.isArray(store?.sessions) ? store.sessions : Array.isArray(store) ? store : []
      for (const s of sessions) {
        for (const m of s?.messages || []) {
          for (const a of m?.attachments || []) if (a?.file) referenced.add(String(a.file))
        }
      }
    }
    for (const dir of [CHATS_DIR, RECYCLE_DIR]) {
      let entries = []
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const ent of entries) {
        const p = path.join(dir, ent.name)
        try {
          if (ent.isFile() && ent.name.endsWith('.json')) collect(fs.readFileSync(p, 'utf8'))
          else if (ent.isDirectory()) {
            for (const g of fs.readdirSync(p))
              if (g.endsWith('.chat.json')) collect(fs.readFileSync(path.join(p, g), 'utf8'))
          }
        } catch {
          appendLog('gc', `附件回收跳过：${p} 解析失败`)
          return
        }
      }
    }
    const cutoff = Date.now() - 12 * 3600 * 1000
    let removed = 0
    for (const f of files) {
      if (referenced.has(f)) continue
      const p = path.join(ATTACHMENTS_DIR, f)
      try {
        if (fs.statSync(p).mtimeMs < cutoff) {
          fs.unlinkSync(p)
          removed++
        }
      } catch {
        /* 单个文件删失败不影响其余 */
      }
    }
    if (removed) appendLog('gc', `回收无引用附件 ${removed} 个`)
  } catch (e) {
    appendLog('gc', `附件回收失败: ${String(e?.message || e)}`)
  }
}

/**
 * 孤儿人物照片回收：照片文件名只出现在作品 JSON（含回收站、历史版本）的 portrait 字段里。
 * 不逐层解析结构，直接在原文里找文件名——历史快照格式多、体积大，按字符串匹配既稳又快。
 * 宽限期 12 小时：刚上传、设定还没保存的照片此刻就是「无引用」。任一文件读取失败则本轮放弃。
 */
function gcPortraits() {
  try {
    const files = fs.readdirSync(PORTRAITS_DIR).filter(f => PORTRAIT_FILE_RE.test(f))
    if (!files.length) return
    const referenced = new Set()
    const scan = p => {
      for (const m of fs
        .readFileSync(p, 'utf8')
        .matchAll(/"portrait"\s*:\s*"([A-Za-z0-9_-]{1,64}\.(?:png|jpg|webp|gif))"/g))
        referenced.add(m[1])
    }
    for (const dir of [NOVELS_DIR, HISTORY_DIR, RECYCLE_DIR]) {
      let entries = []
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const ent of entries) {
        const p = path.join(dir, ent.name)
        try {
          if (ent.isFile() && ent.name.endsWith('.json')) scan(p)
          else if (ent.isDirectory() && dir === RECYCLE_DIR) {
            for (const g of fs.readdirSync(p)) if (g.endsWith('.json')) scan(path.join(p, g))
          }
        } catch {
          appendLog('gc', `人物照片回收跳过：${p} 读取失败`)
          return
        }
      }
    }
    const cutoff = Date.now() - 12 * 3600 * 1000
    let removed = 0
    for (const f of files) {
      if (referenced.has(f)) continue
      const p = path.join(PORTRAITS_DIR, f)
      try {
        if (fs.statSync(p).mtimeMs < cutoff) {
          fs.unlinkSync(p)
          removed++
        }
      } catch {
        /* 单个文件删失败不影响其余 */
      }
    }
    if (removed) appendLog('gc', `回收无引用人物照片 ${removed} 个`)
  } catch (e) {
    appendLog('gc', `人物照片回收失败: ${String(e?.message || e)}`)
  }
}
