// Butler 页的常量与纯工具函数（从 Butler.tsx 拆出）。
import type { ChatAction, Novel } from '../../types'
import type { QuickPrompt } from '../../components/Composer'

// 错误文案已收口到 lib/errors.ts（前后端共用同一套状态码映射）。这里保留转出口，
// 让 Butler 侧原有的 import 路径不变；后续新增调用请直接从 lib/errors 引入。
export { describeModelError } from '../../lib/errors'
import type { AgentFlags } from '../../lib/chatDraft'

// 常用开场：想不到怎么问时点一下即可开始
export const QUICK_PROMPTS: QuickPrompt[] = [
  {
    label: '剧情走向',
    icon: 'route',
    text: '请结合当前进度，给我接下来的剧情走向方案：给 2~3 个可选方向，每个写清关键事件、冲突转折和爽点，并说明各自优劣与对总纲的影响。'
  },
  {
    label: '设计爽点',
    icon: 'zap',
    text: '最近剧情有点平。请帮我设计几个爽点桥段（打脸/扮猪吃虎/意外反转等），具体到情节怎么安排，要能直接填进本章指令的程度。'
  },
  {
    label: '节奏诊断',
    icon: 'pulse',
    text: '请根据大纲与已写正文，诊断当前节奏：哪里太拖、哪里太赶，给出具体的调整建议。'
  },
  {
    label: '过稿评估',
    icon: 'check',
    text: '请以番茄小说签约编辑的视角评估这本书：类型与签约难度、50字简纲、人物设定三要素、老套路+新设定的创新点、核心看点，最后按「过稿率/代入感/差异化」三类给出可操作建议。'
  },
  {
    label: '伏笔盘点',
    icon: 'branch',
    text: '请根据总纲与已有章节，盘点当前已埋设、未回收的伏笔清单，并建议每条伏笔的最佳回收时机。'
  },
  {
    label: '降AI示例',
    icon: 'eraser',
    text: '请指出我最近一章正文里最重的 3 处 AI 痕迹（模板句/均匀节奏/空泛形容词/总结式收尾），每处给出原文和更有人味的改写示例。'
  }
]

/* 管家页内线性图标：1.5 描边、currentColor，与外壳图标同一套笔触 */
export function BIcon({ name, size = 16 }: { name: string; size?: number }) {
  const p = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    focusable: false
  }
  switch (name) {
    case 'panel':
      return (
        <svg {...p}>
          <rect x="4" y="5" width="16" height="14" rx="2" />
          <path d="M10 5v14" />
        </svg>
      )
    case 'panel-right':
      return (
        <svg {...p}>
          <rect x="4" y="5" width="16" height="14" rx="2" />
          <path d="M14 5v14" />
        </svg>
      )
    case 'user':
      return (
        <svg {...p}>
          <circle cx="12" cy="8.5" r="3.6" />
          <path d="M5 19.5c1.2-3.4 3.9-5.2 7-5.2s5.8 1.8 7 5.2" />
        </svg>
      )
    case 'knot':
      // 盘长结：AI 头像里的鎏金徽记
      return (
        <svg {...p}>
          <path d="M12 3.5 20.5 12 12 20.5 3.5 12z" />
          <path d="M8 7.8 16.2 16M16 7.8 7.8 16" />
          <path d="M9.9 5.6 18.4 14.1M14.1 5.6 5.6 14.1M5.6 9.9l8.5 8.5M18.4 9.9l-8.5 8.5" opacity="0.55" />
        </svg>
      )
    case 'close':
      return (
        <svg {...p}>
          <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
        </svg>
      )
    case 'quote':
      // 引用正文：一页稿纸 + 引号
      return (
        <svg {...p}>
          <path d="M6 3.5h8.5L19 8v12.5H6z" />
          <path d="M14.5 3.5V8H19" />
          <path d="M9.2 12.2h2.2v2.4c0 1.2-.6 2-1.8 2.4M13.2 12.2h2.2v2.4c0 1.2-.6 2-1.8 2.4" />
        </svg>
      )
    case 'swap':
      return (
        <svg {...p}>
          <path d="M4.5 8.5h13l-3.5-3.5M19.5 15.5h-13l3.5 3.5" />
        </svg>
      )
    case 'broom':
      return (
        <svg {...p}>
          <path d="M14.5 3.5 11 10.2" />
          <path d="M7.4 9.4l6.8 3.5-1.6 7.6c-3.2-.4-6.6-2.3-8.6-5.4z" />
          <path d="M8.6 15.4l2.2-1.6M6.4 13.2l1.9-1.1" />
        </svg>
      )
    case 'pencil':
      return (
        <svg {...p}>
          <path d="M15 5.5l3.5 3.5L8 19.5l-4 .5.5-4z" />
          <path d="M13 7.5l3.5 3.5" />
        </svg>
      )
    case 'trash':
      return (
        <svg {...p}>
          <path d="M4.5 7h15M9.5 7V5.5h5V7M6.5 7l.8 12.2a1.5 1.5 0 0 0 1.5 1.3h6.4a1.5 1.5 0 0 0 1.5-1.3L17.5 7" />
        </svg>
      )
    case 'shield':
      return (
        <svg {...p}>
          <path d="M12 3.5l7 2.8v5.2c0 4.4-3 7.4-7 9-4-1.6-7-4.6-7-9V6.3z" />
          <path d="M9 11.5l2.2 2.2L15.5 9.5" />
        </svg>
      )
    case 'check':
      return (
        <svg {...p}>
          <path d="M4 12.5l5 5L20 6.5" />
        </svg>
      )
    case 'warn':
      return (
        <svg {...p}>
          <path d="M12 3.8 21 19.4H3z" />
          <path d="M12 9.5v4.2" />
          <path d="M12 16.6v.4" />
        </svg>
      )
    case 'plus':
      return (
        <svg {...p}>
          <path d="M12 5v14M5 12h14" />
        </svg>
      )
    case 'pen-nib':
      return (
        <svg {...p}>
          <path d="M14.5 5.5l4 4L9 19l-4.5.5L5 16z" />
          <path d="M12.5 7.5l4 4" />
        </svg>
      )
    default:
      return null
  }
}

/**
 * 管家权限档位（输入框左下的模式下拉）。
 * 三档映射到后端仅有的两个布尔标志（AgentFlags），API 形态不变：
 * - chat     只讨论：不代改、不执行
 * - delegate 代改执行：默认档，可改设定/大纲/正文/触发任务，逐条可撤销
 * - full     完全访问：额外放开删书/删章/清空正文
 */
export type AgentMode = 'chat' | 'delegate' | 'full'

export const AGENT_MODES: { id: AgentMode; icon: string; label: string; hint: string }[] = [
  { id: 'chat', icon: 'shield', label: '只讨论', hint: '管家只分析、给建议，不改动作品' },
  { id: 'delegate', icon: 'check', label: '代改执行', hint: '可改设定/大纲/正文、触发生成任务，每条改动可撤销' },
  { id: 'full', icon: 'warn', label: '完全访问', hint: '不再询问，可直接删书/删章/清空正文' }
]

export function modeToFlags(mode: AgentMode): AgentFlags {
  return { butler: mode !== 'chat', allowDangerous: mode === 'full' }
}

export function flagsToMode(flags: AgentFlags): AgentMode {
  if (!flags.butler) return 'chat'
  return flags.allowDangerous ? 'full' : 'delegate'
}

/**
 * 管家动作的元数据表（前端单一真源）。
 *
 * 一种动作在卡片上「长什么样」全部集中在这里：标记字、配色、是否可撤销、
 * 是否属于「套用预置」类、卡片右侧说明、payload 美化方式。
 * 原先这些信息散在三处各自判断（本文件的图标表、Butler.tsx 的 prettyActionText
 * 与 actionCard 里的 isApply / noUndo / note 条件链），新增动作极容易漏改一处。
 *
 * 刻意写成 `Record<ChatAction['type'], ActionMeta>` 而不是 `Record<string, …>`：
 * 往 types.ts 的联合类型里加一种动作却忘了补这张表，会**直接编译报错**，
 * 而不是像以前那样静默回落到兜底样式。
 */
export interface ActionMeta {
  /** 卡片左上角的单字标记 */
  icon: string
  tone: 'gold' | 'jade' | 'seal'
  /** 不可撤销：结果落在别处，本页回滚没有意义（界面跳转 / 素材入库 / 删书） */
  noUndo?: boolean
  /** 「套用预置」类：不展示前后 diff，改为一句话说明 */
  applyKind?: '套用文风' | '套用模板' | '启用' | '停用'
  /** 卡片右侧的固定说明（替代原先散落的 `a.type === 'xxx'` 判断） */
  note?: string
  /** payload 美化：把动作块里的 JSON / 原文压成一行可读文本 */
  pretty?: (raw: string) => string
}

/** 人物类动作 → 「名字（身份）·性格·背景」 */
const prettyCharacter = (raw: string) => {
  try {
    const o = JSON.parse(raw)
    return [o.name, o.role && `（${o.role}）`, o.personality, o.background].filter(Boolean).join('·') || raw
  } catch {
    return raw
  }
}

/** 剧情线类动作 → 「线名 → 状态 · 目标」 */
const prettyPlotline = (raw: string) => {
  try {
    const o = JSON.parse(raw)
    return [o.name, o.status && `→ ${o.status}`, o.goal && `目标：${o.goal}`].filter(Boolean).join(' · ') || raw
  } catch {
    return raw
  }
}

/** 段落类动作 → 「第 N~M 段：摘要」 */
const prettyParagraph = (raw: string) => {
  try {
    const o = JSON.parse(raw)
    if (o && Array.isArray(o.paras)) {
      const n = o.paras.length
      const rng = n > 1 ? `${o.start}~${o.start + n - 1}段` : `${o.start}段`
      if (n === 0) return `第${rng}：∅`
      const preview = String(o.paras[0]).slice(0, 46)
      return `${rng}：${preview}${String(o.paras[0]).length > 46 ? '…' : ''}${n > 1 ? `（等${n}段）` : ''}`
    }
  } catch {
    /* 非 JSON 原样展示 */
  }
  return raw
}

export const ACTION_META: Record<ChatAction['type'], ActionMeta> = {
  // 设定类：正文指令与大纲条目
  chapterPrompt: { icon: '注', tone: 'gold' },
  outlineSummary: { icon: '纲', tone: 'gold' },
  outlineTitle: { icon: '题', tone: 'gold' },
  addOutline: { icon: '纲', tone: 'jade' },
  deleteOutline: { icon: '删', tone: 'seal' },
  // 设定类：书籍字段
  element: { icon: '素', tone: 'jade' },
  extraRequirement: { icon: '规', tone: 'jade' },
  masterOutline: { icon: '总', tone: 'seal' },
  synopsis: { icon: '简', tone: 'seal' },
  title: { icon: '名', tone: 'seal' },
  genre: { icon: '型', tone: 'seal' },
  worldview: { icon: '世', tone: 'seal' },
  chapterCount: { icon: '章', tone: 'seal' },
  targetWords: { icon: '字', tone: 'seal' },
  // 人物
  protagonist: { icon: '主', tone: 'seal', pretty: prettyCharacter },
  addCharacter: { icon: '角', tone: 'jade', pretty: prettyCharacter },
  updateCharacter: { icon: '角', tone: 'jade', pretty: prettyCharacter },
  removeCharacter: { icon: '删', tone: 'seal' },
  // 剧情线
  addPlotline: { icon: '线', tone: 'jade', pretty: prettyPlotline },
  plotlineStatus: { icon: '线', tone: 'jade', pretty: prettyPlotline },
  removePlotline: { icon: '删', tone: 'seal' },
  addPlotBeat: { icon: '节', tone: 'jade' },
  // 预置：套用 / 停用不展示 diff，只给一句结果说明
  applyStyle: { icon: '风', tone: 'seal', applyKind: '套用文风' },
  applyTemplate: { icon: '模', tone: 'seal', applyKind: '套用模板' },
  applySkill: { icon: '技', tone: 'seal', applyKind: '启用' },
  removeSkill: { icon: '技', tone: 'seal', applyKind: '停用' },
  // 生成偏好
  pov: { icon: '视', tone: 'seal' },
  linkContext: { icon: '链', tone: 'jade' },
  mobileReading: { icon: '机', tone: 'jade' },
  model: { icon: '模', tone: 'seal' },
  // 正文
  chapterContent: { icon: '文', tone: 'gold' },
  appendChapter: { icon: '文', tone: 'jade' },
  editParagraph: { icon: '段', tone: 'jade', pretty: prettyParagraph },
  insertParagraph: { icon: '增', tone: 'jade', pretty: prettyParagraph },
  deleteParagraph: { icon: '删', tone: 'seal', pretty: prettyParagraph },
  addMaterial: { icon: '材', tone: 'jade', noUndo: true },
  // 联网检索：只读外部资料，不改书稿
  webSearch: { icon: '搜', tone: 'jade', noUndo: true, note: '已检索' },
  fetchPage: { icon: '页', tone: 'jade', noUndo: true, note: '已读取' },
  // 触发后台任务
  generateMaster: { icon: '总', tone: 'gold' },
  generateOutline: { icon: '纲', tone: 'gold' },
  rewriteOutline: { icon: '纲', tone: 'gold' },
  writeChapter: { icon: '写', tone: 'gold' },
  generateAll: { icon: '写', tone: 'gold' },
  continueChapter: { icon: '续', tone: 'gold' },
  polishChapter: { icon: '润', tone: 'gold' },
  reviseChapter: { icon: '修', tone: 'gold' },
  deaiChapter: { icon: '降', tone: 'gold' },
  detectAI: { icon: '检', tone: 'gold' },
  inspire: { icon: '灵', tone: 'gold' },
  consistencyCheck: { icon: '检', tone: 'gold' },
  // 破坏性
  deleteChapter: { icon: '删', tone: 'seal' },
  clearChapters: { icon: '清', tone: 'seal' },
  deleteNovel: { icon: '删', tone: 'seal', noUndo: true, note: '已移入回收站，可到首页「回收站」恢复' },
  // 界面
  navigate: { icon: '去', tone: 'jade', noUndo: true, note: '已自动跳转' }
}

/** 未知动作（老服务端 / 新增未同步）的兜底样式 */
export const ACTION_META_FALLBACK: ActionMeta = { icon: '改', tone: 'gold' }

// 管家 navigate 动作的页面 key → 作品工作台的实际地址
export function pagePath(key: string, novelId: string): string | null {
  switch (key) {
    case 'home':
      return '/'
    case 'settings':
      return '/settings'
    case 'shelf':
      return '/shelf'
    // 作品工作台的 5 个工作区（同一路径，靠 ?tab= 区分）
    case 'bible':
      return `/novel/${novelId}?tab=bible`
    case 'outline':
      return `/novel/${novelId}?tab=outline`
    case 'write':
      return `/novel/${novelId}?tab=write`
    case 'refine':
      return `/novel/${novelId}?tab=refine`
    case 'read':
      return `/novel/${novelId}?tab=book`
    default:
      return null
  }
}

// 生成类动作 → 结果所在工作区（返回 pagePath 的 key）
export function jobPage(a: ChatAction): string | null {
  if (a.type === 'navigate') return null
  // 总纲 / 章纲 / 灵感：产出落在大纲区
  if (a.jobType === 'master' || a.jobType === 'outline' || a.jobType === 'inspire') return 'outline'
  // 正文任务：首写落写作区；续写 / 润色 / 改写 / 降AI 的结果在精修区
  if (a.jobType === 'chapter') return a.jobKind && a.jobKind !== 'write' ? 'refine' : 'write'
  if (a.jobType === 'detect' || a.jobType === 'consistency') return 'refine'
  return null
}

export function fmtTime(at: number): string {
  try {
    return new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
  } catch {
    return ''
  }
}

/** 会话列表用的相对时间：刚刚 / 12 分钟前 / 3 小时前 / 昨天 / 9月8日 */
export function fmtRelative(at: number): string {
  if (!at) return ''
  const diff = Date.now() - at
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  const d = new Date(at)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  if (sameDay) return `${Math.floor(diff / 3_600_000)} 小时前`
  const yest = new Date(now)
  yest.setDate(now.getDate() - 1)
  if (d.toDateString() === yest.toDateString()) return '昨天'
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}

// 正文按空行/连续换行划分的自然段落，段号从 1 开始
export function chapterParas(content: string): string[] {
  return String(content || '')
    .replace(/\r\n/g, '\n')
    .split(/\n+/)
    .map(s => s.trim())
    .filter(Boolean)
}

// 把选中的段落拼成随消息发送的「选中的原文」引用块
export function selectedQuote(novel: Novel, selChapter: number, selParas: number[]): string {
  if (!selChapter || !selParas.length) return ''
  const ch = (novel.chapters || []).find(c => c.index === selChapter)
  if (!ch) return ''
  const paras = chapterParas(ch.content || '')
  if (!paras.length) return ''
  const idxs = [...new Set(selParas.filter(n => n >= 1 && n <= paras.length))].sort((a, b) => a - b)
  if (!idxs.length) return ''
  const head = `————————————————\n【选中的原文 · 第${selChapter}章${ch.title ? `《${ch.title}》` : ''}】`
  const MAX = 8000
  let used = head.length
  const parts: string[] = []
  for (const i of idxs) {
    const seg = `〔第${i}段〕${paras[i - 1]}`
    if (used + seg.length > MAX) {
      parts.push('（后续段落过长已截断，请缩小选段后再让管家精确修改）')
      break
    }
    used += seg.length
    parts.push(seg)
  }
  return `${head}\n${parts.join('\n\n')}`
}

/** 未选定书籍时的入口：选择已有作品或新建一本（独立模块，不依赖原区域） */
