import type {
  Chapter,
  Novel,
  NovelMeta,
  Presets,
  StylePreset,
  StyleRecommendation,
  TemplatePreset,
  SkillPreset,
  Plotline,
  ModelConfig,
  GenJob,
  JobDelta,
  HistoryEntry,
  NovelStats,
  ReplaceHit,
  ParsedSettings,
  AppPrefs,
  ChatAction,
  ChatSession,
  ChatSessionMeta,
  ReferenceAnalysis,
  RecycleItem,
  ShelfItem,
  RefFile,
  ChatAttachment,
  KbDoc,
  KbHit,
  KbMeta,
  KbQaEntry,
  SensitiveResult
} from '../types'
import { describeCodexError, describeHttpError } from './errors'

// API 错误保留 HTTP 状态，便于区分本地服务、会话存储和上游模型错误。
export class ApiError extends Error {
  readonly status: number
  readonly code?: string

  constructor(message: string, status: number, code?: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

// 后端返回 404（任务已过期）时抛出可识别的错误，前端据此清理轮询
export class NotFoundError extends ApiError {
  constructor(message: string) {
    super(message, 404)
    this.name = 'NotFoundError'
  }
}

async function http<T>(url: string, options?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      ...options
    })
  } catch {
    throw new Error('无法连接本地服务，请重启应用后再试')
  }
  if (!res.ok) {
    let msg = `请求失败 (${res.status})`
    let code: string | undefined
    try {
      const j = await res.json()
      if (j.error) msg = j.error
      if (typeof j.code === 'string') code = j.code
    } catch {}
    if (code?.startsWith('CODEX_')) throw new ApiError(describeCodexError(code, msg), res.status, code)
    // 状态码 → 中文提示 的映射收口在 lib/errors.ts，避免与上游模型错误的文案各写一份
    msg = describeHttpError(res.status, msg)
    if (res.status === 404) throw new NotFoundError(msg)
    throw new ApiError(msg, res.status, code)
  }
  return res.json() as Promise<T>
}

export const api = {
  getNovels: () => http<NovelMeta[]>('/api/novels'),
  getNovel: (id: string) => http<Novel>(`/api/novels/${id}`),
  /** 章节目录（不含正文）：命令面板搜章节等场景，千章书不必拉全量正文 */
  getNovelMeta: (id: string) => http<Novel>(`/api/novels/${id}?meta=1`),
  /** 每日码字统计（全部书或按书过滤），键为 'YYYY-MM-DD' */
  getDailyStats: (opts?: { novelId?: string; days?: number }) =>
    http<{ daily: Record<string, number> }>(
      `/api/stats/daily?days=${opts?.days ?? 370}${opts?.novelId ? `&novelId=${encodeURIComponent(opts.novelId)}` : ''}`
    ),
  /** 敏感词 / 过审检测（离线词典，只提示不拦截）：本章检测传 1 项，全书检测传每章 1 项 */
  checkSensitive: (items: { key: string; label: string; text: string }[]) =>
    http<SensitiveResult>('/api/analysis/sensitive', { method: 'POST', body: JSON.stringify({ items }) }),
  createNovel: (data: { title: string; genre: string; modelId?: string; folderPath?: string }) =>
    http<Novel>('/api/novels', { method: 'POST', body: JSON.stringify(data) }),
  updateNovel: (id: string, novel: Novel) =>
    http<Novel>(`/api/novels/${id}`, { method: 'PUT', body: JSON.stringify(novel) }),
  /** 轻量偏好更新（如「关联前文」「手机阅读」开关）：只写指定字段，不影响并行生成中的整书数据 */
  setNovelPrefs: (id: string, prefs: { linkContext?: boolean; mobileReading?: boolean; modelId?: string }) =>
    http<{ ok: boolean; linkContext: boolean; mobileReading: boolean; modelId: string }>(`/api/novels/${id}/prefs`, {
      method: 'PUT',
      body: JSON.stringify(prefs)
    }),
  createChapter: (id: string) =>
    http<{ chapter: Chapter }>(`/api/novels/${id}/chapters`, { method: 'POST', body: '{}' }),
  deleteNovel: (id: string) => http<{ ok: boolean }>(`/api/novels/${id}`, { method: 'DELETE' }),

  // 作品封面
  /**
   * 上传封面：直接发原始二进制，**刻意不走 http()**。
   * http() 固定 Content-Type: application/json，走 json 就得把图片 base64 内联（体积 +33%）；
   * 后端对这条路由单挂了 express.raw({ type: 'image/*' })，直接收原始字节更省更快。
   */
  uploadCover: async (id: string, file: File): Promise<{ ok: boolean; novel: Novel }> => {
    let res: Response
    try {
      res = await fetch(`/api/novels/${id}/cover`, {
        method: 'POST',
        headers: { 'Content-Type': file.type || 'image/png' },
        body: file
      })
    } catch {
      throw new Error('无法连接本地服务，请重启应用后再试')
    }
    if (!res.ok) {
      let msg = `上传失败 (${res.status})`
      try {
        const j = await res.json()
        if (j.error) msg = j.error
      } catch {}
      throw new ApiError(describeHttpError(res.status, msg), res.status)
    }
    return res.json() as Promise<{ ok: boolean; novel: Novel }>
  },
  /** 封面直链；带 coverAt 做缓存失效，重新上传后 URL 变化，不会看到旧图 */
  coverUrl: (coverFile?: string, coverAt?: number) =>
    coverFile ? `/api/covers/${encodeURIComponent(coverFile)}${coverAt ? `?v=${coverAt}` : ''}` : '',

  // 管家对话附件（图片）
  /** 上传对话图片附件：直接发原始二进制（理由同 uploadCover —— 免 base64 内联膨胀） */
  uploadAttachment: async (file: File): Promise<{ ok: boolean; file: string; url: string }> => {
    let res: Response
    try {
      res = await fetch('/api/attachments', {
        method: 'POST',
        headers: { 'Content-Type': file.type || 'image/png' },
        body: file
      })
    } catch {
      throw new Error('无法连接本地服务，请重启应用后再试')
    }
    if (!res.ok) {
      let msg = `上传失败 (${res.status})`
      try {
        const j = await res.json()
        if (j.error) msg = j.error
      } catch {}
      throw new ApiError(describeHttpError(res.status, msg), res.status)
    }
    return res.json() as Promise<{ ok: boolean; file: string; url: string }>
  },
  /** 附件图片直链（文件名一次性、内容不变，服务端给了长缓存） */
  attachmentUrl: (file: string) => `/api/attachments/${encodeURIComponent(file)}`,

  // 人物照片
  /** 上传人物照片：只落盘并回传文件名，由设定页写进草稿随设定一起保存（理由同 uploadCover，发原始二进制） */
  uploadPortrait: async (file: File): Promise<{ ok: boolean; file: string }> => {
    let res: Response
    try {
      res = await fetch('/api/portraits', {
        method: 'POST',
        headers: { 'Content-Type': file.type || 'image/png' },
        body: file
      })
    } catch {
      throw new Error('无法连接本地服务，请重启应用后再试')
    }
    if (!res.ok) {
      let msg = `上传失败 (${res.status})`
      try {
        const j = await res.json()
        if (j.error) msg = j.error
      } catch {}
      throw new ApiError(describeHttpError(res.status, msg), res.status)
    }
    return res.json() as Promise<{ ok: boolean; file: string }>
  },
  /** 人物照片直链（文件名一次性，换照片就换文件名，不需要额外的缓存失效参数） */
  portraitUrl: (file?: string) => (file ? `/api/portraits/${encodeURIComponent(file)}` : ''),

  // 知识库（对标 ima：可检索、能被 AI 引用的文档库）
  listKb: () => http<KbMeta[]>('/api/kb'),
  createKb: (name: string, description?: string) =>
    http<{ ok: boolean; kb: KbMeta }>('/api/kb', { method: 'POST', body: JSON.stringify({ name, description }) }),
  deleteKb: (id: string) => http<{ ok: boolean }>(`/api/kb/${id}`, { method: 'DELETE' }),
  /** 加文档：贴文本、传 base64（浏览器选的文件），或给 folderPath 批量导入其中的 .txt / .md */
  addKbDoc: (id: string, data: { name?: string; content?: string; base64?: string; folderPath?: string }) =>
    http<{
      ok: boolean
      doc?: KbDoc
      chunks?: number
      imported?: number
      results?: { name: string; ok: boolean; chunks?: number; error?: string }[]
    }>(`/api/kb/${id}/docs`, { method: 'POST', body: JSON.stringify(data) }),
  deleteKbDoc: (id: string, docId: string) =>
    http<{ ok: boolean }>(`/api/kb/${id}/docs/${docId}`, { method: 'DELETE' }),
  searchKb: (q: string, topK = 6, kbId?: string) =>
    http<{ hits: KbHit[]; used: number }>(
      `/api/kb/search?q=${encodeURIComponent(q)}&topK=${topK}${kbId ? `&kb=${encodeURIComponent(kbId)}` : ''}`
    ),
  getKbQa: (id: string) => http<KbQaEntry[]>(`/api/kb/${id}/qa`),
  clearKbQa: (id: string) => http<{ ok: boolean }>(`/api/kb/${id}/qa`, { method: 'DELETE' }),
  askKb: (data: { kbId: string; question: string; modelId?: string }) =>
    http<{ jobId: string }>('/api/kb/ask', { method: 'POST', body: JSON.stringify(data) }),

  // 多模型管理
  getModels: () => http<ModelConfig[]>('/api/models'),
  syncSubscriptionModels: () => http<{ count: number }>('/api/models/subscription/sync', { method: 'POST' }),
  createModel: (m: Partial<ModelConfig>) =>
    http<ModelConfig>('/api/models', { method: 'POST', body: JSON.stringify(m) }),
  updateModel: (id: string, m: Partial<ModelConfig>) =>
    http<ModelConfig>(`/api/models/${id}`, { method: 'PUT', body: JSON.stringify(m) }),
  deleteModel: (id: string) => http<{ ok: boolean }>(`/api/models/${id}`, { method: 'DELETE' }),
  batchDeleteModels: (ids: string[]) =>
    http<{ ok: boolean; deleted: number }>('/api/models', { method: 'DELETE', body: JSON.stringify({ ids }) }),
  testModel: (id: string) =>
    http<{ ok: boolean; reply?: string; error?: string }>(`/api/models/${id}/test`, { method: 'POST' }),
  probeModels: (baseUrl: string, apiKey: string, provider?: string, local?: boolean) =>
    http<{ ok: boolean; models?: string[]; error?: string; runtime?: string }>('/api/models/probe', {
      method: 'POST',
      body: JSON.stringify({ baseUrl, apiKey, provider, local })
    }),
  // 本地推理服务：扫描本机常见端口 → 批量加入模型（无需密钥）
  scanLocalModels: (extra: string[] = []) =>
    http<{
      ok: boolean
      found: {
        baseUrl: string
        runtime?: string
        models: string[]
        latencyMs?: number
        presetId?: string
        hint?: string
        error?: string
      }[]
    }>('/api/models/local/scan', { method: 'POST', body: JSON.stringify({ extra }) }),
  addLocalModels: (baseUrl: string, models: string[], contextTokens?: number) =>
    http<{ ok: boolean; added: number; skipped: number }>('/api/models/local/add', {
      method: 'POST',
      body: JSON.stringify({ baseUrl, models, contextTokens })
    }),
  importModels: (baseUrl: string, apiKey: string, provider?: string) =>
    http<{ ok: boolean; added: number; skipped: number }>('/api/models/import', {
      method: 'POST',
      body: JSON.stringify({ baseUrl, apiKey, provider })
    }),
  importGroupModels: (baseUrl: string) =>
    http<{ ok: boolean; baseUrl?: string; added: number; skipped: number }>('/api/models/import-group', {
      method: 'POST',
      body: JSON.stringify({ baseUrl })
    }),
  renameStation: (baseUrl: string, name: string, provider?: string) =>
    http<{ ok: boolean; stationName: string }>('/api/models/stations/name', {
      method: 'POST',
      body: JSON.stringify({ baseUrl, name, provider })
    }),

  // AI 能力
  parseSettings: (novelId: string, modelId: string, text: string) =>
    http<{ ok: boolean; parsed: ParsedSettings }>('/api/ai/parse-settings', {
      method: 'POST',
      body: JSON.stringify({ novelId, modelId, text })
    }),

  // 预设
  getPresets: () => http<Presets>('/api/presets'),
  /** 按题材+标题+简介推荐文风（无状态，可传未保存草稿字段） */
  recommendStyle: (data: { genre?: string; title?: string; synopsis?: string; style?: string }) =>
    http<StyleRecommendation>('/api/recommend-style', { method: 'POST', body: JSON.stringify(data) }),
  saveCustomStyle: (s: { id?: string; name: string; tag: string; desc: string; prompt: string }) =>
    http<StylePreset>('/api/presets/styles', { method: 'POST', body: JSON.stringify(s) }),
  updateCustomStyle: (id: string, s: { name: string; tag: string; desc: string; prompt: string }) =>
    http<StylePreset>(`/api/presets/styles/${id}`, { method: 'PUT', body: JSON.stringify(s) }),
  deleteCustomStyle: (id: string) => http<{ ok: boolean }>(`/api/presets/styles/${id}`, { method: 'DELETE' }),
  saveCustomTemplate: (t: { id?: string; name: string; desc: string; rules: string | string[] }) =>
    http<TemplatePreset>('/api/presets/templates', { method: 'POST', body: JSON.stringify(t) }),
  updateCustomTemplate: (id: string, t: { name: string; desc: string; rules: string | string[] }) =>
    http<TemplatePreset>(`/api/presets/templates/${id}`, { method: 'PUT', body: JSON.stringify(t) }),
  deleteCustomTemplate: (id: string) => http<{ ok: boolean }>(`/api/presets/templates/${id}`, { method: 'DELETE' }),

  // 写作技能（Markdown 定义，每本书可选多个）
  getSkills: () => http<SkillPreset[]>('/api/skills'),
  saveCustomSkill: (s: { id?: string; name: string; description: string; tags: string[]; content: string }) =>
    http<SkillPreset>('/api/skills', { method: 'POST', body: JSON.stringify(s) }),
  updateCustomSkill: (id: string, s: { name: string; description: string; tags: string[]; content: string }) =>
    http<SkillPreset>(`/api/skills/${id}`, { method: 'PUT', body: JSON.stringify(s) }),
  deleteCustomSkill: (id: string) => http<{ ok: boolean }>(`/api/skills/${id}`, { method: 'DELETE' }),
  importSkills: (items: { name?: string; text: string }[]) =>
    http<{ ok: boolean; saved: SkillPreset[]; failed: string[]; skipped?: string[] }>('/api/skills/import', {
      method: 'POST',
      body: JSON.stringify({ items })
    }),

  // 剧情线（AI 生成 + 手动编辑，逐章写作时对齐推进）
  generatePlotlines: (novelId: string, mode: 'replace' | 'append', modelId?: string) =>
    http<{ ok: boolean; plotlines: Plotline[] }>('/api/ai/plotlines', {
      method: 'POST',
      body: JSON.stringify({ novelId, mode, modelId })
    }),

  // 后台任务：总纲/大纲/正文的生成入口在「本书管家」与工作台动作里，这里只保留按章的续写/润色/修改/批量精修
  /** 整章生成（写作页 AI 面板）：previewOnly 时只产出候选稿，不覆盖正文 */
  startChapterJob: (
    novelId: string,
    chapterIndex: number,
    opts: {
      kind?: 'write' | 'continue' | 'polish' | 'revise'
      extraPrompt?: string
      modelId?: string
      linkContext?: boolean
      agent?: boolean
      agentDepth?: 'full' | 'draft'
      previewOnly?: boolean
    } = {}
  ) =>
    http<{ jobId: string }>('/api/generate/chapter', {
      method: 'POST',
      body: JSON.stringify({ novelId, chapterIndex, ...opts })
    }),
  startContinueJob: (novelId: string, chapterIndex: number, extraPrompt?: string, modelId?: string) =>
    http<{ jobId: string }>('/api/generate/continue', {
      method: 'POST',
      body: JSON.stringify({ novelId, chapterIndex, extraPrompt, modelId })
    }),
  startPolishJob: (novelId: string, chapterIndex: number, extraPrompt?: string, modelId?: string) =>
    http<{ jobId: string }>('/api/generate/polish', {
      method: 'POST',
      body: JSON.stringify({ novelId, chapterIndex, extraPrompt, modelId })
    }),
  startReviseJob: (novelId: string, chapterIndex: number, issue: string, modelId?: string) =>
    http<{ jobId: string }>('/api/generate/revise', {
      method: 'POST',
      body: JSON.stringify({ novelId, chapterIndex, issue, modelId })
    }),
  startBatchRefine: (
    novelId: string,
    mode: 'continue' | 'polish' | 'revise' | 'deai',
    chapterIndices: number[],
    extraPrompt?: string,
    modelId?: string,
    previewOnly = true
  ) =>
    http<{ jobId: string }>('/api/generate/batch-refine', {
      method: 'POST',
      body: JSON.stringify({ novelId, mode, chapterIndices, extraPrompt, modelId, previewOnly })
    }),
  acceptProposal: (jobId: string, proposalId: string) =>
    http<{ ok: boolean }>('/api/jobs/' + jobId + '/proposals/' + proposalId + '/accept', {
      method: 'POST',
      body: '{}'
    }),
  detectAI: (novelId: string, chapterIndices: number[], modelId?: string) =>
    http<{ jobId: string }>('/api/ai/detect', {
      method: 'POST',
      body: JSON.stringify({ novelId, chapterIndices, modelId })
    }),
  // 创作管家（独立线程，可与生成并行；多轮对话按书持久化；支持代改动作）
  // 创作研讨：多会话（多线索）。列表只取元信息，切换会话再拉完整消息。
  listChatSessions: (novelId: string) =>
    http<{ activeId: string; sessions: ChatSessionMeta[] }>(`/api/novels/${novelId}/chat`),
  createChatSession: (novelId: string, title?: string) =>
    http<{ session: ChatSession; activeId: string }>(`/api/novels/${novelId}/chat`, {
      method: 'POST',
      body: JSON.stringify({ title })
    }),
  getChatSession: (novelId: string, sid: string) =>
    http<{ session: ChatSession }>(`/api/novels/${novelId}/chat/${sid}`),
  renameChatSession: (novelId: string, sid: string, title: string) =>
    http<{ ok: boolean; session: ChatSessionMeta }>(`/api/novels/${novelId}/chat/${sid}`, {
      method: 'PATCH',
      body: JSON.stringify({ title })
    }),
  deleteChatSession: (novelId: string, sid: string) =>
    http<{ ok: boolean; activeId: string; sessions: ChatSessionMeta[] }>(`/api/novels/${novelId}/chat/${sid}`, {
      method: 'DELETE'
    }),
  sendChat: (
    novelId: string,
    message: string,
    modelId?: string,
    applyActions?: boolean,
    allowDangerous?: boolean,
    sessionId?: string,
    attachments?: ChatAttachment[]
  ) =>
    http<{ jobId: string; sessionId: string }>('/api/chat', {
      method: 'POST',
      body: JSON.stringify({ novelId, message, modelId, applyActions, allowDangerous, sessionId, attachments })
    }),
  undoChatAction: (novelId: string, action: ChatAction) =>
    http<{ ok: boolean }>(`/api/novels/${novelId}/chat/undo`, { method: 'POST', body: JSON.stringify({ action }) }),
  /** 兜底落库：把一条管家回复的正文写进章节（模型偶尔忘记输出动作块时的一键入口） */
  persistChatToChapter: (novelId: string, chapter: number, text: string, mode: 'replace' | 'append' = 'replace') =>
    http<{ ok: boolean; chapter: unknown }>(`/api/novels/${novelId}/chat/persist`, {
      method: 'POST',
      body: JSON.stringify({ chapter, text, mode })
    }),
  clearChat: (novelId: string) =>
    http<{ ok: boolean; activeId: string; sessions: ChatSessionMeta[] }>(`/api/novels/${novelId}/chat`, {
      method: 'DELETE'
    }),
  updateChapter: (
    novelId: string,
    index: number,
    data: { title?: string; content?: string; oid?: string; expectedContent?: string; expectedTitle?: string }
  ) => http<{ ok: boolean }>(`/api/novels/${novelId}/chapters/${index}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteChapter: (novelId: string, index: number) =>
    http<{ ok: boolean }>(`/api/novels/${novelId}/chapters/${index}`, { method: 'DELETE' }),
  /** 一键排版：套用标准版式（首行缩进、段间空行、清理多余空白）。chapterIndex 缺省时对全书生效 */
  typeset: (novelId: string, opts?: { chapterIndex?: number; indent?: number }) =>
    http<{ ok: boolean; changed: number; total: number; paragraphs: number; indent: number; unchanged?: boolean }>(
      `/api/novels/${novelId}/typeset`,
      { method: 'POST', body: JSON.stringify(opts || {}) }
    ),
  importNovel: (id: string, text: string, replace: boolean) =>
    http<{ ok: boolean; chapters: number; words: number }>(`/api/novels/${id}/import`, {
      method: 'POST',
      body: JSON.stringify({ text, replace })
    }),
  getJob: (jobId: string) => http<GenJob>(`/api/jobs/${jobId}`),
  /**
   * 增量拉取任务进度。
   *
   * 轮询写长文时，每 1.2 秒整包拉一次会把已生成的正文反复重传（4000 字的章节点
   * 三十几次轮询下来约 100KB 重复流量）。这里带上已收到的字符数，服务端只回新增的
   * 那一截（见 server/app.mjs 的 jobDelta），调用方 append 即可。
   */
  getJobDelta: (jobId: string, streamLen: number, reasoningLen: number) =>
    http<JobDelta>(`/api/jobs/${jobId}?since=${streamLen},${reasoningLen}`),
  stopJob: (jobId: string) => http<GenJob>(`/api/jobs/${jobId}/stop`, { method: 'POST' }),
  getNovelJob: (novelId: string) => http<GenJob | null>(`/api/novels/${novelId}/job`),
  getNovelJobs: (novelId: string) => http<GenJob[]>(`/api/novels/${novelId}/jobs`),

  // 版本历史
  getHistory: (novelId: string) => http<HistoryEntry[]>(`/api/novels/${novelId}/history`),
  restoreHistory: (novelId: string, hid: string) =>
    http<{ ok: boolean }>(`/api/novels/${novelId}/history/${hid}/restore`, { method: 'POST' }),

  // 阅读器偏好
  getSettings: () => http<AppPrefs>('/api/settings'),
  saveSettings: (s: Partial<AppPrefs>) => http<AppPrefs>('/api/settings', { method: 'PUT', body: JSON.stringify(s) }),

  // 查找替换 / 统计 / 备份
  findReplace: (
    novelId: string,
    body: { find: string; replace?: string; scope?: 'all' | 'chapter'; chapterIndex?: number; dryRun?: boolean }
  ) =>
    http<{ ok: boolean; count: number; hits: ReplaceHit[] }>(`/api/novels/${novelId}/replace`, {
      method: 'POST',
      body: JSON.stringify(body)
    }),
  getStats: (novelId: string) => http<NovelStats>(`/api/novels/${novelId}/stats`),
  backupUrl: () => '/api/backup',
  // 下载备份：不用 <a href>，因为生产态后端要 x-novel-token，而浏览器发起的
  // 导航请求不会带自定义头（Electron 的 onBeforeSendHeaders 也只作用于渲染进程
  // 发起的 fetch/XHR 链路）。这里统一走 fetch → blob → 触发保存。
  downloadBackup: async (): Promise<{ blob: Blob; filename: string }> => {
    let res: Response
    try {
      res = await fetch('/api/backup')
    } catch {
      throw new Error('无法连接本地服务，请重启应用后再试')
    }
    if (!res.ok) {
      let msg = `导出备份失败 (${res.status})`
      try {
        const j = await res.json()
        if (j.error) msg = j.error
      } catch {}
      throw new Error(describeHttpError(res.status, msg))
    }
    const cd = res.headers.get('Content-Disposition') || ''
    const m = /filename\*=UTF-8''([^;]+)/.exec(cd)
    const filename = m ? decodeURIComponent(m[1]) : `小说工坊备份_${new Date().toISOString().slice(0, 10)}.json`
    return { blob: await res.blob(), filename }
  },
  restoreBackup: (data: unknown) =>
    http<{ ok: boolean; restored: number }>('/api/backup/restore', { method: 'POST', body: JSON.stringify(data) }),

  // 参考小说分析
  scanFolder: (novelId: string, folderPath: string) =>
    http<{ ok: boolean; files: RefFile[]; count: number; newCount: number; hasNew: boolean }>(
      `/api/novels/${novelId}/scan-folder`,
      {
        method: 'POST',
        body: JSON.stringify({ folderPath })
      }
    ),
  analyzeReferences: (novelId: string, opts?: { folderPath?: string; modelId?: string }) =>
    http<{ ok: boolean; analysis: ReferenceAnalysis }>(`/api/novels/${novelId}/analyze-references`, {
      method: 'POST',
      body: JSON.stringify(opts || {})
    }),
  /**
   * 拆书（对标星月）：逐块拆解参考作品的结构 / 节奏 / 爽点 / 钩子，汇总成一份报告并落盘。
   * 与 analyzeReferences 的区别：那条提取人物设定（给同人文用），这条逆向写作技法（给仿写用）。
   */
  /** 启动拆书后台任务（202 + jobId）：逐块逆向技法后汇总成报告，进度在 job.stream，结果在 job.result */
  startDeconstructJob: (novelId: string, opts?: { folderPath?: string; modelId?: string }) =>
    http<{ jobId: string }>(`/api/novels/${novelId}/deconstruct-references`, {
      method: 'POST',
      body: JSON.stringify(opts || {})
    }),
  /** 把拆书报告写进本书风格档案 —— 写入后所有正文生成都会以它校准（「学它的写法」的落点） */
  applyDeconstruct: (novelId: string, report: string) =>
    http<{ ok: boolean; novel: Novel }>(`/api/novels/${novelId}/apply-deconstruct`, {
      method: 'POST',
      body: JSON.stringify({ report })
    }),
  exportUrl: (id: string, fmt: 'md' | 'txt') => `/api/novels/${id}/export?format=${fmt}`,

  // 导出 EPUB / HTML（返回下载直链）
  exportEpubUrl: (id: string) => `/api/novels/${id}/export/epub`,
  exportHtmlUrl: (id: string) => `/api/novels/${id}/export/html`,

  // 回收站（删除 = 软删，可恢复；彻底删除才不可逆）
  getRecycle: () => http<RecycleItem[]>('/api/recycle'),
  restoreRecycle: (id: string) =>
    http<{ ok: boolean; title: string }>(`/api/recycle/${id}/restore`, { method: 'POST' }),
  purgeRecycle: (id: string) => http<{ ok: boolean }>(`/api/recycle/${id}`, { method: 'DELETE' }),

  // 一致性检查（全书设定与正文矛盾检测；result 挂在任务上）
  startConsistency: (novelId: string, modelId?: string) =>
    http<{ jobId: string }>('/api/ai/consistency', { method: 'POST', body: JSON.stringify({ novelId, modelId }) }),

  // 素材与草稿库（跨书共享）
  getShelf: (kind?: 'material' | 'draft') => http<ShelfItem[]>(`/api/shelf${kind ? `?kind=${kind}` : ''}`),
  createShelf: (data: { title: string; content: string; kind: 'material' | 'draft'; tags?: string[] }) =>
    http<ShelfItem>('/api/shelf', { method: 'POST', body: JSON.stringify(data) }),
  updateShelf: (id: string, data: Partial<Pick<ShelfItem, 'title' | 'content' | 'kind' | 'tags'>>) =>
    http<ShelfItem>(`/api/shelf/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteShelf: (id: string) => http<{ ok: boolean }>(`/api/shelf/${id}`, { method: 'DELETE' })
}
