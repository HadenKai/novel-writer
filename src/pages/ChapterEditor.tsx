import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useParams, Link } from 'react-router-dom'
import { api, ApiError } from '../lib/api'
import { useNovel } from '../lib/hooks/useNovel'
import { useJob } from '../lib/hooks/useJob'
import { useModels } from '../lib/hooks/useModels'
import ModelSelect from '../components/ModelSelect'
import { Seal } from '../components/InkArt'
import { toast } from '../components/Toast'
import {
  CloseIcon,
  ContinueIcon,
  CopyIcon,
  PolishIcon,
  QuillIcon,
  ReviseIcon,
  SparkIcon,
  StopIcon
} from './writing-icons'
import type { Chapter } from '../types'

/** 写作页的 AI 面板：四种写作方式，产物一律先预览、由作者决定是否采用 */
type AiMode = 'write' | 'continue' | 'polish' | 'revise'
const AI_MODES: { key: AiMode; label: string; icon: ReactNode; hint: string }[] = [
  {
    key: 'write',
    label: '起草',
    icon: <QuillIcon />,
    hint: '按本章大纲与设定写出完整一章；已有正文会被整章替换，原稿自动留档。'
  },
  { key: 'continue', label: '续写', icon: <ContinueIcon />, hint: '接着现有正文往下写，不推翻已经写好的部分。' },
  { key: 'polish', label: '润色', icon: <PolishIcon />, hint: '保留情节与人物，重写文字、节奏与描写。' },
  { key: 'revise', label: '改写', icon: <ReviseIcon />, hint: '在下方写明要改什么，AI 通读全章后针对性修改。' }
]
const AI_STAGE_LABEL: Record<string, string> = {
  plan: '构思',
  draft: '起草',
  review: '自检',
  revise: '修订',
  done: '完成'
}

interface EditorProps {
  embedded?: boolean
  toolbarControls?: ReactNode
}
interface Draft {
  title: string
  content: string
  oid?: string
  expectedTitle?: string
  expectedContent?: string
}
interface EditingSession {
  base: Chapter | null
  title: string
  content: string
  key: string
  owner: string
  lastDraft: string | null
  saving: boolean
  blocked: boolean
  conflict: boolean
  recovered: boolean
  cacheFailed: boolean
  error: string
  notice: string
  composing: boolean
}

const hasChanges = (s: EditingSession) => !!s.base && (s.title.trim() !== s.base.title || s.content !== s.base.content)

/** 即便单独使用此页，换书/换章也创建独立会话，异步保存不会串章。 */
export default function ChapterEditor(props: EditorProps) {
  const { id, cid } = useParams()
  return <ChapterDocument key={`${id}:${cid}`} {...props} />
}

function ChapterDocument({ embedded = false, toolbarControls }: EditorProps) {
  const { id, cid } = useParams()
  const { novel, loadError, reload } = useNovel(id)
  const [, render] = useState(0)
  const [serverVersion, setServerVersion] = useState<Chapter | null>(null)
  const [checking, setChecking] = useState(false)
  // 稿面右上角「自动保存于 HH:mm:ss」：保存成功后由 writer-chapter-saved 事件驱动
  const [savedAt, setSavedAt] = useState<number | null>(null)
  useEffect(() => {
    const onSaved = () => setSavedAt(Date.now())
    window.addEventListener('writer-chapter-saved', onSaved)
    return () => window.removeEventListener('writer-chapter-saved', onSaved)
  }, [])

  // ---- AI 写作面板 ----
  const models = useModels()
  const [aiOpen, setAiOpen] = useState(false)
  const [aiMode, setAiMode] = useState<AiMode>('write')
  const [aiPrompt, setAiPrompt] = useState('')
  const [aiModel, setAiModel] = useState('')
  const [aiDeep, setAiDeep] = useState(true)
  const [aiError, setAiError] = useState('')
  const { job: aiJob, running: aiRunning, startJob: startAiJob, stop: stopAiJob, setJob: setAiJob } = useJob()
  const mountedRef = useRef(true)
  // 启动期间（await save / startAiJob）aiRunning 还是 false，不加锁双击会起两个章节任务
  const aiStartingRef = useRef(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const sessionRef = useRef<EditingSession>({
    base: null,
    title: '',
    content: '',
    key: '',
    owner: `${Date.now()}-${Math.random()}`,
    lastDraft: null,
    saving: false,
    blocked: false,
    conflict: false,
    recovered: false,
    cacheFailed: false,
    error: '',
    notice: '',
    composing: false
  })
  const session = sessionRef.current
  const refresh = () => {
    if (mountedRef.current) render(value => value + 1)
  }

  // AI 抽屉与「资料」侧栏互斥：打开抽屉时通知工作台收起资料栏
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('studio-ai-drawer', { detail: aiOpen }))
  }, [aiOpen])
  useEffect(
    () => () => {
      window.dispatchEvent(new CustomEvent('studio-ai-drawer', { detail: false }))
    },
    []
  )

  // 输入事件同步更新 ref 并落本地草稿；不依赖 effect/防抖，最后一次按键也可恢复。
  // 保存基准与草稿一起持久化，重开时不会静默覆盖其他操作的新版本。
  const persistDraft = (claim = false) => {
    const s = sessionRef.current
    if (!s.base) return
    try {
      const existing = localStorage.getItem(s.key)
      // 旧页面的在途保存不得覆盖快速重开的新页面草稿。
      if (!claim && existing !== s.lastDraft) return
      const value = JSON.stringify({
        title: s.title,
        content: s.content,
        oid: s.base.oid,
        expectedTitle: s.base.title,
        expectedContent: s.base.content,
        at: Date.now(),
        owner: s.owner
      })
      localStorage.setItem(s.key, value)
      s.lastDraft = value
      s.cacheFailed = false
    } catch {
      s.cacheFailed = true
    }
  }

  const save = async (manual = true) => {
    const s = sessionRef.current
    if (!id || !s.base || s.conflict || s.composing) return false
    if (manual) {
      s.blocked = false
      s.recovered = false
      s.notice = ''
      s.error = ''
    }
    if (s.blocked) return false
    // 正在保存时不丢弃追加输入：下面的串行循环会使用更新后的缓冲继续保存。
    if (s.saving) return false
    s.saving = true
    refresh()
    try {
      while (hasChanges(s)) {
        if (!mountedRef.current) {
          try {
            if (localStorage.getItem(s.key) !== s.lastDraft) break
          } catch {
            /* 无缓存时仍尝试将内存草稿提交。 */
          }
        }
        const base: Chapter = s.base!
        const title = s.title
        const content = s.content
        const submittedTitle = title.trim() || base.title || `第 ${base.index} 章`
        persistDraft()
        const result = (await api.updateChapter(id, base.index, {
          title: submittedTitle,
          content,
          oid: base.oid,
          expectedContent: base.content,
          expectedTitle: base.title
        })) as { ok: boolean; chapter?: Chapter }
        // 以本次 PUT 的准确快照推进乐观锁，不用额外 GET 把并发更新误认作已保存基准。
        s.base = result.chapter || {
          ...base,
          title: submittedTitle,
          content,
          words: content.replace(/\s/g, '').length,
          status: 'done'
        }
        if (s.title === title) s.title = submittedTitle
        s.error = ''
        try {
          if (localStorage.getItem(s.key) === s.lastDraft) {
            if (!hasChanges(s)) {
              localStorage.removeItem(s.key)
              s.lastDraft = null
              s.cacheFailed = false
            } else persistDraft()
          }
        } catch {
          s.cacheFailed = true
        }
        window.dispatchEvent(new Event('writer-chapter-saved'))
        refresh()
        // IME 组合输入尚未完成时等待下一轮防抖，不把半个拼音作为保存快照。
        if (s.composing) break
      }
      if (manual && mountedRef.current && !hasChanges(s)) toast.success('已保存。')
      return !hasChanges(s)
    } catch (e) {
      s.error = (e as Error).message
      s.conflict = e instanceof ApiError && e.status === 409
      s.blocked = true
      persistDraft()
      return false
    } finally {
      s.saving = false
      refresh()
    }
  }
  const saveRef = useRef(save)
  saveRef.current = save
  const persistRef = useRef(persistDraft)
  persistRef.current = persistDraft

  useEffect(() => {
    const s = sessionRef.current
    if (!novel || s.base) return
    const chapter = novel.chapters.find(c => c.index === Number(cid))
    if (!chapter) return
    s.base = chapter
    s.title = chapter.title || ''
    s.content = chapter.content || ''
    s.key = `writer-draft:${id}:${chapter.oid || cid}`
    try {
      const raw = localStorage.getItem(s.key)
      const draft: Draft | null = JSON.parse(raw || 'null')
      if (
        draft &&
        typeof draft.title === 'string' &&
        typeof draft.content === 'string' &&
        (!draft.oid || draft.oid === chapter.oid)
      ) {
        s.lastDraft = raw
        if (draft.title.trim() !== chapter.title || draft.content !== chapter.content) {
          s.title = draft.title
          s.content = draft.content
          s.recovered = true
          s.blocked = true
          s.notice = '已恢复本地草稿。请检查内容，再确认保存。'
          if (typeof draft.expectedTitle === 'string' && typeof draft.expectedContent === 'string') {
            s.base = { ...chapter, title: draft.expectedTitle, content: draft.expectedContent }
            if (chapter.title !== draft.expectedTitle || chapter.content !== draft.expectedContent) {
              s.conflict = true
              s.error = '作品中的版本已改变。你的本地草稿仍在下方，请核对并合并后保存。'
              setServerVersion(chapter)
            }
          }
          // 重开章节即取得草稿所有权，旧会话在途响应不可再删除这份草稿。
          persistRef.current(true)
        }
      }
    } catch {
      s.notice = '无法读取本地草稿；当前显示作品中的正文，请检查浏览器存储权限。'
    }
    render(value => value + 1)
  }, [novel, id, cid])

  const dirty = hasChanges(session)
  useEffect(() => {
    if (!dirty || session.saving || session.blocked || session.composing) return
    const timer = window.setTimeout(() => void saveRef.current(false), 1200)
    return () => window.clearTimeout(timer)
  }, [dirty, session.title, session.content, session.saving, session.blocked, session.composing])

  useEffect(() => {
    mountedRef.current = true
    const s = sessionRef.current
    const warn = (event: BeforeUnloadEvent) => {
      if (!hasChanges(s) && !s.saving) return
      persistRef.current()
      event.preventDefault()
      event.returnValue = ''
    }
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        if (!event.isComposing) void saveRef.current()
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'j') {
        // 与「AI 写作」按钮同一入口：写作时不离开键盘也能唤起
        event.preventDefault()
        setAiError('')
        setAiOpen(true)
      }
    }
    window.addEventListener('beforeunload', warn)
    window.addEventListener('keydown', onKey)
    return () => {
      mountedRef.current = false
      window.removeEventListener('beforeunload', warn)
      window.removeEventListener('keydown', onKey)
      if (hasChanges(s)) {
        persistRef.current()
        if (!s.blocked) void saveRef.current(false)
      }
    }
  }, [])

  const hasChapter = !!session.base
  useLayoutEffect(() => {
    const node = textareaRef.current
    if (!node) return
    const resize = () => {
      node.style.height = '0px'
      node.style.height = `${node.scrollHeight}px`
    }
    resize()
    let previousWidth = node.clientWidth
    const observer = new ResizeObserver(() => {
      if (previousWidth !== node.clientWidth) {
        previousWidth = node.clientWidth
        resize()
      }
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [session.content, hasChapter])

  const inspectLatest = async () => {
    if (!id || checking) return
    setChecking(true)
    try {
      const latest = await api.getNovel(id)
      if (!mountedRef.current) return
      const base = sessionRef.current.base
      const current = latest.chapters.find(c => (base?.oid ? c.oid === base.oid : c.index === Number(cid)))
      if (!current) throw new Error('该章节已被删除。本地草稿仍保留，请复制正文到新章节。')
      setServerVersion(current)
    } catch (e) {
      sessionRef.current.error = (e as Error).message
      refresh()
    } finally {
      if (mountedRef.current) setChecking(false)
    }
  }

  const change = (field: 'title' | 'content', value: string) => {
    sessionRef.current[field] = value
    persistDraft(true)
    refresh()
  }
  // ---- AI 写作：产物只进预览，作者点「采用」才落到正文 ----
  const aiProposal = (() => {
    const list = aiJob?.proposals || []
    const base = sessionRef.current.base
    return list.find(p => (base ? p.index === base.index : true))?.content || ''
  })()
  const aiText = aiProposal || aiJob?.stream || ''
  const aiWords = aiText.replace(/\s/g, '').length

  const openAi = () => {
    setAiError('')
    setAiOpen(true)
  }
  const closeAi = () => {
    if (aiRunning) void stopAiJob()
    setAiOpen(false)
    setAiJob(null)
  }
  const startAi = async () => {
    const s = sessionRef.current
    const target = s.base
    if (!id || !target || aiRunning || aiStartingRef.current) return
    if (aiMode === 'revise' && !aiPrompt.trim()) {
      setAiError('请先写明要修改的问题。')
      return
    }
    if (aiMode === 'continue' && !s.content.trim()) {
      setAiError('本章还没有正文，无法续写。可以先「写整章」。')
      return
    }
    aiStartingRef.current = true
    try {
      setAiError('')
      // 先落盘：AI 读到的是作品里的正文，不能是还没保存的编辑缓冲
      if (hasChanges(s)) {
        const saved = await save()
        if (!saved) {
          setAiError('正文还没保存成功，先处理上面的保存提示，再让 AI 动笔。')
          return
        }
      }
      setAiJob(null)
      const r = await startAiJob(() =>
        api.startChapterJob(id, target.index, {
          kind: aiMode,
          extraPrompt: aiPrompt.trim(),
          modelId: aiModel || undefined,
          previewOnly: true,
          // 关掉深度写作 = 回到一次性成文；开着才走「构思 → 起草 → 自检 → 修订」
          agent: aiMode === 'write' && aiDeep,
          agentDepth: 'full'
        })
      )
      if (!r.ok) setAiError(r.error)
    } finally {
      aiStartingRef.current = false
    }
  }
  const applyAi = () => {
    const s = sessionRef.current
    const text = aiProposal || (aiJob?.status === 'done' ? aiJob.stream : '')
    if (!text) return
    s.content = text
    s.notice = '已把 AI 稿件填入正文，请通读后保存。'
    persistRef.current(true)
    setAiOpen(false)
    setAiJob(null)
    refresh()
    if (!s.blocked) void saveRef.current(false)
  }

  const chapter = session.base
  if (!chapter) {
    return (
      <section className="editor-document">
        <header className="editor-toolbar">{toolbarControls}</header>
        <div className="manuscript-empty" role={loadError || novel ? 'alert' : 'status'}>
          {loadError || (novel ? '该章节不存在，可能已被移动或删除。' : '正在打开正文…')}
          {(loadError || novel) && (
            <div className="manuscript-empty-actions">
              {loadError && (
                <button className="writing-button" onClick={() => void reload()}>
                  重新加载
                </button>
              )}
              <Link className="writing-tool" to={`/novel/${id}?tab=write`}>
                返回书稿
              </Link>
            </div>
          )}
        </div>
      </section>
    )
  }
  const words = session.content.replace(/\s/g, '').length
  const status = session.conflict ? '冲突' : session.saving ? '保存中' : dirty || session.error ? '本地草稿' : '已保存'
  const statusHint = session.conflict
    ? '请核对最新版本；你的输入不会被替换'
    : session.cacheFailed && dirty
      ? '本地缓存失败，请保存成功后再离开'
      : session.error
        ? '保存失败；可重试，或检查作品中的最新版本'
        : session.recovered
          ? '已找回草稿，等待确认保存'
          : dirty
            ? '停笔后自动保存，输入同时缓存到本地'
            : '正文已保存到作品'

  return (
    <section
      className={`editor-document${embedded ? '' : ' editor-standalone'}`}
      data-has-chapter="true"
      aria-label={`第 ${chapter.index} 章编辑器`}
    >
      <div className="editor-stage">
        <div className="editor-canvas" data-ai-open={aiOpen}>
          {(session.notice || session.cacheFailed || session.error || loadError) && (
            <div className="editor-notices">
              {session.notice && (
                <div className="editor-notice" role="status">
                  <span>{session.notice}</span>
                  {session.recovered && !session.conflict && (
                    <button className="writing-tool" onClick={() => void save()}>
                      确认并保存
                    </button>
                  )}
                </div>
              )}
              {session.cacheFailed && (
                <p className="editor-notice editor-warning" role="alert">
                  本地草稿缓存不可用。请勿关闭窗口，先保存正文；必要时复制一份备份。
                </p>
              )}
              {(session.error || loadError) && (
                <div className="editor-notice editor-warning" role="alert">
                  <span>
                    {session.error || loadError}
                    {!session.cacheFailed && dirty ? ' 本地草稿已保留。' : ''}
                  </span>
                  <button
                    className="writing-tool"
                    disabled={checking || session.saving}
                    onClick={() => void inspectLatest()}
                  >
                    {checking ? '正在读取…' : '核对最新版本'}
                  </button>
                </div>
              )}
            </div>
          )}
          {serverVersion && (
            <section className="editor-conflict" aria-label="保存冲突核对">
              <h2>作品中的最新版本</h2>
              <p>下方纸面保留你的草稿。请核对标题与正文，合并需要保留的内容；不会自动替换你的输入。</p>
              <strong>{serverVersion.title}</strong>
              <pre>{serverVersion.content || '（正文为空）'}</pre>
              <button
                className="writing-button"
                onClick={() => {
                  session.base = serverVersion
                  session.conflict = false
                  session.error = ''
                  session.recovered = true
                  session.blocked = true
                  session.notice = '已更新保存基准。请在纸面合并内容，再确认保存。'
                  persistDraft(true)
                  setServerVersion(null)
                  refresh()
                }}
              >
                以此版本为基准，保留草稿继续编辑
              </button>
            </section>
          )}
          <article className="editor-paper" aria-label="章节纸面">
            <div className="editor-paper-header">
              <div className="editor-paper-heading">
                <span>第 {chapter.index} 章</span>
                {chapter.orphan && <span className="editor-orphan">对应大纲已删除 · 待整理</span>}
              </div>
              <div className="editor-paper-meta">
                <span>{words.toLocaleString()} 字</span>
                <span>
                  {savedAt
                    ? `自动保存于 ${new Date(savedAt).toLocaleTimeString('zh-CN', { hour12: false })}`
                    : dirty
                      ? '尚未保存'
                      : '已保存到作品'}
                </span>
              </div>
            </div>
            <div className="editor-title-row">
              <label className="editor-sr-only" htmlFor="editor-chapter-title">
                章节标题
              </label>
              <input
                id="editor-chapter-title"
                className="editor-title"
                value={session.title}
                onChange={e => change('title', e.target.value)}
                placeholder={`第 ${chapter.index} 章`}
                onCompositionStart={() => {
                  session.composing = true
                  refresh()
                }}
                onCompositionEnd={() => {
                  session.composing = false
                  refresh()
                }}
              />
              <Seal text={Array.from(session.title || '稿')[0]} size={24} className="editor-title-seal" />
            </div>
            <label className="editor-sr-only" htmlFor="editor-chapter-content">
              正文
            </label>
            <textarea
              id="editor-chapter-content"
              ref={textareaRef}
              className="editor-body"
              value={session.content}
              onChange={e => change('content', e.target.value)}
              onCompositionStart={() => {
                session.composing = true
                refresh()
              }}
              onCompositionEnd={() => {
                session.composing = false
                refresh()
              }}
              placeholder="在这里，写下故事的第一句话…"
              spellCheck={false}
            />
          </article>
        </div>
        {aiOpen && (
          <section className="editor-ai" role="dialog" aria-label="AI 写作">
            <header className="editor-ai-head">
              <div>
                <strong>
                  <SparkIcon size={15} /> AI 写作
                </strong>
                <span>
                  第 {chapter.index} 章{novel?.title ? ` · ${novel.title}` : ''}
                </span>
              </div>
              <button className="writing-tool" onClick={closeAi} aria-label="关闭 AI 写作">
                <CloseIcon />
              </button>
            </header>

            <div className="editor-ai-bar">
              <div className="editor-ai-modes" role="group" aria-label="写作方式">
                {AI_MODES.map(m => (
                  <button
                    key={m.key}
                    type="button"
                    aria-pressed={aiMode === m.key}
                    disabled={aiRunning}
                    onClick={() => {
                      setAiMode(m.key)
                      setAiError('')
                    }}
                  >
                    {m.icon}
                    <span>{m.label}</span>
                  </button>
                ))}
              </div>
              <span className="editor-ai-model">
                <span>模型</span>
                <ModelSelect
                  variant="pill"
                  value={aiModel}
                  onChange={setAiModel}
                  disabled={aiRunning}
                  models={models}
                  placeholder="本书默认"
                  fallbackId={novel?.modelId}
                />
              </span>
            </div>

            <p className="editor-ai-hint">{AI_MODES.find(m => m.key === aiMode)?.hint}</p>

            <div className="editor-ai-input">
              <label className="editor-sr-only" htmlFor="editor-ai-prompt">
                补充要求
              </label>
              <textarea
                id="editor-ai-prompt"
                rows={3}
                value={aiPrompt}
                onChange={e => setAiPrompt(e.target.value)}
                disabled={aiRunning}
                placeholder={
                  aiMode === 'revise'
                    ? '写明要改的问题，例如：第三章之后主角不该再提那封信；结尾太仓促'
                    : '请输入写作需求，例如：描写沈照夜的心理活动…'
                }
              />
              <span className="editor-ai-input-count">{aiPrompt.length} 字</span>
              {aiMode === 'write' && (
                <label className="editor-ai-deep">
                  <input
                    type="checkbox"
                    className="ink-check"
                    checked={aiDeep}
                    disabled={aiRunning}
                    onChange={e => setAiDeep(e.target.checked)}
                  />
                  <span>
                    深度写作：先拟场景节拍，再起草，最后自检并按意见修订
                    <em>三次调用，慢一些；本地小模型也能靠这一步把结构稳住</em>
                  </span>
                </label>
              )}
              <div className="editor-ai-actions">
                <button
                  className="writing-button writing-button-primary editor-ai-generate"
                  disabled={aiRunning}
                  onClick={() => void startAi()}
                >
                  <SparkIcon size={15} /> {aiRunning ? '写作中…' : '生成内容'}
                </button>
                {aiRunning && (
                  <button className="writing-tool" onClick={() => void stopAiJob()}>
                    <StopIcon /> 停笔
                  </button>
                )}
              </div>
            </div>

            {(aiRunning || aiJob) && (
              <div className="editor-ai-status" role="status">
                <span className="editor-ai-stage" data-stage={aiJob?.stage || 'draft'}>
                  {AI_STAGE_LABEL[aiJob?.stage || ''] || '准备中'}
                </span>
                {aiJob?.stageNote && <span>{aiJob.stageNote}</span>}
                {aiJob?.brief?.beats?.length ? <span>· {aiJob.brief.beats.length} 个节拍</span> : null}
                {/* 修订过就不再重复报「N 条意见」——stageNote 已经说清楚了 */}
                {!aiJob?.revised && aiJob?.review?.issues?.length ? (
                  <span>· 自检 {aiJob.review.issues.length} 条</span>
                ) : null}
              </div>
            )}

            {aiError && (
              <p className="editor-ai-error" role="alert">
                {aiError}
              </p>
            )}
            {aiJob?.error && (
              <p className="editor-ai-error" role="alert">
                {aiJob.error}
              </p>
            )}
            {aiJob?.truncated && (
              <p className="editor-ai-error" role="alert">
                模型输出达到上限被截断，稿件可能不完整；可减小每章目标字数，或换输出上限更大的模型。
              </p>
            )}

            {(aiJob?.brief?.beats?.length || aiJob?.review?.issues?.length) && (
              <details className="editor-ai-notes">
                <summary>查看写作方案与自检意见</summary>
                {aiJob?.brief?.beats?.length ? (
                  <ol>
                    {aiJob.brief.beats.map((b, i) => (
                      <li key={i}>
                        <strong>{b.label || `节拍 ${i + 1}`}</strong>
                        {b.event}
                        {b.purpose ? <em>（{b.purpose}）</em> : null}
                      </li>
                    ))}
                  </ol>
                ) : null}
                {aiJob?.review?.issues?.length ? (
                  <ul>
                    {aiJob.review.issues.map((it, i) => (
                      <li key={i}>
                        <strong>{it.type || '问题'}</strong>
                        {it.fix}
                        {it.quote ? <em>「{it.quote}」</em> : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </details>
            )}

            <div className="editor-ai-result-title">推荐结果</div>
            <div className="editor-ai-preview" aria-live="polite">
              {aiText ? (
                <pre>{aiText}</pre>
              ) : (
                <p className="editor-ai-empty">
                  {aiRunning ? '等待模型落笔…' : '选好方式与模型，点「生成内容」；生成过程中可以随时停笔。'}
                </p>
              )}
            </div>
            {aiText && (
              <div className="editor-ai-result-actions">
                <button
                  className="writing-tool"
                  onClick={() => {
                    void navigator.clipboard
                      ?.writeText(aiText)
                      .then(() => toast.success('已复制候选稿。'))
                      .catch(() => toast.error('复制失败，请在候选稿中手动选择文字复制。'))
                  }}
                >
                  <CopyIcon /> 复制
                </button>
                <button
                  className="writing-tool"
                  disabled={!aiProposal || aiRunning}
                  onClick={applyAi}
                  title="把候选稿填入正文，保存前可再修改"
                >
                  替换到正文
                </button>
                <button className="writing-tool" onClick={closeAi}>
                  放弃
                </button>
              </div>
            )}

            <footer className="editor-ai-foot">
              <span>
                {aiWords.toLocaleString()} 字{aiWords ? ` · 原稿 ${words.toLocaleString()} 字` : ''}
              </span>
              <div className="editor-ai-actions">
                <button className="writing-tool" onClick={closeAi}>
                  关闭
                </button>
              </div>
            </footer>
          </section>
        )}
      </div>
      <header className="editor-toolbar">
        {toolbarControls || (
          <Link className="writing-tool" to={`/novel/${id}?tab=write`}>
            返回书稿
          </Link>
        )}
        <div className="editor-save-controls">
          <button
            className="writing-tool editor-ai-trigger"
            onClick={openAi}
            aria-keyshortcuts="Control+J"
            title="让 AI 起草、续写或改写本章（Ctrl / ⌘ + J）"
          >
            <SparkIcon size={14} /> AI 写作
          </button>
          <span
            className="editor-save-status"
            data-state={
              session.conflict ? 'conflict' : session.saving ? 'saving' : dirty || session.error ? 'draft' : 'saved'
            }
            role="status"
            title={statusHint}
          >
            <span className="editor-status-dot" aria-hidden="true" />
            {status}
          </span>
          <button
            className="writing-button editor-save"
            disabled={session.saving || session.conflict || (!dirty && !session.error)}
            onClick={() => void save()}
            title="保存（Ctrl / ⌘ + S）"
          >
            {session.saving ? '保存中…' : session.error ? '重试保存' : '保存'}
          </button>
        </div>
      </header>
      <footer className="editor-statusbar">
        <span>
          {words.toLocaleString()} 字
          <span className="editor-footer-secondary">
            {' '}
            · {session.content.split(/\n+/).filter(line => line.trim()).length} 段
          </span>
        </span>
        <span className="editor-footer-secondary">正文自动保存 · Ctrl / ⌘ S 手动保存</span>
      </footer>
    </section>
  )
}
