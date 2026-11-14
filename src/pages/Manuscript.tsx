import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom'
import { useNovel } from '../lib/hooks/useNovel'
import ChapterEditor from './ChapterEditor'
import { SearchIcon } from './writing-icons'
import { api } from '../lib/api'

function PanelIcon({ side }: { side: 'left' | 'right' | 'focus' }) {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      aria-hidden="true"
    >
      {side === 'focus' ? (
        <path d="M7 3H3v4m10-4h4v4M3 13v4h4m10-4v4h-4" />
      ) : (
        <>
          <rect x="2.5" y="3.5" width="15" height="13" rx="2" />
          <path d={side === 'left' ? 'M7.5 4v12' : 'M12.5 4v12'} />
        </>
      )}
    </svg>
  )
}

/** 正文、目录和资料共享一个工作台；定位记录使用 oid 而不是可变章号。 */
export default function Manuscript() {
  const { id, cid } = useParams()
  const navigate = useNavigate()
  const { novel, loadError, reload } = useNovel(id)
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false)
  const creatingRef = useRef(false)
  const aliveRef = useRef(true)
  const [createError, setCreateError] = useState('')
  const [compact, setCompact] = useState(() => window.innerWidth < 1280)
  const [directory, setDirectory] = useState(() => window.innerWidth >= 1280)
  const [inspector, setInspector] = useState(false)
  const [focused, setFocused] = useState(false)
  const workbenchRef = useRef<HTMLDivElement>(null)
  const directoryButtonRef = useRef<HTMLButtonElement>(null)
  const inspectorButtonRef = useRef<HTMLButtonElement>(null)
  const chapters = useMemo(() => [...(novel?.chapters || [])].sort((a, b) => a.index - b.index), [novel])
  const selected = chapters.find(c => c.index === Number(cid))
  const outline = novel?.outline.find(o => (selected?.oid ? o.oid === selected.oid : o.index === Number(cid)))
  const showDirectory = directory && !focused
  const showInspector = inspector && !focused

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  const create = async () => {
    if (!id || creatingRef.current) return
    creatingRef.current = true
    setCreating(true)
    setCreateError('')
    try {
      const { chapter } = await api.createChapter(id)
      await reload()
      if (!aliveRef.current) return
      if (compact) setDirectory(false)
      navigate(`/novel/${id}/chapter/${chapter.index}`)
    } catch (e) {
      setCreateError((e as Error).message)
    } finally {
      creatingRef.current = false
      setCreating(false)
    }
  }

  useEffect(() => {
    const node = workbenchRef.current
    if (!node) return
    const observer = new ResizeObserver(([entry]) => setCompact(entry.contentRect.width < 1060))
    observer.observe(node)
    return () => observer.disconnect()
  }, [novel?.id, cid])

  useEffect(() => {
    if (compact) {
      setDirectory(false)
      setInspector(false)
    }
  }, [compact])

  // AI 抽屉打开时收起资料栏，避免两个右侧面板挤在同一张稿纸上
  useEffect(() => {
    const onAi = (e: Event) => {
      if ((e as CustomEvent<boolean>).detail) setInspector(false)
    }
    window.addEventListener('studio-ai-drawer', onAi)
    return () => window.removeEventListener('studio-ai-drawer', onAi)
  }, [])

  useEffect(() => {
    window.dispatchEvent(new CustomEvent('studio-focus-mode', { detail: focused }))
  }, [focused])
  useEffect(
    () => () => {
      window.dispatchEvent(new CustomEvent('studio-focus-mode', { detail: false }))
    },
    []
  )

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing) return
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.code === 'KeyF') {
        event.preventDefault()
        setFocused(value => !value)
      } else if (event.key === 'Escape') {
        if (focused) setFocused(false)
        else if (compact && (directory || inspector)) {
          event.preventDefault()
          const trigger = directory ? directoryButtonRef : inspectorButtonRef
          setDirectory(false)
          setInspector(false)
          trigger.current?.focus()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [focused, compact, directory, inspector])

  useEffect(() => {
    if (!id || !selected) return
    try {
      localStorage.setItem('writer-position:' + id, JSON.stringify({ oid: selected.oid, index: selected.index }))
    } catch {
      /* 位置记忆失败不影响正文。 */
    }
  }, [id, selected])
  useEffect(() => {
    const refresh = () => void reload()
    window.addEventListener('writer-chapter-saved', refresh)
    return () => window.removeEventListener('writer-chapter-saved', refresh)
  }, [reload])

  if (loadError && !novel)
    return (
      <div className="manuscript-empty" role="alert">
        <h2>作品暂时没有加载成功</h2>
        <p>{loadError}</p>
        <button className="writing-button" onClick={() => void reload()}>
          重新加载
        </button>
      </div>
    )
  if (!novel)
    return (
      <div className="manuscript-empty" role="status">
        正在打开书稿…
      </div>
    )
  if (!cid && chapters.length) {
    let last: { oid?: string; index?: number } = {}
    try {
      last = JSON.parse(localStorage.getItem('writer-position:' + id) || '{}') || {}
    } catch {
      /* 回落到第一章。 */
    }
    const target = chapters.find(c => (last.oid ? c.oid === last.oid : c.index === last.index)) || chapters[0]
    return <Navigate to={`/novel/${id}/chapter/${target.index}`} replace />
  }
  const filtered = chapters.filter(
    c => !query.trim() || (c.title + ' ' + c.index).toLowerCase().includes(query.trim().toLowerCase())
  )
  const controls = (
    <div className="manuscript-view-controls" role="group" aria-label="写作视图">
      <button
        ref={directoryButtonRef}
        className="writing-tool"
        aria-label={showDirectory ? '收起目录' : '展开目录'}
        aria-pressed={showDirectory}
        aria-expanded={showDirectory}
        aria-controls="manuscript-directory"
        title="显示或隐藏章节目录"
        onClick={() => {
          setDirectory(!showDirectory)
          setFocused(false)
          if (compact) setInspector(false)
        }}
      >
        <PanelIcon side="left" />
        <span>目录</span>
      </button>
      <button
        className="writing-tool"
        aria-label={focused ? '退出专注写作' : '专注写作'}
        aria-pressed={focused}
        aria-keyshortcuts="Control+Shift+F Meta+Shift+F"
        title="专注写作（Ctrl / ⌘ + Shift + F，Esc 退出）"
        onClick={() => setFocused(value => !value)}
      >
        <PanelIcon side="focus" />
        <span>{focused ? '退出专注' : '专注'}</span>
      </button>
      <button
        ref={inspectorButtonRef}
        className="writing-tool"
        aria-label={showInspector ? '收起资料' : '展开资料'}
        aria-pressed={showInspector}
        aria-expanded={showInspector}
        aria-controls="manuscript-inspector"
        title="显示或隐藏写作资料"
        onClick={() => {
          setInspector(!showInspector)
          setFocused(false)
          if (compact) setDirectory(false)
        }}
      >
        <PanelIcon side="right" />
        <span>资料</span>
      </button>
    </div>
  )
  return (
    <div
      ref={workbenchRef}
      className="writing-workbench"
      data-directory={showDirectory}
      data-inspector={showInspector}
      data-compact={compact}
      data-focused={focused}
    >
      {compact && (showDirectory || showInspector) && (
        <button
          className="manuscript-panel-backdrop"
          aria-label="关闭侧边面板"
          onClick={() => {
            const trigger = showDirectory ? directoryButtonRef : inspectorButtonRef
            setDirectory(false)
            setInspector(false)
            trigger.current?.focus()
          }}
        />
      )}
      {showDirectory && (
        <aside id="manuscript-directory" className="manuscript-directory" aria-label="章节目录">
          <header className="manuscript-panel-head">
            <div>
              <strong>书稿目录</strong>
              <span>{chapters.length} 章</span>
            </div>
            <button
              className="writing-tool manuscript-close"
              aria-label="关闭目录"
              onClick={() => {
                setDirectory(false)
                directoryButtonRef.current?.focus()
              }}
            >
              ×
            </button>
          </header>
          <label className="ink-search manuscript-search">
            <SearchIcon />
            <input
              aria-label="查找章节"
              placeholder="查找章节"
              value={query}
              onChange={e => setQuery(e.target.value)}
            />
          </label>
          <button className="btn btn--outline btn--md manuscript-add" disabled={creating} onClick={() => void create()}>
            {creating ? '创建中…' : '＋ 新建章节'}
          </button>
          {createError && (
            <p role="alert" className="manuscript-panel-note">
              {createError}
            </p>
          )}
          <nav className="manuscript-chapters" aria-label="选择章节">
            {filtered.map(c => {
              const current = c.index === Number(cid)
              const hasContent = !!c.content?.trim()
              const status = current
                ? { key: 'gold', label: '编辑中' }
                : !hasContent
                  ? { key: '', label: '未开始' }
                  : c.status === 'draft'
                    ? { key: 'gold', label: '草稿' }
                    : { key: 'jade', label: '已定稿' }
              return (
                <Link
                  key={c.oid || c.index}
                  to={`/novel/${id}/chapter/${c.index}`}
                  onClick={() => {
                    if (compact) setDirectory(false)
                  }}
                  aria-current={current ? 'page' : undefined}
                  className={current ? 'selected' : ''}
                >
                  <span className="manuscript-chapter-number">{String(c.index).padStart(2, '0')}</span>
                  <span className="manuscript-chapter-info">
                    <strong>{c.title || '未命名章节'}</strong>
                    <small>
                      {c.words.toLocaleString()} 字{c.orphan ? ' · 待整理' : ''}
                    </small>
                  </span>
                  <span className={`manuscript-chapter-status${status.key ? ` is-${status.key}` : ''}`}>
                    <span className={`ink-dot${status.key ? ` ink-dot--${status.key}` : ''}`} aria-hidden="true" />
                    {status.label}
                  </span>
                </Link>
              )
            })}
            {!filtered.length && (
              <p className="manuscript-panel-note">{query ? '没有匹配的章节' : '故事从第一章开始。'}</p>
            )}
          </nav>
          <button
            className="writing-tool manuscript-plan"
            onClick={() => navigate(`/novel/${id}?tab=outline&sub=outline`)}
          >
            管理章节规划 →
          </button>
        </aside>
      )}
      <main className="manuscript-main" aria-label="正文写作区">
        {cid ? (
          <ChapterEditor key={id + ':' + cid} embedded toolbarControls={controls} />
        ) : (
          <>
            <header className="editor-toolbar">
              {controls}
              <span className="editor-toolbar-hint">正文</span>
            </header>
            <div className="manuscript-empty manuscript-empty-paper">
              <span className="manuscript-empty-kicker">你的故事，从这里开始</span>
              <h2>落笔，就是第一章。</h2>
              <p>不必先配置模型，也不必备齐设定。先写下第一句话，人物与世界会慢慢生长。</p>
              <div className="manuscript-empty-actions">
                <button
                  className="writing-button writing-button-primary"
                  disabled={creating}
                  onClick={() => void create()}
                >
                  {creating ? '创建中…' : '新建第一章'}
                </button>
                <Link className="writing-tool" to={`/butler?id=${id}`}>
                  讨论开场
                </Link>
              </div>
              {createError && <p role="alert">{createError}</p>}
            </div>
          </>
        )}
      </main>
      {showInspector && (
        <aside id="manuscript-inspector" className="manuscript-inspector" aria-label="写作资料">
          <header className="manuscript-panel-head">
            <div>
              <strong>写作资料</strong>
              <span>随手参考，不打断思路</span>
            </div>
            <button
              className="writing-tool manuscript-close"
              aria-label="关闭资料"
              onClick={() => {
                setInspector(false)
                inspectorButtonRef.current?.focus()
              }}
            >
              ×
            </button>
          </header>
          <section>
            <h3>本章提要</h3>
            <p>{outline?.summary || '还没有本章摘要。可以先写正文，再到规划中补充。'}</p>
            <Link to={`/novel/${id}?tab=outline&sub=outline`}>编辑章节规划 ↗</Link>
          </section>
          <section>
            <h3>故事简介</h3>
            <p>{novel.synopsis || '故事简介尚未填写。'}</p>
          </section>
          <section>
            <h3>人物</h3>
            {[novel.protagonist, ...novel.characters]
              .filter(c => c?.name)
              .map(c => (
                <details key={c.id}>
                  <summary>
                    {c.name}
                    <span>{c.role}</span>
                  </summary>
                  <p>{c.personality || c.background || c.notes || '暂无人物笔记'}</p>
                </details>
              ))}
            <Link to={`/novel/${id}?tab=bible&sub=chars`}>管理人物 ↗</Link>
          </section>
          <section>
            <h3>需要第二个视角？</h3>
            <p>讨论情节、检查人物动机，或把这一章送去审校。</p>
            <Link to={`/butler?id=${id}`}>与 AI 讨论 ↗</Link>
            <Link to={`/novel/${id}?tab=refine`}>进入审校 ↗</Link>
          </section>
        </aside>
      )}
    </div>
  )
}
