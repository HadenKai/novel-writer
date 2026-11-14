import { useEffect, useRef, useState } from 'react'
import './preview.css'
import type { ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api } from '../lib/api'
import { useNovel } from '../lib/hooks/useNovel'
import { useJob } from '../lib/hooks/useJob'
import { useModels } from '../lib/hooks/useModels'
import ModelSelect from '../components/ModelSelect'
import ModalShell from '../components/ModalShell'
import { confirmDialog, alertDialog } from '../components/Dialog'
import { toast } from '../components/Toast'
import { useFixedSizeWindow } from '../lib/useFixedSizeWindow'
import type { Chapter, NovelStats, HistoryEntry, SensitiveResult } from '../types'

// ───────────────────────────── 排版预设 ─────────────────────────────
type TypoPrefs = {
  fontSize: number
  lineHeight: number
  fontFamily: string
  letterSpacing: number
  paragraphSpacing: number
  indent: number
  align: string
  readingWidth: number
}

/** 「一键排版」套用的标准版式：宋体 · 17px · 行高 1.95 · 首行缩进 2em · 两端对齐 */
const DEFAULT_TYPO: TypoPrefs = {
  fontSize: 17,
  lineHeight: 1.95,
  fontFamily: 'song',
  letterSpacing: 0.02,
  paragraphSpacing: 0.75,
  indent: 2,
  align: 'justify',
  readingWidth: 40
}

const FONT_CLASS: Record<string, string> = { song: 'font-song', hei: 'font-hei', kai: 'font-kai' }
const FONT_NAME: { key: string; label: string }[] = [
  { key: 'song', label: '宋体' },
  { key: 'hei', label: '黑体' },
  { key: 'kai', label: '楷体' }
]

/** 稿纸底色（深色主题统一回落为面板色） */
const PAPERS: { key: string; label: string; cls: string; swatch: string }[] = [
  { key: 'warm', label: '米白', cls: 'paper-warm', swatch: '#faf7f0' },
  { key: 'green', label: '护眼', cls: 'paper-green', swatch: '#eef4ec' },
  { key: 'rose', label: '浅粉', cls: 'paper-rose', swatch: '#fdf3f5' },
  { key: 'plain', label: '纸白', cls: 'paper-plain', swatch: '#ffffff' }
]

// ───────────────────────────── 工具条小件 ─────────────────────────────
/** 上下文里高亮命中的词（正则类命中如「手机号」找不到原词，退化为纯文本） */
function markContext(ctx: string, word: string) {
  const i = word ? ctx.toLowerCase().indexOf(word.toLowerCase()) : -1
  if (i < 0) return ctx
  return (
    <>
      {ctx.slice(0, i)}
      <span className="rounded-[3px] bg-[color-mix(in_srgb,var(--seal)_16%,transparent)] px-0.5 font-medium text-[var(--seal)]">
        {ctx.slice(i, i + word.length)}
      </span>
      {ctx.slice(i + word.length)}
    </>
  )
}

function TIcon({ name, size = 14 }: { name: string; size?: number }) {
  const p = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const
  }
  switch (name) {
    case 'font':
      return (
        <svg {...p}>
          <path d="M5 6.5h14M12 6.5V18M9.5 18h5" />
        </svg>
      )
    case 'paper':
      return (
        <svg {...p}>
          <rect x="4" y="5" width="16" height="14" rx="2" />
          <path d="M12 5v14" />
        </svg>
      )
    case 'undo':
      return (
        <svg {...p}>
          <path d="M8.5 6.8A7 7 0 1 0 10.2 18" />
          <path d="M4 4.5V9h4.5" />
        </svg>
      )
    case 'typeset':
      return (
        <svg {...p}>
          <path d="M5 7h14M5 12h14M5 17h9" />
        </svg>
      )
    case 'history':
      return (
        <svg {...p}>
          <path d="M4.8 12a7.2 7.2 0 1 0 2.1-5.1L4.6 9.1" />
          <path d="M4.6 4.7v4.4H9" />
          <path d="M12 8.6V12l2.4 1.5" />
        </svg>
      )
    case 'shield':
      return (
        <svg {...p}>
          <path d="M12 3.5l7 2.5v5.2c0 4.4-2.9 7.6-7 9.3-4.1-1.7-7-4.9-7-9.3V6z" />
          <path d="M9.2 12.2l2 2 3.6-4" />
        </svg>
      )
    case 'ai':
      return (
        <svg {...p}>
          <path d="M12 4l1.7 5.1L19 11l-5.3 1.9L12 18l-1.7-5.1L5 11l5.3-1.9z" />
        </svg>
      )
    case 'plus':
      return (
        <svg {...p}>
          <path d="M12 5v14M5 12h14" />
        </svg>
      )
    case 'stats':
      return (
        <svg {...p}>
          <rect x="4" y="4" width="7" height="7" rx="1.2" />
          <rect x="13" y="4" width="7" height="7" rx="1.2" />
          <rect x="4" y="13" width="7" height="7" rx="1.2" />
          <rect x="13" y="13" width="7" height="7" rx="1.2" />
        </svg>
      )
    case 'copy':
      return (
        <svg {...p}>
          <rect x="8.5" y="8.5" width="11" height="11" rx="2" />
          <path d="M15.5 8.5V6.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2" />
        </svg>
      )
    case 'export':
      return (
        <svg {...p}>
          <path d="M12 4v10m0 0l-3.5-3.5M12 14l3.5-3.5" />
          <path d="M5 19h14" />
        </svg>
      )
    case 'search':
      return (
        <svg {...p}>
          <circle cx="10.5" cy="10.5" r="5.5" />
          <path d="M19 19l-4.2-4.2" />
        </svg>
      )
    case 'x':
      return (
        <svg {...p}>
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      )
    case 'check':
      return (
        <svg {...p} strokeWidth={2.4}>
          <path d="M5 12.5l4.5 4.5L19 7.5" />
        </svg>
      )
    case 'panel-left':
      return (
        <svg {...p}>
          <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
          <path d="M9.5 4.5v15" />
        </svg>
      )
    default:
      return null
  }
}

function ToolButton({
  icon,
  label,
  onClick,
  active,
  title,
  disabled,
  accent
}: {
  icon: string
  label: string
  onClick?: () => void
  active?: boolean
  title?: string
  disabled?: boolean
  accent?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title || label}
      aria-label={title || label}
      aria-pressed={active}
      className={`flex h-8 shrink-0 items-center gap-1.5 rounded-[9px] px-2.5 text-[12px] transition disabled:opacity-40 ${
        accent
          ? 'bg-[color-mix(in_srgb,var(--gold)_10%,var(--panel))] text-[var(--gold)] hover:bg-[color-mix(in_srgb,var(--gold)_16%,var(--panel))]'
          : active
            ? 'bg-[var(--active)] text-[var(--text)]'
            : 'text-[var(--text-dim)] hover:bg-[var(--hover)] hover:text-[var(--text)]'
      }`}
    >
      <TIcon name={icon} size={14} />
      <span className="whitespace-nowrap">{label}</span>
    </button>
  )
}

function ToolSep() {
  return <span className="mx-1 h-4 w-px shrink-0 bg-[var(--line)]" />
}

/** 工具条上的轻量浮层（字体 / 背景 / 导出 / 统计公用） */
function Popover({
  open,
  onClose,
  width = 200,
  children
}: {
  open: boolean
  onClose: () => void
  width?: number
  children: ReactNode
}) {
  if (!open) return null
  return (
    <>
      <div className="fixed inset-0 z-30" onClick={onClose} />
      <div
        className="preview-popover absolute left-0 top-11 z-40 rounded-[12px] border border-[var(--line)] bg-[var(--panel)] p-2 shadow-[var(--sh-4)]"
        style={{ width }}
        onKeyDown={e => {
          if (e.key === 'Escape') onClose()
        }}
      >
        {children}
      </div>
    </>
  )
}

const menuItemCls =
  'flex w-full items-center justify-between gap-2 rounded-[9px] px-2.5 py-1.5 text-left text-[12px] text-[var(--text-dim)] transition hover:bg-[var(--panel2)] hover:text-[var(--text)]'

// ───────────────────────────── 页面 ─────────────────────────────
export default function Library() {
  const { id } = useParams()
  const { novel, loadError, reload, setNovel } = useNovel(id, n => {
    setSel(c => {
      if (c != null && (n.chapters || []).some(ch => ch.index === c)) return c
      const first = [...(n.chapters || [])].sort((a, b) => a.index - b.index)[0]
      return first ? first.index : null
    })
  })
  const [stats, setStats] = useState<NovelStats | null>(null)
  const [sel, setSel] = useState<number | null>(null)
  const [copied, setCopied] = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [importText, setImportText] = useState('')
  const [importReplace, setImportReplace] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importResult, setImportResult] = useState('')

  // 正文常驻可编辑：选中章节即进入草稿态，无需点击任何按钮；改动后手动保存或 Ctrl+S
  const [draftTitle, setDraftTitle] = useState('')
  const [draftContent, setDraftContent] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [typesetting, setTypesetting] = useState(false)
  const typesettingRef = useRef(false)
  const activeIdRef = useRef(id)
  activeIdRef.current = id
  // 版本历史：快照列表与回滚（后端 /api/novels/:id/history）
  const [historyOpen, setHistoryOpen] = useState(false)
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [historyBusy, setHistoryBusy] = useState('')
  // 敏感词 / 过审检测：内置离线词典，扫本章或全书，只提示不拦截
  const [sensOpen, setSensOpen] = useState(false)
  const [sensBusy, setSensBusy] = useState<'' | 'chapter' | 'all'>('')
  const [sensResult, setSensResult] = useState<SensitiveResult | null>(null)
  const [sensScopeLabel, setSensScopeLabel] = useState('')

  useEffect(() => {
    if (historyOpen) loadHistory()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyOpen, id])

  // 页级 Ctrl+S：焦点在标题框或页面任意位置都能保存（旧实现只绑在正文 textarea 上）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 's') return
      e.preventDefault()
      if (dirty && !saving) saveDraft()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
  // 切页签 / 切路由会把本组件整体卸载：把手上的草稿补存一次，
  // 否则「改完正文直接点侧栏去别的页」的改动会静默丢失
  useEffect(() => {
    return () => {
      void saveDraftRef.current?.()
    }
  }, [])
  const [aiPrompt, setAiPrompt] = useState('')
  const [aiMode, setAiMode] = useState<'continue' | 'polish' | 'revise'>('continue')
  const [showAiPanel, setShowAiPanel] = useState(false)
  // 左侧章节目录：与右侧 AI 面板对称，可收起。窄屏（<md）本来就不显示目录，
  // 但中等宽度下 232px 的目录会挤压稿纸，作者需要一个随时收起的入口。
  const [showToc, setShowToc] = useState(() => window.matchMedia('(min-width: 761px)').matches)
  const { job, running, claimRunning, startJob, stop } = useJob({
    claim: j =>
      j.type === 'chapter' &&
      (j.kind === 'continue' || j.kind === 'polish' || j.kind === 'revise' || j.kind === 'deai'),
    onSettled: j => {
      void reload()
      if (j.status === 'done' && j.paused) toast(j.error || '已暂停，可再次点击继续。')
      else if (j.status === 'done')
        toast.success(
          j.type === 'detect'
            ? 'AI 检测完成。'
            : j.kind === 'revise'
              ? '修改完成。'
              : j.kind === 'polish'
                ? '润色完成。'
                : '续写完成。'
        )
      if (j.status === 'stopped') toast(j.savedDraft ? '已停笔，已生成的部分已存为草稿。' : '已停笔。')
      if (j.status === 'error') toast.error(`失败：${j.savedDraft ? j.error + '（已生成的部分已存为草稿）' : j.error}`)
    }
  })
  const models = useModels()
  const [aiModelId, setAiModelId] = useState('')
  const readerRef = useRef<HTMLDivElement>(null)

  // 排版偏好（后端 /api/settings 同步；界面只暴露「字体」「背景」「一键排版」）
  const [prefs, setPrefs] = useState<TypoPrefs>(DEFAULT_TYPO)
  // 正文区只有一种形态：稿纸底 + 常驻可编辑，不再有「编辑 / 稿纸」两套视图需要切换
  const [paper, setPaper] = useState<string>(() => {
    try {
      return localStorage.getItem('studio-library-paper') || 'warm'
    } catch {
      return 'warm'
    }
  })
  const [menu, setMenu] = useState<'' | 'font' | 'paper' | 'export' | 'stats' | 'typeset'>('')
  const [chSearch, setChSearch] = useState('')

  const bodyRef = useRef<HTMLTextAreaElement>(null)
  const savingRef = useRef(false)
  const pendingSelRef = useRef<number | null>(null)
  // AI 起笔互斥用 ref（声明在早退之前）：confirmDialog 的 await 期间 running 仍是 false
  const startAiBusyRef = useRef(false)
  const draftBaseRef = useRef<{ bookId: string; index: number; title: string; content: string } | null>(null)
  const draftTitleRef = useRef('')
  const draftContentRef = useRef('')
  draftTitleRef.current = draftTitle
  draftContentRef.current = draftContent
  // 卸载补存用的句柄：saveDraft 定义在早退之后，卸载 effect（必须在 hooks 区）经 ref 调它
  const saveDraftRef = useRef<null | (() => Promise<boolean>)>(null)
  const savingPromiseRef = useRef<null | Promise<boolean>>(null)

  useEffect(() => {
    if (!novel) return
    const c = novel.chapters.find(x => x.index === sel)
    const base = draftBaseRef.current
    const sameChapter = base?.bookId === novel.id && base?.index === sel
    const hasUnsaved =
      sameChapter &&
      base &&
      ((draftTitleRef.current.trim() || base.title) !== base.title || draftContentRef.current !== base.content)
    if (hasUnsaved) return
    draftBaseRef.current = c ? { bookId: novel.id, index: c.index, title: c.title, content: c.content } : null
    draftTitleRef.current = c?.title ?? ''
    draftContentRef.current = c?.content ?? ''
    setDraftTitle(draftTitleRef.current)
    setDraftContent(draftContentRef.current)
    setSaveError('')
  }, [novel, sel])

  useEffect(() => {
    api
      .getSettings()
      .then(s => setPrefs({ ...DEFAULT_TYPO, ...s }))
      .catch(() => {})
  }, [])

  const savePrefs = (p: Partial<TypoPrefs>) => {
    const next = { ...prefs, ...p }
    setPrefs(next)
    api.saveSettings(next).catch(() => {})
  }

  const pickPaper = (k: string) => {
    setPaper(k)
    try {
      localStorage.setItem('studio-library-paper', k)
    } catch {}
  }

  // ── 一键排版：套用标准版式并由服务端直接落库（可只排当前章，也可排全书）。
  //    排版是幂等的：已是标准版式时不会重复加缩进，作者可以放心重复点。 ──
  const openTypesetMenu = () => setMenu(m => (m === 'typeset' ? '' : 'typeset'))

  // 章节字数统计：带 alive 标记防竞态——快速换书时旧书的统计响应回来
  // 不能覆盖新书的（与 useNovel 的代际保护同一思路）
  useEffect(() => {
    if (!id) return
    let alive = true
    api
      .getStats(id)
      .then(s => {
        if (alive) setStats(s)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [id])

  useEffect(() => {
    if (loadError) alertDialog({ title: '加载失败', body: loadError, tone: 'error' })
  }, [loadError])

  // 切章时滚动回顶部
  useEffect(() => {
    if (readerRef.current) readerRef.current.scrollTop = 0
    if (bodyRef.current) bodyRef.current.scrollTop = 0
  }, [sel])

  useEffect(() => {
    if (id) void claimRunning(id)
  }, [id, claimRunning])

  const chapters = novel
    ? [...(novel.chapters || [])].filter(c => c.content && c.content.trim()).sort((a, b) => a.index - b.index)
    : []
  const shownChapters = chSearch.trim()
    ? chapters.filter(c => (c.title || '').includes(chSearch.trim()) || String(c.index) === chSearch.trim())
    : chapters
  // 千章目录虚拟滚动：行高固定 48px（46 行高 + 2 间距），只把视口附近的行挂进 DOM
  const toc = useFixedSizeWindow(shownChapters.length, 48)

  if (!novel) return <div className="p-10 text-[var(--text-dim)]">加载中……</div>
  const current: Chapter | undefined = chapters.find(c => c.index === sel)
  const draftBase = draftBaseRef.current
  const dirty =
    !!current &&
    !!draftBase &&
    ((draftTitle.trim() || draftBase.title) !== draftBase.title || draftContent !== draftBase.content)
  const totalWords = chapters.reduce((s, c) => s + c.words, 0)
  const paperCls = (PAPERS.find(p => p.key === paper) || PAPERS[0]).cls
  const fontCls = FONT_CLASS[prefs.fontFamily] || 'font-song'

  const pickFile = () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.txt,.md,text/plain,text/markdown'
    input.onchange = async () => {
      const f = input.files?.[0]
      if (!f) return
      const text = await f.text()
      setImportText(text)
      setShowImport(true)
    }
    input.click()
  }

  const doImport = async () => {
    if (!id || !importText.trim())
      return alertDialog({ title: '没有可导入的内容', body: '请先粘贴内容或选择文件。', tone: 'warning' })
    if (importReplace) {
      const ok = await confirmDialog({
        title: '「替换模式」将清空本书现有章节',
        body: '现有章节会被导入内容完全取代，此操作不可恢复。',
        confirmText: '替换导入',
        danger: true
      })
      if (!ok) return
    }
    setImporting(true)
    setImportResult('')
    try {
      const r = await api.importNovel(id, importText, importReplace)
      setImportResult(`导入成功：${r.chapters} 章，共 ${r.words.toLocaleString()} 字`)
      setImportText('')
      await reload()
      setTimeout(() => {
        setShowImport(false)
        setImportResult('')
      }, 1500)
    } catch (e) {
      alertDialog({ title: '导入失败', body: (e as Error).message, tone: 'error' })
    } finally {
      setImporting(false)
    }
  }

  const exportSaved = async (url: string) => {
    if (typesettingRef.current || !(await saveDraft())) return
    setMenu('')
    const link = document.createElement('a')
    link.href = url
    link.download = ''
    document.body.appendChild(link)
    link.click()
    link.remove()
  }

  const copyCurrent = async () => {
    if (!current) return
    const text = `第${current.index}章 ${draftTitleRef.current.trim() || current.title}\n\n${draftContentRef.current}`
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      // Electron 剪贴板权限被拒时的兜底
      const ta = document.createElement('textarea')
      ta.value = text
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      ta.remove()
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const saveDraft = async (): Promise<boolean> => {
    if (!id || activeIdRef.current !== id) return false
    if (savingRef.current) {
      // 原样传递失败；成功后继续保存等待期间的新输入，再允许切章或排版。
      const pending = savingPromiseRef.current
      if (!pending || !(await pending)) return false
      return saveDraft()
    }
    const base = draftBaseRef.current
    if (!base) return true
    if (base.bookId !== id) return false
    const title = draftTitleRef.current.trim() || base.title
    const content = draftContentRef.current
    if (title === base.title && content === base.content) return true
    savingRef.current = true
    setSaving(true)
    setSaveError('')
    const p = (async (): Promise<boolean> => {
      try {
        const result = await api.updateChapter(id, base.index, { title, content })
        if (!result.ok) throw new Error('服务端未确认保存，请重试。')
        // 请求快照成为新基线，不回填 textarea，保存期间的继续编辑始终保留。
        if (activeIdRef.current === id && draftBaseRef.current === base) {
          draftBaseRef.current = { ...base, title, content }
          setNovel(n =>
            n?.id === id
              ? {
                  ...n,
                  chapters: n.chapters.map(c =>
                    c.index === base.index ? { ...c, title, content, words: content.replace(/\s/g, '').length } : c
                  )
                }
              : n
          )
        }
        toast.success('章节已保存。')
        await reload()
        return true
      } catch (e) {
        const message = (e as Error).message
        setSaveError(message)
        void alertDialog({
          title: '保存失败，未切换章节',
          body: `${message}\n修改仍保留在当前页面，请重试保存。`,
          tone: 'error'
        })
        return false
      } finally {
        savingRef.current = false
        setSaving(false)
        savingPromiseRef.current = null
      }
    })()
    savingPromiseRef.current = p
    // 连续编辑可能发生在 PUT 或刷新期间；确认最新草稿也已保存才放行。
    return (await p) ? saveDraft() : false
  }
  saveDraftRef.current = saveDraft

  /**
   * 一键排版：scope=chapter 只排当前章，scope=all 排全书。
   * 由服务端在书级事务里直接落库（并自动留档到版本历史），因此这里能看到真实结果：
   * 排版前先把当前章的未保存改动存一次，否则新草稿会盖住排版结果，看起来像没生效。
   */
  const doTypeset = async (scope: 'chapter' | 'all') => {
    if (!id || typesettingRef.current) return
    const target = current?.index
    if (scope === 'chapter' && !target) return
    setMenu('')
    typesettingRef.current = true
    setTypesetting(true)
    try {
      if (!(await saveDraft())) return
      if (activeIdRef.current !== id) return
      // 「一键排版」同时把阅读版式套回标准预设，正文区的字体/字号/行高一起对齐
      savePrefs(DEFAULT_TYPO)
      const r = await api.typeset(id, {
        chapterIndex: scope === 'chapter' ? target : undefined,
        indent: DEFAULT_TYPO.indent
      })
      if (!r.ok) throw new Error('服务端未确认排版完成，请重试。')
      const n = await reload()
      // 排版后正文已换版式，必须把草稿同步成新内容：否则界面仍显示旧草稿，
      // 既让人以为「点了没反应」，切章时还会把排版结果顶掉。
      const fresh = (n?.chapters || []).find(c => c.index === (scope === 'chapter' ? target : current?.index))
      if (fresh && activeIdRef.current === id && draftBaseRef.current?.index === target) {
        draftBaseRef.current = { bookId: id, index: fresh.index, title: fresh.title, content: fresh.content }
        draftTitleRef.current = fresh.title
        draftContentRef.current = fresh.content
        setDraftTitle(fresh.title)
        setDraftContent(fresh.content)
      }
      toast.success(
        r.changed > 0
          ? `已排版${scope === 'all' ? '全书' : `第 ${target} 章`}：${r.changed} 章 · ${r.paragraphs.toLocaleString()} 段 · 首行缩进 ${r.indent} 格`
          : `${scope === 'all' ? '全书' : `第 ${target} 章`}已经是标准版式，无需改动。`
      )
    } catch (e) {
      alertDialog({ title: '排版失败', body: (e as Error).message, tone: 'error' })
    } finally {
      typesettingRef.current = false
      setTypesetting(false)
    }
  }

  /**
   * 切换章节：先把手上的未保存改动落盘再切走。
   * 旧实现直接 setSel 走人，未保存的草稿会被新章的正文覆盖——作者看到的是「改的内容莫名没了」。
   */
  const selectChapter = async (index: number, jump = false) => {
    if (typesettingRef.current) return
    if (index === sel) {
      pendingSelRef.current = null
      return
    }
    // 记下最新意图：B 章保存途中用户又点了 C，先完成的 B 不应把选中态盖回 B
    pendingSelRef.current = index
    // 保存失败时必须停下：继续切章会让新章内容盖掉手上这份没落盘的草稿
    if (!(await saveDraft())) {
      if (pendingSelRef.current === index) pendingSelRef.current = null
      return
    }
    const target = pendingSelRef.current
    if (target !== index || activeIdRef.current !== id) return // 仅执行最后一次选章意图
    setSel(target)
    if (jump) {
      const pos = shownChapters.findIndex(c => c.index === target)
      if (pos >= 0) requestAnimationFrame(() => toc.scrollToIndex(pos))
    }
  }

  const loadHistory = async () => {
    if (!id) return
    try {
      setHistory(await api.getHistory(id))
    } catch (e) {
      alertDialog({ title: '历史读取失败', body: (e as Error).message, tone: 'error' })
    }
  }

  const restoreHistory = async (h: HistoryEntry) => {
    if (!id) return
    const ok = await confirmDialog({
      title: `回滚到「${h.label}」？`,
      body: `全书将回到 ${new Date(h.at).toLocaleString()} 的状态（${h.chapters} 章 / ${h.words.toLocaleString()} 字）。回滚前会自动给当前状态留一份快照。`,
      confirmText: '回滚'
    })
    if (!ok) return
    setHistoryBusy(h.id)
    try {
      await api.restoreHistory(id, h.id)
      await reload()
      await loadHistory()
      toast.success('已回滚到所选版本。')
    } catch (e) {
      alertDialog({ title: '回滚失败', body: (e as Error).message, tone: 'error' })
    } finally {
      setHistoryBusy('')
    }
  }

  /** 还原：把草稿退回该章已保存的内容 */
  const revertDraft = async () => {
    if (!current || savingRef.current || typesettingRef.current) return
    if (dirty) {
      const ok = await confirmDialog({
        title: '放弃未保存的修改？',
        body: '当前改动会丢失，正文还原为上一次保存的内容。',
        confirmText: '放弃修改',
        danger: true
      })
      if (!ok) return
    }
    draftBaseRef.current = { bookId: novel.id, index: current.index, title: current.title, content: current.content }
    draftTitleRef.current = current.title
    draftContentRef.current = current.content
    setDraftTitle(current.title)
    setDraftContent(current.content)
    setSaveError('')
    toast('已还原为已保存内容。')
  }

  const removeChapter = async (c: Chapter) => {
    if (!id) return
    const ok = await confirmDialog({
      title: `删除第 ${c.index} 章《${c.title}》？`,
      body: '章节正文与对应大纲行都会被移除，此操作不可恢复。',
      confirmText: '删除',
      danger: true
    })
    if (!ok) return
    await api.deleteChapter(id, c.index).catch(e => alertDialog({ title: '删除失败', body: e.message, tone: 'error' }))
    await reload()
  }

  const startAi = async () => {
    if (!id || !current || running || typesettingRef.current) return
    // confirmDialog 的 await 期间 running 仍是 false，双击会并发起两个任务；用 ref 占住这段窗口
    if (startAiBusyRef.current) return
    startAiBusyRef.current = true
    try {
      await startAiInner(id, current)
    } finally {
      startAiBusyRef.current = false
    }
  }
  const startAiInner = async (id: string, current: Chapter) => {
    if (aiMode === 'polish') {
      const ok = await confirmDialog({
        title: `用 AI 重写第 ${current.index} 章？`,
        body: '《' + current.title + '》全文会被润色重写，情节人物保留，原稿自动留档。',
        confirmText: '开始润色'
      })
      if (!ok) return
    }
    if (aiMode === 'revise' && !aiPrompt.trim()) {
      return void alertDialog({
        title: '请描述要修改的问题',
        body: '在下方输入具体问题后，AI 才能做针对性修改。',
        tone: 'warning'
      })
    }
    if (aiMode === 'revise') {
      const ok = await confirmDialog({
        title: `AI 将通读第 ${current.index} 章并针对性修改`,
        body: '会根据你提出的问题进行改写，原稿自动留档。',
        confirmText: '开始修改'
      })
      if (!ok) return
    }
    if (!(await saveDraft()) || draftBaseRef.current?.index !== current.index) return
    const r = await startJob(() => {
      if (aiMode === 'continue') return api.startContinueJob(id, current.index, aiPrompt.trim(), aiModelId || undefined)
      if (aiMode === 'polish') return api.startPolishJob(id, current.index, aiPrompt.trim(), aiModelId || undefined)
      return api.startReviseJob(id, current.index, aiPrompt.trim(), aiModelId || undefined)
    })
    if (!r.ok) {
      alertDialog({ title: '启动失败', body: r.error, tone: 'error' })
      return
    }
  }

  /** 敏感词 / 过审检测：本章或全书（全书按章分组，便于逐章处理）。
   *  当前章若有未保存草稿，用草稿文本检测，避免「改了还没存 → 检测旧内容」。 */
  const runSensitive = async (scope: 'chapter' | 'all') => {
    if (!id || sensBusy) return
    const items =
      scope === 'chapter'
        ? current
          ? [
              {
                key: String(current.index),
                label: `第 ${current.index} 章 ${current.title}`,
                text: draftContent || current.content || ''
              }
            ]
          : []
        : chapters.map(c => ({
            key: String(c.index),
            label: `第 ${c.index} 章 ${c.title}`,
            text: c.index === sel ? draftContent || c.content || '' : c.content || ''
          }))
    if (!items.length) return
    setSensBusy(scope)
    setSensResult(null)
    try {
      const r = await api.checkSensitive(items)
      setSensResult(r)
      setSensScopeLabel(scope === 'chapter' ? (current ? `第 ${current.index} 章` : '') : `全书 ${chapters.length} 章`)
    } catch (e) {
      alertDialog({ title: '检测失败', body: (e as Error).message, tone: 'error' })
    } finally {
      setSensBusy('')
    }
  }

  return (
    <div className="preview-page relative flex h-full flex-col">
      <header className="preview-header">
        <div>
          <h1>预览与导出</h1>
          <p>标题与正文仍可直接编辑，修改后保存再导出。</p>
        </div>
        <span role="status" className={saveError ? 'preview-save-error' : 'preview-save-state'}>
          {typesetting
            ? '排版中，暂时锁定编辑与切章'
            : saving
              ? '正在保存… 可继续编辑'
              : saveError
                ? '保存失败，请重试；修改仍在当前页'
                : dirty
                  ? '有未保存的修改 · Ctrl+S'
                  : '已与保存版本同步'}
        </span>
      </header>
      {/* ── 顶部工具条 ── */}
      <div className="preview-toolbar" aria-label="预览与导出工具">
        <div className="flex min-w-0 items-center gap-1.5 pr-2">
          <span className="truncate text-[13px] font-medium text-[var(--text)]">《{novel.title}》</span>
        </div>

        <ToolButton
          icon="panel-left"
          label="目录"
          onClick={() => setShowToc(v => !v)}
          active={showToc}
          title={showToc ? '收起章节目录' : '展开章节目录'}
        />

        <div className="relative flex items-center">
          <ToolButton
            icon="font"
            label={FONT_NAME.find(f => f.key === prefs.fontFamily)?.label || '宋体'}
            onClick={() => setMenu(m => (m === 'font' ? '' : 'font'))}
            active={menu === 'font'}
            title="选择正文字体"
          />
          <Popover open={menu === 'font'} onClose={() => setMenu('')} width={168}>
            {FONT_NAME.map(f => (
              <button
                key={f.key}
                className={`${menuItemCls} ${FONT_CLASS[f.key]}`}
                onClick={() => {
                  savePrefs({ fontFamily: f.key })
                  setMenu('')
                }}
              >
                <span>{f.label}</span>
                {prefs.fontFamily === f.key && <TIcon name="check" size={13} />}
              </button>
            ))}
          </Popover>
        </div>

        <div className="relative flex items-center">
          <ToolButton
            icon="paper"
            label="背景"
            onClick={() => setMenu(m => (m === 'paper' ? '' : 'paper'))}
            active={menu === 'paper'}
            title="稿纸底色"
          />
          <Popover open={menu === 'paper'} onClose={() => setMenu('')} width={172}>
            {PAPERS.map(p => (
              <button
                key={p.key}
                className={menuItemCls}
                onClick={() => {
                  pickPaper(p.key)
                  setMenu('')
                }}
              >
                <span className="flex items-center gap-2">
                  <span
                    className="h-3.5 w-3.5 rounded-[4px] border border-[var(--line)]"
                    style={{ background: p.swatch }}
                  />
                  {p.label}
                </span>
                {paper === p.key && <TIcon name="check" size={13} />}
              </button>
            ))}
          </Popover>
        </div>

        <ToolSep />
        <ToolButton
          icon="undo"
          label="还原"
          onClick={revertDraft}
          disabled={!dirty || saving || typesetting}
          title="放弃未保存的修改"
        />
        <ToolButton
          icon="history"
          label="历史"
          onClick={() => setHistoryOpen(true)}
          title="版本历史：排版与关键操作自动留档，可回滚"
        />
        <ToolButton
          icon="shield"
          label="敏感词"
          onClick={() => {
            setSensResult(null)
            setSensOpen(true)
          }}
          title="过审检测：按内置词典扫描违禁词与导流信息"
        />
        <div className="relative flex items-center">
          <ToolButton
            icon="typeset"
            label={typesetting ? '排版中…' : '一键排版'}
            onClick={openTypesetMenu}
            active={menu === 'typeset'}
            disabled={typesetting || running || !chapters.length}
            accent
            title="套用标准版式：首行缩进两格 · 段间空一行 · 清理多余空格"
          />
          <Popover open={menu === 'typeset'} onClose={() => setMenu('')} width={268}>
            <div className="px-2.5 pb-2 pt-1 text-[11px] leading-[1.7] text-[var(--text-faint)]">
              套用小说标准版式：段落首行缩进 {DEFAULT_TYPO.indent} 格 · 段间空一行 · 清理行首尾多余空格。
              只改版式不改文字，排版前自动留档，可到「历史」回滚。
            </div>
            <button
              className={`${menuItemCls} disabled:opacity-40`}
              onClick={() => doTypeset('chapter')}
              disabled={!current || typesetting}
            >
              <span>{current ? `排版本章（第 ${current.index} 章）` : '排版本章'}</span>
            </button>
            <button
              className={`${menuItemCls} disabled:opacity-40`}
              onClick={() => doTypeset('all')}
              disabled={typesetting}
            >
              <span>排版全书（共 {chapters.length} 章）</span>
            </button>
          </Popover>
        </div>
        <ToolSep />
        <ToolButton
          icon="ai"
          label="AI 写作"
          onClick={() => setShowAiPanel(v => !v)}
          active={showAiPanel}
          title="AI 续写 / 润色 / 修改"
        />
        <ToolButton
          icon="plus"
          label="导入"
          onClick={() => {
            setImportText('')
            setImportResult('')
            setShowImport(true)
          }}
          title="导入 txt / md 全本或章节"
        />

        {stats && stats.targetWords > 0 && (
          <div className="relative flex items-center">
            <ToolButton
              icon="stats"
              label={`${chapters.length} 章 · ${totalWords.toLocaleString()} 字`}
              onClick={() => setMenu(m => (m === 'stats' ? '' : 'stats'))}
              active={menu === 'stats'}
              title="写作统计"
            />
            <Popover open={menu === 'stats'} onClose={() => setMenu('')} width={272}>
              <div className="px-2 py-1.5 text-[12px] text-[var(--text-dim)]">
                目标每章约 {stats.targetWords.toLocaleString()} 字
              </div>
              <div className="px-2 pb-1 text-[11px] text-[var(--text-faint)]">
                共 {stats.chapters} 章 {stats.words.toLocaleString()} 字 · 平均 {stats.avgWords.toLocaleString()} 字
              </div>
              {stats.deviations.length > 0 && (
                <div className="mt-1 max-h-56 space-y-0.5 overflow-y-auto pt-1">
                  {stats.deviations.map(d => (
                    <div
                      key={d.index}
                      className="flex items-center justify-between rounded-[7px] px-2 py-1 text-[11px]"
                    >
                      <span className="truncate text-[var(--text-dim)]">
                        第 {d.index} 章 {d.title}
                      </span>
                      <span className={d.deviation < 0 ? 'text-[var(--seal)]' : 'text-[var(--gold)]'}>
                        {d.deviation < 0 ? '偏短' : '偏长'} {Math.abs(d.deviation)}%
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </Popover>
          </div>
        )}

        <div className="preview-toolbar-primary ml-auto flex items-center gap-1">
          <ToolButton icon="copy" label={copied ? '已复制' : '复制本章'} onClick={copyCurrent} disabled={!current} />
          <div className="relative flex items-center">
            <ToolButton
              icon="export"
              label="导出"
              onClick={() => setMenu(m => (m === 'export' ? '' : 'export'))}
              active={menu === 'export'}
            />
            <Popover open={menu === 'export'} onClose={() => setMenu('')} width={176}>
              <button
                type="button"
                disabled={saving || typesetting}
                onClick={() => exportSaved(api.exportUrl(novel.id, 'md'))}
                className={menuItemCls}
              >
                Markdown
              </button>
              <button
                type="button"
                disabled={saving || typesetting}
                onClick={() => exportSaved(api.exportUrl(novel.id, 'txt'))}
                className={menuItemCls}
              >
                TXT 纯文本
              </button>
              <button
                type="button"
                disabled={saving || typesetting}
                onClick={() => exportSaved(api.exportHtmlUrl(novel.id))}
                className={menuItemCls}
              >
                HTML 网页
              </button>
              <button
                type="button"
                disabled={saving || typesetting}
                onClick={() => exportSaved(api.exportEpubUrl(novel.id))}
                className={menuItemCls}
              >
                EPUB 电子书
              </button>
            </Popover>
          </div>
          <button
            type="button"
            onClick={saveDraft}
            disabled={!dirty || saving || typesetting}
            className="btn btn--primary btn--sm ml-1"
          >
            {saving ? '保存中…' : dirty ? '保存' : '已保存'}
          </button>
        </div>
      </div>

      {/* ── 状态条：只承载「进行中的任务」，需要有稳定的落点 ── */}
      {running && job && (
        <div className="flex h-8 shrink-0 items-center gap-2 px-3">
          <span className="breathing h-1.5 w-1.5 rounded-full bg-[var(--gold)]" />
          <span className="text-[12px] text-[var(--text-dim)]">
            {job.kind === 'revise' ? '正在修改' : job.kind === 'polish' ? '正在润色' : '正在续写'} 第{' '}
            {job.chapterIndex ?? ''} 章
          </span>
          <span className="mono text-[11px] text-[var(--text-faint)]">{job.stream.replace(/\s/g, '').length} 字</span>
          <button onClick={stop} className="btn btn--danger btn--sm ml-auto">
            停笔
          </button>
        </div>
      )}

      <div className="preview-body flex min-h-0 flex-1">
        {/* ── 左：章节目录（可收起）── */}
        {showToc && (
          <aside className="preview-toc w-[232px] shrink-0 flex-col bg-[var(--rail)]" aria-label="章节目录">
            <div className="p-2.5">
              <div className="flex h-8 items-center gap-2 rounded-[9px] border border-transparent bg-[var(--panel)] px-2.5">
                <TIcon name="search" size={13} />
                <input
                  aria-label="搜索章节"
                  value={chSearch}
                  onChange={e => setChSearch(e.target.value)}
                  placeholder="搜索章节"
                  className="w-full min-w-0 border-0 bg-transparent text-[12px] text-[var(--text)] outline-none placeholder:text-[var(--text-faint)]"
                />
              </div>
            </div>
            <div className="flex items-center justify-between px-3 pb-1.5 text-[12px] text-[var(--text-faint)]">
              <span className="mono">
                {chapters.length} 章 · {totalWords.toLocaleString()} 字
              </span>
              <button
                onClick={() => {
                  setImportText('')
                  setImportResult('')
                  setShowImport(true)
                }}
                className="text-[12px] text-[var(--text-faint)] transition-colors hover:text-[var(--text)]"
              >
                导入
              </button>
            </div>
            <div ref={toc.ref} className="reader-scroll relative min-h-0 flex-1 overflow-y-auto px-2 pb-3">
              {shownChapters.length === 0 ? (
                <p className="px-2 py-6 text-center text-[12px] text-[var(--text-faint)]">
                  {chapters.length === 0 ? '还没有章节' : '没有匹配的章节'}
                </p>
              ) : (
                <>
                  <div style={{ height: toc.padTop }} />
                  {shownChapters.slice(toc.start, toc.end).map(c => {
                    const on = sel === c.index
                    return (
                      <div
                        key={c.index}
                        className={`group relative mb-0.5 flex h-[46px] items-center gap-2 rounded-[9px] px-2 transition ${
                          on ? 'bg-[var(--active)]' : 'hover:bg-[var(--hover)]'
                        }`}
                      >
                        <button
                          onClick={() => {
                            void selectChapter(c.index)
                          }}
                          disabled={typesetting}
                          aria-current={on ? 'true' : undefined}
                          className="flex h-full min-w-0 flex-1 flex-col justify-center text-left"
                        >
                          <div
                            className={`truncate text-[12px] ${on ? 'font-medium text-[var(--text)]' : 'text-[var(--text-dim)] group-hover:text-[var(--text)]'}`}
                          >
                            第 {c.index} 章 {c.title}
                          </div>
                          <div className="mono mt-0.5 text-[10px] text-[var(--text-faint)]">
                            {c.words.toLocaleString()} 字
                          </div>
                        </button>
                        <button
                          disabled={saving || typesetting || running}
                          onClick={() => removeChapter(c)}
                          title="删除本章"
                          aria-label={`删除第 ${c.index} 章`}
                          className="mr-1 hidden h-7 w-7 shrink-0 items-center justify-center rounded-[7px] text-[var(--text-faint)] transition hover:bg-[var(--panel2)] hover:text-[var(--seal)] group-hover:flex group-focus-within:flex focus-visible:flex"
                        >
                          <TIcon name="x" size={11} />
                        </button>
                      </div>
                    )
                  })}
                  <div style={{ height: toc.padBottom }} />
                </>
              )}
            </div>
          </aside>
        )}

        {/* ── 中：稿纸正文 ── */}
        <div className="flex min-w-0 flex-1 flex-col">
          {current ? (
            <>
              <div ref={readerRef} className={`reader-scroll min-h-0 flex-1 overflow-y-auto ${paperCls}`}>
                <div
                  className="preview-manuscript mx-auto px-10 py-12"
                  style={{ maxWidth: `${prefs.readingWidth}rem` }}
                >
                  <div className="mb-8 text-center">
                    <div className="text-[10px] tracking-[0.4em] text-[var(--text-faint)]">第 {current.index} 章</div>
                    <input
                      value={draftTitle}
                      aria-label="章节标题（可编辑）"
                      disabled={typesetting}
                      onChange={e => {
                        if (typesettingRef.current) return
                        draftTitleRef.current = e.target.value
                        setDraftTitle(e.target.value)
                        setSaveError('')
                      }}
                      placeholder="章节标题"
                      className="preview-chapter-title mt-2 w-full bg-transparent text-center text-[22px] font-medium text-[var(--text)] outline-none placeholder:text-[var(--text-faint)]"
                    />
                  </div>

                  {/* 稿纸即编辑器：只有这一种形态——稿纸底、常驻可编辑。
                      不再有「编辑 / 稿纸」两套视图需要手动切换，点进来就能直接改字。 */}
                  <textarea
                    ref={bodyRef}
                    value={draftContent}
                    aria-label="章节正文（可编辑）"
                    disabled={typesetting}
                    onChange={e => {
                      if (typesettingRef.current) return
                      draftContentRef.current = e.target.value
                      setDraftContent(e.target.value)
                      setSaveError('')
                    }}
                    spellCheck={false}
                    placeholder="正文……"
                    className={`reader-scroll min-h-[56vh] w-full resize-none bg-transparent outline-none placeholder:text-[var(--text-faint)] ${fontCls}`}
                    style={{
                      fontSize: prefs.fontSize,
                      lineHeight: prefs.lineHeight,
                      letterSpacing: `${prefs.letterSpacing}em`,
                      textAlign: prefs.align === 'justify' ? 'justify' : 'left'
                    }}
                  />
                </div>
              </div>

              {/* 底部状态条 */}
              <div className="preview-statusbar">
                <button
                  onClick={() => {
                    setImportText('')
                    setImportResult('')
                    setShowImport(true)
                  }}
                  className="text-[var(--text-dim)] transition-colors hover:text-[var(--text)]"
                >
                  导入章节
                </button>
                <div className="mono flex items-center gap-4">
                  {stats && stats.targetWords > 0 && (
                    <span>
                      计划：
                      {stats.targetWords > draftContent.replace(/\s/g, '').length
                        ? `还差 ${(stats.targetWords - draftContent.replace(/\s/g, '').length).toLocaleString()} 字`
                        : '已达标'}
                    </span>
                  )}
                  <span className="flex items-center gap-1.5">
                    <span className={`h-1.5 w-1.5 rounded-full ${dirty ? 'bg-[var(--amber)]' : 'bg-[var(--jade)]'}`} />
                    {saving ? '保存中…' : saveError ? '保存失败' : dirty ? '未保存' : '已保存'}
                  </span>
                  <span>本章：{draftContent.replace(/\s/g, '').length.toLocaleString()} 字</span>
                </div>
              </div>
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center px-8">
              <div className="text-center">
                <div className="text-[15px] font-medium text-[var(--text-dim)]">尚未成章</div>
                <p className="mt-2 max-w-sm text-[12px] leading-[1.8] text-[var(--text-faint)]">
                  到「正文」里逐章写作，或在此导入已有文稿，即可开始排版与导出。
                </p>
                <div className="mt-5 flex items-center justify-center gap-2">
                  <Link to={`/novel/${novel.id}?tab=write`} className="btn btn--primary btn--md">
                    前往正文
                  </Link>
                  <button
                    onClick={() => {
                      setImportText('')
                      setImportResult('')
                      setShowImport(true)
                    }}
                    className="btn btn--ghost btn--md"
                  >
                    导入文稿
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* ── 右：AI 面板 ── */}
        {showAiPanel && (
          <aside className="preview-ai-panel flex w-[320px] shrink-0 flex-col bg-[var(--rail)] max-lg:w-[280px]">
            <div className="flex h-11 items-center justify-between px-3">
              <span className="text-[13px] font-medium text-[var(--text)]">AI 写作</span>
              <button
                onClick={() => setShowAiPanel(false)}
                title="收起面板"
                aria-label="收起 AI 写作面板"
                className="flex h-7 w-7 items-center justify-center rounded-[7px] text-[var(--text-faint)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--text)]"
              >
                <TIcon name="x" size={13} />
              </button>
            </div>
            <div className="reader-scroll min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
              <div className="grid grid-cols-3 gap-1">
                {(
                  [
                    { k: 'continue', label: '续写', desc: '接着写完' },
                    { k: 'polish', label: '润色', desc: '整章提质' },
                    { k: 'revise', label: '修改', desc: '按问题改' }
                  ] as const
                ).map(m => (
                  <button
                    key={m.k}
                    aria-pressed={aiMode === m.k}
                    onClick={() => {
                      setAiMode(m.k)
                      setAiPrompt('')
                    }}
                    className={`rounded-[9px] px-2 py-1.5 text-left transition ${
                      aiMode === m.k
                        ? 'bg-[var(--active)] text-[var(--text)]'
                        : 'bg-[var(--panel2)] text-[var(--text-dim)] hover:bg-[var(--panel3)] hover:text-[var(--text)]'
                    }`}
                  >
                    <div className="text-[12px] font-medium">{m.label}</div>
                    <div className="mt-0.5 text-[10px] text-[var(--text-faint)]">{m.desc}</div>
                  </button>
                ))}
              </div>

              {models.length > 0 && (
                <label className="preview-model-field">
                  <span>使用模型</span>
                  <ModelSelect
                    value={aiModelId}
                    onChange={setAiModelId}
                    models={models}
                    placeholder="请选择模型"
                    className="w-full rounded-[9px] border border-transparent bg-[var(--panel2)] px-3 py-2 text-[13px]"
                  />
                </label>
              )}

              <textarea
                aria-label={aiMode === 'revise' ? '需要修改的问题（必填）' : 'AI 写作要求（可选）'}
                value={aiPrompt}
                onChange={e => setAiPrompt(e.target.value)}
                rows={5}
                placeholder={
                  aiMode === 'continue'
                    ? '续写要求（可选）：如「主角认出玉佩的主人，以此为钩子收章」'
                    : aiMode === 'polish'
                      ? '润色要求（可选）：如「多写雨夜的凉意，对话再利落些」'
                      : '要改的问题（必填）：如「主角反应不自然」「节奏太慢，前半段删减」'
                }
                className="w-full resize-none rounded-[9px] border border-transparent bg-[var(--panel2)] px-3 py-2 text-[13px] leading-[1.7] placeholder:text-[var(--text-faint)]"
              />

              <p className="text-[12px] leading-[1.7] text-[var(--text-faint)]">
                {aiMode === 'continue'
                  ? 'AI 接在现有文字后写完本章，已有内容不动。'
                  : aiMode === 'polish'
                    ? 'AI 重写整章：情节保留，只提升文字质感（原稿自动留档）。'
                    : 'AI 通读全章后，针对你提出的问题精准修改（原稿自动留档）。'}
              </p>

              <button
                onClick={startAi}
                disabled={
                  running || typesetting || !current || !models.length || (aiMode === 'revise' && !aiPrompt.trim())
                }
                className="btn btn--primary btn--md w-full"
              >
                {running
                  ? '进行中…'
                  : aiMode === 'continue'
                    ? '开始续写'
                    : aiMode === 'polish'
                      ? '开始润色'
                      : '开始修改'}
              </button>
            </div>
          </aside>
        )}
      </div>

      {/* ── 版本历史 ── */}
      {historyOpen && id && (
        <ModalShell title="版本历史" width={520} onClose={() => setHistoryOpen(false)} busy={!!historyBusy}>
          {history.length === 0 ? (
            <p className="py-10 text-center text-[12px] text-[var(--text-faint)]">
              暂无快照。一键排版、回滚等操作会自动在这里留档。
            </p>
          ) : (
            <div className="space-y-1.5">
              {history.map(h => (
                <div
                  key={h.id}
                  className="flex items-center justify-between gap-3 rounded-[9px] bg-[var(--panel2)] px-3 py-2.5"
                >
                  <div className="min-w-0">
                    <div className="truncate text-[12.5px] text-[var(--text)]">{h.label}</div>
                    <div className="mono mt-0.5 text-[11px] text-[var(--text-faint)]">
                      {new Date(h.at).toLocaleString()} · {h.chapters} 章 · {h.words.toLocaleString()} 字
                    </div>
                  </div>
                  <button
                    onClick={() => restoreHistory(h)}
                    disabled={!!historyBusy}
                    className="btn btn--ghost btn--sm shrink-0"
                  >
                    {historyBusy === h.id ? '回滚中…' : '回滚'}
                  </button>
                </div>
              ))}
            </div>
          )}
        </ModalShell>
      )}

      {/* ── 敏感词 / 过审检测 ── */}
      {sensOpen && (
        <ModalShell
          title="敏感词 / 过审检测"
          width={640}
          onClose={() => setSensOpen(false)}
          busy={!!sensBusy}
          maxHeight="80vh"
        >
          <p className="mb-4 text-[12px] leading-[1.8] text-[var(--text-dim)]">
            按内置词典（政治 / 色情低俗 / 暴力恐怖 / 违禁犯罪 / 辱骂 / 广告导流）扫描正文，全程离线；
            命中只做提示，改不改由你决定。词典是基础版，平台规则变化时以平台为准。
          </p>

          {!sensResult && !sensBusy && (
            <div className="flex gap-2">
              <button
                className="btn btn--outline btn--md flex-1"
                disabled={!current}
                onClick={() => runSensitive('chapter')}
              >
                检测本章{current ? `（第 ${current.index} 章）` : ''}
              </button>
              <button
                className="btn btn--primary btn--md flex-1"
                disabled={!chapters.length}
                onClick={() => runSensitive('all')}
              >
                检测全书（{chapters.length} 章）
              </button>
            </div>
          )}

          {sensBusy && (
            <div className="py-12 text-center text-[12px] text-[var(--text-faint)]">
              正在{sensBusy === 'chapter' ? '检测本章' : '通读全书'}……
            </div>
          )}

          {sensResult && !sensBusy && (
            <div className="space-y-4">
              <div
                className={`rounded-[10px] px-3.5 py-2.5 text-[12.5px] ${
                  sensResult.total
                    ? 'bg-[color-mix(in_srgb,var(--seal)_8%,var(--panel))] text-[var(--seal)]'
                    : 'bg-[color-mix(in_srgb,var(--jade)_10%,var(--panel))] text-[var(--jade)]'
                }`}
              >
                {sensResult.total
                  ? `检测完成（${sensScopeLabel}）：共 ${sensResult.total} 处命中，建议逐条确认后再投稿。`
                  : `检测完成（${sensScopeLabel}）：未命中内置词典；不代表平台审核结论。`}
              </div>

              {sensResult.total > 0 && (
                <>
                  <div className="flex flex-wrap gap-1.5">
                    {Object.entries(sensResult.byCategory).map(([cat, n]) => (
                      <span
                        key={cat}
                        className="rounded-[7px] bg-[var(--panel2)] px-2 py-0.5 text-[11px] text-[var(--text-dim)]"
                      >
                        {sensResult.categoryNames?.[cat] || cat} · {n}
                      </span>
                    ))}
                  </div>

                  <div className="space-y-4">
                    {sensResult.groups
                      .filter(g => g.count > 0)
                      .map(g => (
                        <div key={g.key}>
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-[12px] font-medium text-[var(--text)]">
                              {g.label}（{g.count} 处）
                            </span>
                            <button
                              className="text-[11px] text-[var(--gold)] hover:underline"
                              onClick={() => {
                                setSensOpen(false)
                                const idx = Number(g.key)
                                if (Number.isInteger(idx) && idx >= 0) void selectChapter(idx, true)
                              }}
                            >
                              去修改
                            </button>
                          </div>
                          <div className="mt-1.5 space-y-1">
                            {g.hits.map((h, i) => (
                              <div
                                key={i}
                                className="rounded-[8px] bg-[var(--panel2)] px-3 py-2 text-[11.5px] leading-[1.8] text-[var(--text-dim)]"
                              >
                                <span className="mono mr-2 text-[10px] text-[var(--text-faint)]">{h.categoryName}</span>
                                <span className="font-medium text-[var(--seal)]">{h.word}</span>
                                <span className="mx-1.5 text-[var(--text-faint)]">·</span>
                                {markContext(h.context, h.word)}
                              </div>
                            ))}
                            {g.count > g.hits.length && (
                              <p className="px-3 text-[10.5px] text-[var(--text-faint)]">
                                本章命中较多，仅显示前 {g.hits.length} 处。
                              </p>
                            )}
                          </div>
                        </div>
                      ))}
                  </div>
                </>
              )}

              <div className="flex justify-end">
                <button className="btn btn--ghost btn--sm" onClick={() => setSensResult(null)}>
                  重新选择范围
                </button>
              </div>
            </div>
          )}
        </ModalShell>
      )}

      {/* ── 导入弹窗 ── */}
      {showImport && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
          onClick={() => !importing && setShowImport(false)}
        >
          <div
            className="max-h-[84vh] w-[640px] overflow-y-auto rounded-[12px] bg-[var(--panel)] p-5 shadow-[var(--sh-4)]"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h2 className="text-[15px] font-semibold tracking-tight text-[var(--text)]">导入小说</h2>
              <button
                onClick={() => !importing && setShowImport(false)}
                title="关闭"
                aria-label="关闭导入窗口"
                disabled={importing}
                className="flex h-8 w-8 items-center justify-center rounded-[9px] text-[var(--text-faint)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--text)]"
              >
                <TIcon name="x" size={15} />
              </button>
            </div>
            <div className="hairline my-4" />
            <p className="mb-3 text-[12px] leading-[1.8] text-[var(--text-dim)]">
              支持 .txt / .md 文件或直接粘贴文本。自动按「第X章 / 第X卷 / 第X回 / 序章 / 楔子 / Chapter
              N」等标题切分章节；识别不到章节标题时按约 4000 字分段。
            </p>
            <div className="mb-4 flex items-center gap-3">
              <button onClick={pickFile} disabled={importing} className="btn btn--ghost btn--sm">
                选择本地文件
              </button>
              <label className="flex cursor-pointer items-center gap-1.5 text-[12px] text-[var(--text-dim)]">
                <input
                  type="checkbox"
                  checked={importReplace}
                  onChange={e => setImportReplace(e.target.checked)}
                  className="accent-[var(--gold)]"
                />
                替换现有章节（默认追加到末尾）
              </label>
            </div>
            <textarea
              className="w-full rounded-[9px] border border-transparent bg-[var(--panel2)] px-3 py-2.5 text-[13px] leading-[1.8] placeholder:text-[var(--text-faint)]"
              rows={12}
              aria-label="导入的小说文本"
              value={importText}
              onChange={e => setImportText(e.target.value)}
              placeholder="在这里粘贴小说全文，或点击上方「选择本地文件」……"
              disabled={importing}
            />
            <div className="mono mt-2 flex justify-between text-[11px] text-[var(--text-faint)]">
              <span>{importText ? `${importText.replace(/\s/g, '').length.toLocaleString()} 字` : ''}</span>
              <span>导入后可一键排版并交给 AI 续写或润色</span>
            </div>
            {importResult && (
              <div className="mt-3 rounded-[9px] border border-[color-mix(in_srgb,var(--jade)_32%,var(--line))] bg-[color-mix(in_srgb,var(--jade)_8%,var(--panel))] px-3 py-2 text-[12px] text-[var(--jade)]">
                {importResult}
              </div>
            )}
            <div className="mt-5 flex justify-end gap-2">
              <button onClick={() => setShowImport(false)} disabled={importing} className="btn btn--ghost btn--md">
                取消
              </button>
              <button
                onClick={doImport}
                disabled={importing || !importText.trim()}
                className="btn btn--primary btn--md"
              >
                {importing ? '导入中……' : '开始导入'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
