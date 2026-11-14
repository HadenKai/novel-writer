import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import './review.css'
import { api } from '../lib/api'
import { useNovel } from '../lib/hooks/useNovel'
import { useJob } from '../lib/hooks/useJob'
import { useModels } from '../lib/hooks/useModels'
import ModelSelect from '../components/ModelSelect'
import { confirmDialog } from '../components/Dialog'
import { toast } from '../components/Toast'
import { InkLandscape } from '../components/InkArt'
import { diffSentences, type DiffPart } from './review-diff'
import type { GenJob, RevisionProposal } from '../types'

type Tab = 'refine' | 'revise' | 'detect' | 'deai'
type RefineMode = 'continue' | 'polish'

/** 顶部模式按钮：续写 / 润色同属「精修」（tab=refine），修改 / 降 AI 味 / 检测各自一种 */
const MODES: { tab: Tab; mode?: RefineMode; label: string; hint: string; icon: string }[] = [
  { tab: 'refine', mode: 'continue', label: '续写', hint: '从断点接着写完本章', icon: 'quill' },
  { tab: 'refine', mode: 'polish', label: '润色', hint: '整章重写，提升文字质感', icon: 'sparkle' },
  { tab: 'revise', label: '修改', hint: '通读后按你提出的问题逐章修改', icon: 'pen' },
  { tab: 'deai', label: '降 AI 味', hint: '减少模板句式与机械节奏', icon: 'waves' },
  { tab: 'detect', label: '检测', hint: '分析 AI 痕迹，只出报告不改原稿', icon: 'scan' }
]

/** 一次审校任务的全部参数：「开始」取自左栏，「重新生成」取自上一次任务 */
interface LaunchConfig {
  tab: Tab
  refineMode: RefineMode
  indices: number[]
  text: string
  modelId: string
  /** 重新生成时会被替换掉的未采纳候选稿数 */
  replacing?: number
}

/** 本页负责的任务：批量精修（续写 / 润色 / 修改 / 降AI）与 AI 痕迹检测 */
function isRefineJob(j: GenJob): boolean {
  return (
    j.type === 'detect' ||
    (j.type === 'chapter' && (j.kind === 'continue' || j.kind === 'polish' || j.kind === 'revise' || j.kind === 'deai'))
  )
}

/** 字数：与正文统计一致，不计空白 */
const countChars = (s: string) => s.replace(/\s/g, '').length

/** 线性图标：1.5px 描边、currentColor */
const ICON_PATHS: Record<string, ReactNode> = {
  quill: (
    <>
      <path d="M20 4c-6 .5-11 4.5-13.5 11L5 20" />
      <path d="M20 4c-.5 5.5-4 10-10 11.5" />
      <path d="M9.5 10.5h5" />
    </>
  ),
  sparkle: (
    <>
      <path d="M10 4.5l1.5 4.5L16 10.5l-4.5 1.5L10 16.5 8.5 12 4 10.5 8.5 9z" />
      <path d="M18 3.5v4M16 5.5h4M18 15.5v3.5M16.25 17.25h3.5" />
    </>
  ),
  pen: (
    <>
      <path d="M15.5 5.5l3 3L8 19H5v-3z" />
      <path d="M13.5 7.5l3 3" />
    </>
  ),
  waves: <path d="M4 8c2.5-2 5.5 2 8 0s5.5 2 8 0M4 12.5c2.5-2 5.5 2 8 0s5.5 2 8 0M4 17c2.5-2 5.5 2 8 0s5.5 2 8 0" />,
  scan: (
    <>
      <path d="M4 8.5V5.5A1.5 1.5 0 0 1 5.5 4h3M15.5 4h3A1.5 1.5 0 0 1 20 5.5v3M20 15.5v3a1.5 1.5 0 0 1-1.5 1.5h-3M8.5 20h-3A1.5 1.5 0 0 1 4 18.5v-3" />
      <path d="M8 12h8" />
    </>
  ),
  compare: (
    <>
      <rect x="4" y="5" width="16" height="14" rx="1.5" />
      <path d="M12 5v14" />
    </>
  ),
  stream: <path d="M5 7h14M5 11.5h14M5 16h9" />,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  'check-circle': (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M8.5 12.2l2.4 2.4 4.6-4.8" />
    </>
  ),
  refresh: (
    <>
      <path d="M19.5 5v4.5H15" />
      <path d="M18.6 14.5a7 7 0 1 1-1.4-7.3L19.5 9.5" />
    </>
  ),
  'chevron-left': <path d="M14.5 6l-6 6 6 6" />,
  'chevron-right': <path d="M9.5 6l6 6-6 6" />,
  info: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 11v5M12 8h.01" />
    </>
  )
}

function RIcon({ name, size = 16 }: { name: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {ICON_PATHS[name]}
    </svg>
  )
}

/** 句级差异正文：<del>/<ins> 让读屏也能读出「删除 / 插入」 */
function DiffText({ parts, tone }: { parts: DiffPart[]; tone: 'del' | 'ins' }) {
  return (
    <>
      {parts.map((p, i) =>
        !p.changed ? (
          <span key={i}>{p.text}</span>
        ) : tone === 'del' ? (
          <del key={i} className="review-del">
            {p.text}
          </del>
        ) : (
          <ins key={i} className="review-ins">
            {p.text}
          </ins>
        )
      )}
    </>
  )
}

/** 对照稿纸：┃ 标题 + 「共 N 字」页头，下面是宣纸稿面 */
function Sheet({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <section className="review-sheet ink-card">
      <header className="review-sheet-head">
        <h3 className="ink-bar-title">{title}</h3>
        <span className="review-sheet-count mono">共 {count.toLocaleString()} 字</span>
      </header>
      <div className="review-sheet-paper ink-paper ink-on-paper">
        <InkLandscape className="review-sheet-art" moon={false} />
        <div className="review-sheet-scroll reader-scroll" tabIndex={0} aria-label={`${title}正文`}>
          <p className="review-sheet-text">{children}</p>
        </div>
      </div>
    </section>
  )
}

export default function Refine() {
  const { id } = useParams()
  const { novel, loadError, reload } = useNovel(id)
  const models = useModels()

  const [error, setError] = useState('')
  const [showThinking, setShowThinking] = useState(false)
  const [accepting, setAccepting] = useState('')
  const [acceptingAll, setAcceptingAll] = useState(false)
  const acceptingRef = useRef(false)
  const startBusyRef = useRef(false)
  const [starting, setStarting] = useState(false)

  const [tab, setTab] = useState<Tab>('refine')
  const [refineMode, setRefineMode] = useState<RefineMode>('continue')
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [prompt, setPrompt] = useState('')
  const [issue, setIssue] = useState('')
  const [modelId, setModelId] = useState('')
  // 对照区：当前查看的候选稿；视图 auto = 运行中看生成过程、结束后看对照
  const [activeId, setActiveId] = useState('')
  const [view, setView] = useState<'auto' | 'compare' | 'stream'>('auto')

  const paperRef = useRef<HTMLDivElement>(null)
  const switchRef = useRef<HTMLDivElement>(null)

  // 任务生命周期（认领 / 启动 / 增量轮询 / 收尾）统一由 useJob 托管
  const { job, setJob, running, claimRunning, startJob, stop } = useJob({
    claim: isRefineJob,
    onSettled: j => {
      if (j.type === 'chapter') void reload()
      const label =
        j.type === 'detect'
          ? 'AI 检测'
          : j.kind === 'deai'
            ? '批量降AI'
            : j.kind === 'revise'
              ? '批量修改'
              : j.kind === 'polish'
                ? '批量润色'
                : '批量续写'
      if (j.status === 'done') toast.success(j.previewOnly ? '审校建议已生成，原稿保持不变。' : `${label}已完成。`)
      if (j.status === 'stopped') toast(j.savedDraft ? '已停笔，已生成的部分已存为草稿。' : '已停笔。')
      if (j.status === 'error') setError(j.savedDraft ? `${j.error}（已生成的部分已存为草稿）` : j.error)
    }
  })

  // 刷新 / 重新进入页面时接回正在跑的任务
  useEffect(() => {
    if (id) void claimRunning(id)
  }, [id, claimRunning])

  // 稿纸自动跟随
  useEffect(() => {
    const el = paperRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120
    if (nearBottom) el.scrollTop = el.scrollHeight
  }, [job?.stream])

  // 当前查看的候选稿：用户点选的 → 第一份待采纳的 → 第一份
  const proposals: RevisionProposal[] = job?.proposals || []
  const current =
    proposals.find(p => p.id === activeId) || proposals.find(p => p.status === 'pending') || proposals[0] || null
  const curOriginal = current?.original ?? ''
  const curContent = current?.content ?? ''
  // 轮询每秒都会换新对象，按文本记忆，正文不变就不重算
  const diff = useMemo(() => diffSentences(curOriginal, curContent), [curOriginal, curContent])

  // 切换候选稿时把对应的章节胶囊滚进可视区
  const currentId = current?.id
  useEffect(() => {
    if (!currentId) return
    const chip = switchRef.current?.querySelector<HTMLElement>('[aria-pressed="true"]')
    chip?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [currentId])

  if (!novel) return <div className="p-10 text-[var(--text-dim)]">{error || loadError || '加载中……'}</div>

  const chapters = [...(novel.chapters || [])].filter(c => c.content?.trim()).sort((a, b) => a.index - b.index)
  const streamText = job ? job.stream : ''
  const displayStream = job?.type === 'outline' ? '' : streamText
  const reasoningText = job ? job.reasoning : ''
  const pending = proposals.filter(p => p.status === 'pending')
  const showCompare = !!current && (view === 'compare' || (view === 'auto' && !running))
  const reviewNotes = (job?.review?.issues || []).filter(it => it.quote || it.fix)
  const reviewSummary = job?.review?.summary || ''
  const activeMode = MODES.find(m => m.tab === tab && (tab !== 'refine' || m.mode === refineMode)) || MODES[0]

  const toggle = (idx: number) =>
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(idx)) next.delete(idx)
      else next.add(idx)
      return next
    })

  /** 发起一次审校；返回是否真的启动了（取消确认、校验不过都算没启动） */
  const launch = async (cfg: LaunchConfig): Promise<boolean> => {
    if (!id || running || startBusyRef.current || !models.length) return false
    startBusyRef.current = true
    setStarting(true)
    try {
      return await launchInner(cfg)
    } finally {
      startBusyRef.current = false
      setStarting(false)
    }
  }

  const launchInner = async (cfg: LaunchConfig): Promise<boolean> => {
    if (!id) return false
    const indices = cfg.indices.filter(index => chapters.some(c => c.index === index)).sort((a, b) => a - b)
    if (!indices.length) {
      setError('请选择要处理的章节')
      return false
    }
    if (cfg.tab === 'revise' && !cfg.text.trim()) {
      setError('请描述需要修改的问题')
      return false
    }
    setError('')

    // 破坏性动作先确认（每章改动前都会自动存版本快照，可到「导出」页的历史里回滚）
    const confirmCopy: Partial<Record<Tab, { title: string; body: string; confirmText: string }>> = {
      deai: {
        title: `对选中的 ${indices.length} 章「降 AI 痕迹」？`,
        body: '生成改写建议，不修改原稿。你可以逐章对照并采纳。',
        confirmText: '开始改写'
      },
      revise: {
        title: `AI 将依次通读并修改选中的 ${indices.length} 章`,
        body: '只生成审校建议，原稿保持不变。检查对照结果后再决定是否采纳。',
        confirmText: '开始修改'
      },
      refine: {
        title:
          cfg.refineMode === 'polish'
            ? `依次润色选中的 ${indices.length} 章？`
            : `依次续写选中的 ${indices.length} 章？`,
        body: '只生成候选稿，不直接覆盖正文。采纳前会检查原稿是否变化并留存版本。',
        confirmText: cfg.refineMode === 'polish' ? '开始润色' : '开始续写'
      }
    }
    const ask = confirmCopy[cfg.tab]
    if (ask && cfg.replacing) ask.body += `\n当前还有 ${cfg.replacing} 份未采纳的候选稿，重新生成后将被替换。`
    if (ask && !(await confirmDialog(ask))) return false

    const text = cfg.text.trim()
    const model = cfg.modelId || undefined
    const r = await startJob(() => {
      if (cfg.tab === 'detect') return api.detectAI(id, indices, model)
      if (cfg.tab === 'deai') return api.startBatchRefine(id, 'deai', indices, text, model)
      if (cfg.tab === 'revise') return api.startBatchRefine(id, 'revise', indices, text, model)
      return api.startBatchRefine(id, cfg.refineMode, indices, text, model)
    })
    if (!r.ok) {
      setError(r.error)
      return false
    }
    setShowThinking(false)
    setActiveId('')
    setView('auto')
    return true
  }

  const start = () =>
    launch({
      tab,
      refineMode,
      indices: [...selected],
      text: tab === 'revise' ? issue : tab === 'detect' ? '' : prompt,
      modelId
    })

  /** 重新生成：沿用上一次任务的模式、章节、要求与模型；启动后左栏同步成这组设置 */
  const regenerate = async () => {
    if (!job || job.type !== 'chapter') return
    const kind = job.kind
    const cfg: LaunchConfig = {
      tab: kind === 'revise' ? 'revise' : kind === 'deai' ? 'deai' : 'refine',
      refineMode: kind === 'polish' ? 'polish' : 'continue',
      indices: job.chapterIndices?.length ? [...job.chapterIndices] : proposals.map(p => p.index),
      text: job.extraPrompt || '',
      modelId: job.modelId || '',
      replacing: pending.length
    }
    if (!(await launch(cfg))) return
    setTab(cfg.tab)
    setRefineMode(cfg.refineMode)
    setSelected(new Set(cfg.indices.filter(index => chapters.some(c => c.index === index))))
    if (cfg.tab === 'revise') setIssue(cfg.text)
    else setPrompt(cfg.text)
    setModelId(cfg.modelId)
  }

  /** 逐章采纳：每章都走服务端的原稿版本检查；遇到冲突或失败就停下，已采纳的保留 */
  const acceptProposals = async (targets: RevisionProposal[], all: boolean) => {
    if (!job || !targets.length || acceptingRef.current) return
    acceptingRef.current = true
    setAcceptingAll(all)
    setError('')
    let done = 0
    try {
      for (const p of targets) {
        setAccepting(p.id)
        await api.acceptProposal(job.id, p.id)
        done++
      }
      setJob(await api.getJob(job.id))
      await reload()
      toast.success(done > 1 ? `已采纳 ${done} 章建议，原稿版本已留存。` : '已采纳，原稿版本已留存。')
    } catch (e) {
      const message = (e as Error).message
      const failed = targets[done]
      setError(
        done > 0 && failed
          ? `已采纳 ${done} 章；第 ${failed.index} 章未采纳：${message}`
          : failed
            ? `第 ${failed.index} 章未采纳：${message}`
            : message
      )
      // 前面几章已经写入正文：同步任务状态与章节，免得界面还显示「待采纳」
      if (done > 0) {
        await api
          .getJob(job.id)
          .then(setJob)
          .catch(() => {})
        await reload()
      }
    } finally {
      acceptingRef.current = false
      setAccepting('')
      setAcceptingAll(false)
    }
  }

  // 采纳时把当前稿钉住，写入后仍停在这一章显示「已采纳」，不自动跳走
  const acceptCurrent = () => {
    if (!current || current.status !== 'pending') return
    setActiveId(current.id)
    void acceptProposals([current], false)
  }
  const acceptAll = () => {
    if (current) setActiveId(current.id)
    void acceptProposals(pending, true)
  }

  const curIndex = current ? proposals.findIndex(p => p.id === current.id) : -1
  const goProposal = (i: number) => {
    const p = proposals[i]
    if (p) setActiveId(p.id)
  }

  const jobLabel = running
    ? job?.type === 'detect'
      ? `正在检测第 ${job?.chapterIndex} 章 · AI 痕迹分析`
      : job?.kind === 'deai'
        ? `正在降AI第 ${job?.chapterIndex} 章 · 清除机器写法`
        : job?.kind === 'revise'
          ? `正在修改第 ${job?.chapterIndex} 章 · 通读后针对性修改`
          : job?.kind === 'polish'
            ? `正在润色第 ${job?.chapterIndex} 章 · 整章重写`
            : `正在续写第 ${job?.chapterIndex} 章 · 从断点接笔`
    : ''

  const waitingHint = !streamText && running ? '正在研读章节内容……' : ''
  const busy = running || starting
  const countLabel = selected.size ? ` (${selected.size}章)` : ''
  const startLabel = busy
    ? '处理中…'
    : tab === 'detect'
      ? `开始检测${countLabel}`
      : tab === 'revise'
        ? `开始修改${countLabel}`
        : tab === 'deai'
          ? `开始降AI${countLabel}`
          : `开始批量${refineMode === 'polish' ? '润色' : '续写'}${countLabel}`
  const startDisabled = busy || !models.length || selected.size === 0 || (tab === 'revise' && !issue.trim())
  // 每屏一个鎏金主操作：有待采纳的候选稿时，「采纳全部」是主操作，开始按钮退为描边
  const startCls = pending.length && showCompare ? 'btn btn--outline btn--md' : 'btn btn--primary btn--md'
  const acceptStep = acceptingAll ? pending.findIndex(p => p.id === accepting) + 1 : 0

  return (
    <div className="review-page">
      <div className="review-layout">
        <h1 className="sr-only">审校</h1>

        {/* ── 顶部：模式按钮 ── */}
        <div className="review-top">
          <div className="review-modes" role="group" aria-label="审校方式">
            {MODES.map(m => {
              const on = tab === m.tab && (m.tab !== 'refine' || refineMode === m.mode)
              return (
                <button
                  key={m.label}
                  type="button"
                  className="review-mode"
                  aria-pressed={on}
                  title={m.hint}
                  disabled={busy}
                  onClick={() => {
                    setTab(m.tab)
                    if (m.mode) setRefineMode(m.mode)
                  }}
                >
                  <RIcon name={m.icon} size={17} />
                  {m.label}
                </button>
              )
            })}
          </div>
          {!!proposals.length && (
            <div className="review-view-toggle" role="group" aria-label="右侧视图">
              <button type="button" aria-pressed={showCompare} onClick={() => setView('compare')}>
                <RIcon name="compare" size={15} />
                对比视图
              </button>
              <button type="button" aria-pressed={!showCompare} onClick={() => setView('stream')}>
                <RIcon name="stream" size={15} />
                生成过程
              </button>
            </div>
          )}
        </div>

        {error && (
          <div className="review-alert" role="alert">
            {error}
          </div>
        )}

        <div className="review-body">
          {/* ── 左：控制栏 ── */}
          <aside className="review-rail ink-card" aria-label="审校设置">
            <div className="review-rail-head">
              <h2 className="ink-bar-title">选择章节</h2>
              <button
                type="button"
                className="review-link"
                disabled={!chapters.length || busy}
                onClick={() =>
                  setSelected(selected.size === chapters.length ? new Set() : new Set(chapters.map(c => c.index)))
                }
              >
                {selected.size === chapters.length ? '取消全选' : '全选'}
              </button>
            </div>
            <p className="review-rail-meta">
              {chapters.length} 章可审校 · 已选 <strong className="mono">{selected.size}</strong> 章
            </p>

            {chapters.length === 0 ? (
              <div className="review-empty ink-well">
                <p>还没有可审校的正文。先写作或导入章节，再回来检查。</p>
                <Link to={`/novel/${id}?tab=write`} className="btn btn--primary btn--sm">
                  前往正文
                </Link>
              </div>
            ) : (
              <div className="review-chapters ink-well reader-scroll">
                {chapters.map(c => {
                  const checked = selected.has(c.index)
                  return (
                    <label
                      key={c.index}
                      className={`review-chapter${checked ? ' is-checked' : ''}${busy ? ' is-disabled' : ''}`}
                    >
                      <input
                        type="checkbox"
                        className="ink-check"
                        checked={checked}
                        disabled={busy}
                        onChange={() => toggle(c.index)}
                      />
                      <span className="review-chapter-no mono">第 {c.index} 章</span>
                      <span className="review-chapter-title">{c.title}</span>
                      <span className="review-chapter-words mono">{c.words.toLocaleString()}字</span>
                    </label>
                  )
                })}
              </div>
            )}

            <div className="review-mode-intro">
              <strong>{activeMode.label}</strong>
              <span>{activeMode.hint}</span>
            </div>

            {/* 精修模式：可选指令 */}
            {tab === 'refine' && (
              <div className="review-field mode-fade">
                <label htmlFor="review-refine-prompt" className="review-field-label">
                  {refineMode === 'polish' ? '润色要求（可选）' : '续写要求（可选）'}
                </label>
                <textarea
                  id="review-refine-prompt"
                  aria-label="审校附加要求（可选）"
                  value={prompt}
                  onChange={e => setPrompt(e.target.value)}
                  rows={3}
                  placeholder={
                    refineMode === 'polish' ? '如「多写雨夜凉意，对话再利落些」' : '如「以腰牌反转为钩子收章」'
                  }
                  className="ink-input review-textarea"
                />
              </div>
            )}

            {/* 修改模式：问题描述 */}
            {tab === 'revise' && (
              <div className="review-field mode-fade">
                <label htmlFor="review-issue" className="review-field-label">
                  需要修改的问题（必填，对所有选中章节生效）
                </label>
                <textarea
                  id="review-issue"
                  aria-label="需要修改的问题（必填）"
                  required
                  value={issue}
                  onChange={e => setIssue(e.target.value)}
                  rows={4}
                  placeholder={
                    '描述问题，如：\n· 主角反应不自然，应更纠结\n· 节奏太慢，前半段删减\n· 反派出场太突兀，需要铺垫'
                  }
                  className="ink-input review-textarea"
                />
                <p className="review-field-hint">AI 会先通读每章全文，再针对你的问题逐章修改</p>
              </div>
            )}

            {/* 降AI模式说明 */}
            {tab === 'deai' && (
              <div className="review-field mode-fade">
                <p className="review-note-box ink-well">
                  生成减少模板句式、重复比喻与机械节奏的候选稿。请核对情节与表达；采纳前不会修改正文，也不保证任何检测评分。
                </p>
                <label htmlFor="review-deai-prompt" className="review-field-label">
                  附加要求（可选）
                </label>
                <textarea
                  id="review-deai-prompt"
                  aria-label="审校附加要求（可选）"
                  value={prompt}
                  onChange={e => setPrompt(e.target.value)}
                  rows={2}
                  placeholder="如「对话再口语化些」「保留方言腔」"
                  className="ink-input review-textarea"
                />
              </div>
            )}

            {/* 模型选择 */}
            {models.length > 0 ? (
              <label className="review-field">
                <span className="review-field-label">使用模型</span>
                <ModelSelect
                  value={modelId}
                  onChange={setModelId}
                  models={models}
                  placeholder="请选择模型"
                  className="ink-input review-model"
                />
                <span className="review-field-hint">仅用于本次审校，不影响本书设定</span>
              </label>
            ) : (
              <div className="review-empty ink-well" role="status">
                <p>暂无可用模型，配置后即可审校。</p>
                <Link to="/settings" className="btn btn--outline btn--sm">
                  前往设置
                </Link>
              </div>
            )}

            {running && jobLabel && (
              <p className="review-running" role="status">
                <span className="ink-dot ink-dot--gold" aria-hidden="true" />
                {jobLabel}
              </p>
            )}

            {/* 开始 / 停笔 */}
            <div className="review-actions">
              <button type="button" onClick={start} disabled={startDisabled} className={startCls}>
                {startLabel}
              </button>
              {running && (
                <button type="button" onClick={stop} className="btn btn--danger btn--md">
                  停笔
                </button>
              )}
            </div>
          </aside>

          {/* ── 右：原稿 / 修改稿对照，或生成过程 ── */}
          {showCompare && current ? (
            <section className="review-main" aria-label="候选稿预览与采纳">
              {proposals.length > 1 && (
                <div className="review-switch">
                  <button
                    type="button"
                    className="review-switch-nav"
                    aria-label="上一章候选稿"
                    disabled={curIndex <= 0}
                    onClick={() => goProposal(curIndex - 1)}
                  >
                    <RIcon name="chevron-left" />
                  </button>
                  <div ref={switchRef} className="review-switch-list" role="group" aria-label="切换候选稿章节">
                    {proposals.map(p => (
                      <button
                        key={p.id}
                        type="button"
                        className="review-switch-chip"
                        aria-pressed={p.id === current.id}
                        title={`第 ${p.index} 章 · ${p.title}`}
                        aria-label={`第 ${p.index} 章 ${p.title}，${p.status === 'accepted' ? '已采纳' : '待采纳'}`}
                        onClick={() => setActiveId(p.id)}
                      >
                        <span
                          className={`ink-dot ${p.status === 'accepted' ? 'ink-dot--jade' : 'ink-dot--gold'}`}
                          aria-hidden="true"
                        />
                        第 {p.index} 章
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    className="review-switch-nav"
                    aria-label="下一章候选稿"
                    disabled={curIndex >= proposals.length - 1}
                    onClick={() => goProposal(curIndex + 1)}
                  >
                    <RIcon name="chevron-right" />
                  </button>
                  <span className="review-switch-count mono">
                    {curIndex + 1} / {proposals.length}
                  </span>
                </div>
              )}

              <header className="review-compare-head">
                <h2 className="review-compare-title">
                  第 {current.index} 章 · {current.title}
                </h2>
                <span
                  className={`ink-status ${current.status === 'accepted' ? 'ink-status--jade' : 'ink-status--gold'}`}
                  role="status"
                >
                  {current.status === 'accepted' ? '已写入正文，原稿版本已留存' : '待采纳 · 原稿保持不变'}
                </span>
                <span className="review-legend">
                  {diff.removed || diff.added ? (
                    <>
                      <span>
                        <i className="is-del" aria-hidden="true" />
                        删改 {diff.removed} 句
                      </span>
                      <span>
                        <i className="is-ins" aria-hidden="true" />
                        新增 {diff.added} 句
                      </span>
                    </>
                  ) : (
                    <span>与原稿一致</span>
                  )}
                </span>
              </header>

              <div className="review-compare">
                <Sheet title="原稿" count={countChars(curOriginal)}>
                  <DiffText parts={diff.original} tone="del" />
                </Sheet>
                <Sheet title={current.status === 'accepted' ? '已采纳稿' : '修改稿'} count={countChars(curContent)}>
                  <DiffText parts={diff.candidate} tone="ins" />
                </Sheet>
              </div>

              {/* 修改说明：任务带审稿意见时才显示 */}
              {(reviewNotes.length > 0 || !!reviewSummary) && (
                <section className="review-notes ink-card" aria-label="修改说明">
                  <h3 className="ink-bar-title">修改说明</h3>
                  {reviewSummary && <p className="review-notes-summary">{reviewSummary}</p>}
                  {reviewNotes.length > 0 && (
                    <ul>
                      {reviewNotes.map((it, i) => (
                        <li key={i}>
                          <RIcon name="check-circle" />
                          <span>
                            {it.quote && <q>{it.quote}</q>}
                            {it.quote && it.fix ? '：' : ''}
                            {it.fix}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              )}

              {/* 底部操作条 */}
              <div className="review-bar">
                <span className="review-bar-count">
                  共 <strong className="mono">{proposals.length}</strong> 条候选稿
                  {proposals.length > 1 && ` · 待采纳 ${pending.length}`}
                </span>
                {running && <span className="review-bar-hint">任务仍在进行，结束后才能采纳</span>}
                <div className="review-bar-actions">
                  <button
                    type="button"
                    className="btn btn--primary btn--md"
                    disabled={running || !!accepting || !pending.length}
                    onClick={acceptAll}
                  >
                    <RIcon name="check" />
                    {acceptingAll ? `采纳中 ${Math.max(acceptStep, 1)}/${pending.length}…` : '采纳全部'}
                  </button>
                  <button
                    type="button"
                    className="btn btn--outline btn--md"
                    disabled={running || !!accepting || current.status !== 'pending'}
                    onClick={acceptCurrent}
                  >
                    {current.status === 'accepted'
                      ? '已采纳'
                      : accepting === current.id && !acceptingAll
                        ? '采纳中…'
                        : '仅采纳当前'}
                  </button>
                  <button
                    type="button"
                    className="btn btn--outline btn--md"
                    disabled={busy || !!accepting || !models.length || job?.type !== 'chapter'}
                    onClick={regenerate}
                    title="沿用上一次的模式、章节、要求与模型重新生成"
                  >
                    <RIcon name="refresh" />
                    重新生成
                  </button>
                </div>
              </div>
            </section>
          ) : (
            <section className="review-main" aria-label="生成预览">
              <div className="review-policy" role="note">
                <RIcon name="info" />
                AI 只提出建议，决定权在你。候选稿生成后可逐章对照；采纳前自动检查原稿版本。
              </div>

              <div className="review-output ink-paper ink-on-paper">
                <InkLandscape className="review-output-art" moon={false} />
                <div className="review-output-head">
                  <span className="review-output-label">
                    {running && <span className="ink-dot ink-dot--gold" aria-hidden="true" />}
                    {jobLabel || (job?.type === 'detect' ? '检测结果' : '生成预览 · 非正文')}
                  </span>
                  {displayStream && (
                    <span className="review-output-count mono">{countChars(displayStream).toLocaleString()} 字</span>
                  )}
                </div>

                {reasoningText && (
                  <div className="review-thinking">
                    <button
                      type="button"
                      aria-expanded={showThinking}
                      onClick={() => setShowThinking(v => !v)}
                      className="review-thinking-toggle"
                    >
                      <span className={`ink-dot ink-dot--jade${running ? ' is-live' : ''}`} aria-hidden="true" />
                      <span>思考过程</span>
                      <span className="mono">{countChars(reasoningText).toLocaleString()} 字</span>
                      <span className="review-thinking-state">{showThinking ? '收起' : '展开'}</span>
                    </button>
                    {showThinking && <div className="review-thinking-body reader-scroll">{reasoningText}</div>}
                  </div>
                )}

                <div
                  ref={paperRef}
                  className={`review-output-body reader-scroll${displayStream ? '' : ' is-idle'}`}
                  tabIndex={0}
                  aria-label="生成内容"
                >
                  {displayStream ||
                    (running ? (
                      <span>
                        {waitingHint}
                        <span className="review-caret">▍</span>
                      </span>
                    ) : job && job.status !== 'running' ? (
                      job.status === 'done' ? (
                        '已完成。'
                      ) : job.status === 'stopped' ? (
                        '已停笔。'
                      ) : (
                        `执行失败：${job.error}`
                      )
                    ) : (
                      '选择章节与审校方式后，结果会显示在这里。\n\n改写类任务生成候选稿，可逐章对照并采纳。检测结果仅供参考。任务可在后台继续。'
                    ))}
                </div>
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  )
}
