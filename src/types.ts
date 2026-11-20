export interface Character {
  id: string
  name: string
  role: string
  personality: string
  appearance: string
  background: string
  notes: string
  /** 作者上传的人物照片：服务端文件名，取图走 /api/portraits/<file>；空 / 缺省表示没有照片 */
  portrait?: string
}

export interface ChapterOutline {
  index: number
  title: string
  summary: string
  customPrompt: string
  /** 稳定标识，用于大纲增删后仍能对齐正文 */
  oid: string
}

export interface Chapter {
  index: number
  title: string
  content: string
  words: number
  /** draft = 停笔/中断时保留的草稿 */
  status: 'draft' | 'done'
  /** 关联的大纲条目；老数据可能为空 */
  oid?: string
  /** 对应大纲已被删除，暂存在末尾 */
  orphan?: boolean
}

/** 剧情线推进节点 */
export interface PlotBeat {
  id: string
  title: string
  summary: string
  /** 大致落点章号（0 = 未定） */
  chapter: number
}

/** 剧情线：主线/感情线/悬念线等并行线索，逐章写作时对齐推进 */
export interface Plotline {
  id: string
  name: string
  type: string
  goal: string
  description: string
  /** pending 待开始 | active 进行中 | paused 暂停 | done 已收束 */
  status: 'pending' | 'active' | 'paused' | 'done'
  beats: PlotBeat[]
  characters: string[]
}

export interface Novel {
  id: string
  title: string
  genre: string
  style: string
  pov: 'first' | 'third'
  targetWords: number
  chapterCount: number
  synopsis: string
  protagonist: Character
  characters: Character[]
  worldview: string
  elements: string
  extraRequirements: string
  authorStyleId: string
  templateId: string
  customPrompt: string
  /** 作者文风档案（markdown，自成一派）：由管家提炼或拆书产出，写作时优先于名家模仿 */
  styleProfile?: string
  /** 本书启用的写作技能 id 列表 */
  skillIds: string[]
  /** 剧情线 */
  plotlines: Plotline[]
  modelId: string
  masterOutline: string
  outline: ChapterOutline[]
  chapters: Chapter[]
  /** 写下一章时是否关联前文（生成页可自由开关；缺省视为开启） */
  linkContext?: boolean
  /** 手机阅读优化：多换行、口语化、主角六感代入 */
  mobileReading?: boolean
  /** 指定的参考小说文件夹路径（可选） */
  folderPath?: string
  /** 封面图文件名（服务端按 `<id>.<ext>` 存在 <data>/covers/）；空串=未上传 */
  coverFile?: string
  /** 封面上传时间戳，用于 URL 缓存失效 */
  coverAt?: number
  /** 最近一次参考作品分析的指纹快照；扫描时据此标注新/变化的文件 */
  refAnalyzed?: { at: number; files: Record<string, string> } | null
  createdAt: number
  updatedAt: number
  /** 保存时服务端可能返回的提示（如章节被重排） */
  warnings?: string[]
  /** 本次保存中用户明确删除的大纲 oid（服务端据此区分"删除"与"快照过期"） */
  removedOids?: string[]
}

export interface NovelMeta {
  id: string
  title: string
  genre: string
  updatedAt: number
  modelId: string
  /** 计划章节数（作者预期规模） */
  planCount: number
  /** 已排大纲章节数 */
  outlineCount: number
  chaptersDone: number
  /** 指定的参考小说文件夹路径 */
  folderPath?: string
  /** 封面图文件名（空串=未上传），书架页据此渲染封面卡片 */
  coverFile?: string
  /** 封面上传时间戳，用于 URL 缓存失效 */
  coverAt?: number
}

/** 参考小说分析结果 */
export interface ReferenceAnalysis {
  title: string
  characters: ParsedCharacter[]
  plotEvents: string
  plotSummary: string
  worldBuilding: string
  writingStyle: string
  keyRelationships: string
  themes: string
}

/** 敏感词 / 过审检测 */
export interface SensitiveHit {
  category: string
  categoryName: string
  /** 命中词（正则类是「手机号」等形态标签） */
  word: string
  /** 在该段文本中的出现位置 */
  index: number
  /** 命中前后各 18 字的上下文（换行已折叠为空格） */
  context: string
}
export interface SensitiveGroup {
  key: string
  label: string
  count: number
  hits: SensitiveHit[]
}
export interface SensitiveResult {
  ok: boolean
  total: number
  byCategory: Record<string, number>
  categoryNames: Record<string, string>
  groups: SensitiveGroup[]
}

export interface StylePreset {
  id: string
  name: string
  tag: string
  desc: string
  builtIn: boolean
  prompt?: string
  /** 契合的题材分类（用于按分类推荐） */
  genres?: string[]
  /** 风格标签（用于标题/简介关键词加权推荐） */
  tags?: string[]
}

/** 文风推荐结果（按题材+标题+简介打分） */
export interface StyleRecommendation {
  genre: string
  top: string
  picks: { id: string; name: string; score: number; reason: string }[]
}

export interface TemplatePreset {
  id: string
  name: string
  desc: string
  rules: string[]
  builtIn: boolean
}

export interface Presets {
  styles: StylePreset[]
  templates: TemplatePreset[]
  genres?: string[]
  genreMap?: Record<string, string[]>
}

/** 写作技能（Markdown 定义，每本书可选多个，注入每章生成提示词） */
export interface SkillPreset {
  id: string
  name: string
  description: string
  tags: string[]
  builtIn: boolean
  content?: string
  version?: string
  sourceRepo?: string
  sourceLicense?: string
}

/** AI 设定解析结果（各字段允许为空，应用时空值跳过不覆盖） */
export interface ParsedCharacter {
  name: string
  role: string
  personality: string
  appearance: string
  background: string
  notes: string
}

export interface ParsedSettings {
  title: string
  genre: string
  pov: '' | 'first' | 'third'
  synopsis: string
  protagonist: ParsedCharacter
  characters: ParsedCharacter[]
  worldview: string
  elements: string
  extraRequirements: string
}

export type ModelProvider = 'openai' | 'gemini' | 'chatgpt-subscription'
export type CodexModelConnectionState = 'connected' | 'reconnect' | 'account-mismatch' | 'unavailable'

export interface ModelConfig {
  id: string
  name: string
  baseUrl: string
  /** 列表接口返回的是掩码值（sk-***abcd）；提交时留空表示不修改 */
  apiKey: string
  hasKey?: boolean
  model: string
  temperature: number
  isDefault: boolean
  provider?: ModelProvider
  connectionRef?: string
  connectionState?: CodexModelConnectionState
  /** Gemini 3.x 思考等级（openai 系忽略）：LOW / MEDIUM / HIGH */
  thinkingLevel?: 'LOW' | 'MEDIUM' | 'HIGH'
  reasoningEffort?: 'default' | 'low' | 'medium' | 'high'
  /** 本地部署（Ollama / LM Studio / llama.cpp …）：无需 API Key，请求按端点串行 */
  local?: boolean
  /** 本地模型的上下文窗口（token）。填 0/不填表示按云端默认预算裁剪提示词 */
  contextTokens?: number
  /** 用户给该中转站自定义的名字（来自 station-names.json，空串则回落显示站点域名） */
  stationName?: string
}

export type JobType = 'outline' | 'chapter' | 'master' | 'detect' | 'inspire' | 'chat' | 'consistency' | 'deconstruct'

/** 管家动作权限级别：edit 内容编辑 / execute 触发任务 / danger 破坏性操作 */
export type ChatActionTier = 'edit' | 'execute' | 'danger' | 'unknown'
/** 管家动作执行结果状态 */
export type ChatActionStatus = 'applied' | 'started' | 'rejected' | 'failed'

/** 管家动作（应用前的旧值快照保存在 before，撤销时恢复） */
export interface ChatAction {
  type:
    | 'chapterPrompt'
    | 'outlineSummary'
    | 'outlineTitle'
    | 'element'
    | 'extraRequirement'
    | 'masterOutline'
    | 'synopsis'
    | 'title'
    | 'genre'
    | 'worldview'
    | 'chapterCount'
    | 'targetWords'
    | 'protagonist'
    | 'addCharacter'
    | 'updateCharacter'
    | 'removeCharacter'
    | 'addPlotline'
    | 'plotlineStatus'
    | 'removePlotline'
    | 'addPlotBeat'
    | 'applyStyle'
    | 'applyTemplate'
    | 'applySkill'
    | 'removeSkill'
    | 'addOutline'
    | 'deleteOutline'
    | 'pov'
    | 'linkContext'
    | 'mobileReading'
    | 'model'
    | 'chapterContent'
    | 'appendChapter'
    | 'addMaterial'
    | 'webSearch'
    | 'fetchPage'
    | 'editParagraph'
    | 'insertParagraph'
    | 'deleteParagraph'
    | 'generateMaster'
    | 'generateOutline'
    | 'rewriteOutline'
    | 'writeChapter'
    | 'generateAll'
    | 'continueChapter'
    | 'polishChapter'
    | 'reviseChapter'
    | 'deaiChapter'
    | 'detectAI'
    | 'inspire'
    | 'consistencyCheck'
    | 'deleteChapter'
    | 'clearChapters'
    | 'navigate'
    | 'deleteNovel'
  chapter: number
  text: string
  before: string
  label: string
  /** 权限级别（服务端回填） */
  tier?: ChatActionTier
  /** 执行状态（服务端回填）：applied 已应用 / started 已启动任务 / rejected 被拒 / failed 失败 */
  status?: ChatActionStatus
  /** 被拒或失败的原因 */
  reason?: string
  /** 触发的后台任务 id（started 时） */
  jobId?: string
  jobType?: string
  jobKind?: string
  /** 人物/剧情线类动作用到的名字，便于按名对齐撤销 */
  name?: string
  /** 段落类动作：撤销用的整章段落快照（与顺序无关，任意顺序撤销都准确） */
  snapshot?: string
  /** 是否命中预置清单（applyStyle/applyTemplate/applySkill 会用） */
  applied?: boolean
  rejected?: boolean
}

/** 联网检索来源（服务端执行 webSearch / fetchPage 后随消息返回） */
export interface ChatResearchSource {
  title: string
  url: string
  snippet?: string
  excerpt?: string
}

export interface ChatResearch {
  queries?: { query: string; provider?: string; error?: string }[]
  pages?: { url: string; error?: string }[]
  sources: ChatResearchSource[]
}

/** 创作管家的对话消息（按书持久化） */
export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  at: number
  /** 管家消息：已自动应用的代改动作（可撤销） */
  actions?: ChatAction[]
  /** 本轮联网检索的来源（有检索动作时才有） */
  research?: ChatResearch
  /**
   * 兜底标记：这条回复像是在交付正文，但没有附带任何落库动作。
   * 前端据此显示「写入成书」一键入口。
   */
  needsPersist?: boolean
  /** 用户消息附带的图片（文件落在 <data>/attachments/，聊天 JSON 只存文件名） */
  attachments?: ChatAttachment[]
}

/** 随管家消息发送的图片附件 */
export interface ChatAttachment {
  kind: 'image'
  /** 展示用文件名（原始文件名） */
  name: string
  /** 服务端文件名，取图走 /api/attachments/<file> */
  file: string
}

/** 研讨会话（多线索）：列表项元信息，不含消息体 */
export interface ChatSessionMeta {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  /** 消息条数 */
  count: number
  /** 最后一条消息的预览片段 */
  preview: string
}

/** 研讨会话完整内容 */
export interface ChatSession {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messages: ChatMessage[]
}

export interface RevisionProposal {
  id: string
  index: number
  oid?: string
  title: string
  original: string
  content: string
  status: 'pending' | 'accepted'
}

/** 写作 Agent 的本章执行方案（第一阶段产物） */
export interface ChapterBrief {
  goal?: string
  beats?: { label?: string; event?: string; purpose?: string }[]
  turningPoint?: string
  hook?: string
  callbacks?: string[]
  avoid?: string[]
}

/** 写作 Agent 的自检报告（第三阶段产物） */
export interface ChapterReview {
  score?: number
  summary?: string
  issues?: { type?: string; severity?: string; quote?: string; fix?: string }[]
}

export interface GenJob {
  previewOnly?: boolean
  proposals?: RevisionProposal[]
  /** 写作 Agent 阶段：plan → draft → review → revise → done（空串表示未启用） */
  stage?: '' | 'plan' | 'draft' | 'review' | 'revise' | 'done'
  stageNote?: string
  agent?: boolean
  agentDepth?: 'full' | 'draft'
  brief?: ChapterBrief | null
  review?: ChapterReview | null
  /** 是否真的执行了「按审稿意见修订」 */
  revised?: boolean
  id: string
  novelId: string
  type: JobType
  kind: 'write' | 'continue' | 'polish' | 'revise' | 'deai'
  status: 'running' | 'done' | 'error' | 'stopped'
  stream: string
  reasoning: string
  chapterIndex: number | null
  chapterIndices?: number[] | null
  extraPrompt?: string
  batch: boolean
  count?: number | null
  mode?: 'append' | 'replace' | 'rewrite' | null
  isFinal?: boolean | null
  /** 任务使用的模型 ID（覆盖小说默认模型） */
  modelId?: string | null
  /** 本章生成是否关联前文（null/undefined = 跟随作品偏好） */
  linkContext?: boolean | null
  /** 管家消息：本次回复自动应用的代改动作 */
  actions?: ChatAction[]
  /** 管家对话任务所属的会话 id（重连认领时据此切回对应会话，避免串会话） */
  sessionId?: string | null
  /** 任务结束后的结构化结果（如一致性检查的问题清单、拆书报告） */
  result?: unknown
  /** 拆书任务进度：已完成块数 / 总块数 */
  chunkDone?: number
  chunkTotal?: number
  /** 中断时是否已保存草稿 */
  savedDraft?: boolean
  /** 批量生成撞 MAX_BATCH 上限自动暂停（status 仍是 done，但没写完） */
  paused?: boolean
  /** 模型输出是否因 max_tokens 上限被截断（截断时正文按草稿保存） */
  truncated?: boolean
  /** 上游返回的 finish_reason（stop/length/MAX_TOKENS…） */
  finishReason?: string | null
  /** 本次任务最终写入的正文单位数（不含空白） */
  outputChars?: number
  error: string
  /** 上游模型 HTTP 错误状态（如 400/403），用于前端区分本地服务与模型权限问题 */
  errorStatus?: number | null
  /** 机器可读错误码，例如 MODEL_FORBIDDEN / MODEL_BAD_REQUEST */
  errorCode?: string
  startedAt: number
  endedAt: number | null
}

/**
 * 任务进度的增量响应（GET /api/jobs/:id?since=…）。
 *
 * 除 delta 外的字段与 GenJob 一致，但没有 stream / reasoning 全量字段——
 * 那部分改由 delta 里的新增片段 + 游标表达，避免轮询反复重传已生成的正文。
 */
export interface JobDelta extends Omit<GenJob, 'stream' | 'reasoning'> {
  delta: {
    /** 本次新增的正文片段（调用方 append 到已有内容后） */
    stream: string
    /** 本次新增的思考片段 */
    reasoning: string
    /** 服务端当前的正文总长度，作为下次请求的游标 */
    streamLen: number
    /** 服务端当前的思考总长度 */
    reasoningLen: number
  }
}

export interface HistoryEntry {
  id: string
  at: number
  label: string
  chapters: number
  words: number
}

export interface NovelStats {
  chapters: number
  drafts: number
  outlineCount: number
  words: number
  avgWords: number
  /** 每章目标字数（0 = 未设定） */
  targetWords: number
  /** 字数偏离目标 ±30% 的章节（波动告警） */
  deviations: { index: number; title: string; words: number; target: number; deviation: number }[]
  progress: number
  longest: Chapter | null
  updatedAt: number
}

export interface ReplaceHit {
  index: number
  title: string
  count: number
}

/** 应用偏好（阅读器外观与排版，不含密钥） */
export interface AppPrefs {
  fontSize: number
  lineHeight: number
  autoBackup: boolean
  /** 存储诊断：dir=当前生效数据目录，relocated=原目录不可写时的回退来源（空=未回退） */
  storage?: { dir: string; relocated: string }
  /** 正文字体：song 宋体 / hei 黑体 / kai 楷体 */
  fontFamily: string
  /** 字间距（em） */
  letterSpacing: number
  /** 段间距（em） */
  paragraphSpacing: number
  /** 首行缩进（em，排版视图生效） */
  indent: number
  /** 正文对齐：left 左对齐 / justify 两端对齐 */
  align: string
  /** 正文阅读宽度（rem） */
  readingWidth: number
}

/** 回收站条目 */
export interface RecycleItem {
  id: string
  title: string
  genre: string
  deletedAt: number
  libraryDir: string
}

/** 素材 / 草稿条目（跨书共享） */
export interface ShelfItem {
  id: string
  title: string
  content: string
  kind: 'material' | 'draft'
  tags: string[]
  createdAt: number
  updatedAt: number
}

/** 扫描参考文件夹返回的文件条目 */
export interface RefFile {
  name: string
  path: string
  words: number
  preview: string
  /** 与上次分析相比：same 未变 / new 新增 / changed 内容变化 */
  status: 'same' | 'new' | 'changed'
}

/** 一致性检查问题 */
export interface ConsistencyIssue {
  severity: 'high' | 'medium' | 'low' | 'unknown'
  location: string
  issue: string
  evidence: string
  suggestion: string
}

/** 知识库（对标 ima）：可检索文档库里的单篇文档 */
export interface KbDoc {
  id: string
  name: string
  chars: number
  chunks: number
  addedAt: number
}

/** 知识库元信息 */
export interface KbMeta {
  id: string
  name: string
  description: string
  createdAt: number
  docs: KbDoc[]
  chunkCount: number
}

/** 知识库检索命中块（带来源，便于模型标注引用） */
export interface KbHit {
  kbId: string
  kbName: string
  docName: string
  text: string
  score: number
}

/** 知识库问答面板的一条历史（来源只保留文档名与摘要，够展示引用即可） */
export interface KbQaEntry {
  id: string
  q: string
  a: string
  hits: { docName: string; text: string }[]
  modelId: string
  at: number
}
