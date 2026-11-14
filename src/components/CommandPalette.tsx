import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { api } from '../lib/api'
import { registerCommandPalette } from '../lib/commands'

/**
 * 全局命令面板（Ctrl/Cmd+K）。
 *
 * 与 DialogHost / ToastHost 同一套模式：App 根部挂一次，其余任意位置
 * 调 openCommandPalette() 唤起（顶栏搜索按钮就是走这个入口）。
 * 面板能力：页面跳转、作品搜索、当前书章节搜索、切换主题。
 * 章节列表走 getNovelMeta（不带正文），千章书也能秒开。
 */

interface Cmd {
  id: string
  section: string
  label: string
  hint?: string
  /** 对应的全局快捷键（App.tsx 的 Alt+1~9），只做提示 */
  kbd?: string
  run: () => void
}

const SECTION_ICON: Record<string, string> = {
  跳转: 'M4 7h11M4 12h16M4 17h9',
  章节: 'M7 4h10a1 1 0 0 1 1 1v15l-6-3.5L6 20V5a1 1 0 0 1 1-1Z',
  作品: 'M5 4.5h4v15H5zM10.5 6.5h3.5v13h-3.5zM15.5 7l3-0.8 2.6 12.3-3 0.8z',
  动作: 'M12 4l1.7 5.1L19 11l-5.3 1.9L12 18l-1.7-5.1L5 11l5.3-1.9z'
}

function SectionIcon({ section }: { section: string }) {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <path d={SECTION_ICON[section] || SECTION_ICON['跳转']} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function dispatchThemeToggle() {
  window.dispatchEvent(new CustomEvent('studio-toggle-theme'))
}
export default function CommandPalette() {
  const nav = useNavigate()
  const location = useLocation()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [novels, setNovels] = useState<{ id: string; title: string }[]>([])
  const [chapters, setChapters] = useState<{ index: number; title: string }[]>([])
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // 当前作品上下文：与 App.tsx Layout 的推导口径一致
  const match = location.pathname.match(/^\/(?:novel|projects)\/([^/]+)/)
  const butlerMatch = location.pathname === '/butler' ? new URLSearchParams(location.search).get('id') : null
  const novelId = match ? match[1] : butlerMatch

  const close = () => {
    setOpen(false)
    setQuery('')
    setActive(0)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen(v => !v)
      } else if (e.key === 'Escape' && open) {
        e.preventDefault()
        close()
      }
    }
    window.addEventListener('keydown', onKey)
    const off = registerCommandPalette(() => setOpen(true))
    return () => {
      window.removeEventListener('keydown', onKey)
      off()
    }
  }, [open])

  // 打开时拉数据：作品列表是轻接口；当前书的章节走 meta 接口（无正文），按书缓存
  useEffect(() => {
    if (!open) return
    let alive = true
    api
      .getNovels()
      .then(l => alive && setNovels(l.map(n => ({ id: n.id, title: n.title }))))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [open])

  useEffect(() => {
    setChapters([])
  }, [novelId])

  // 每次打开都重新拉当前书章节：改名/增删章后重开面板必须看到最新，
  // 缓存只在两次渲染间防重复请求，不跨「打开」事件
  useEffect(() => {
    if (!open || !novelId) return
    let alive = true
    api
      .getNovelMeta(novelId)
      .then(n => {
        if (!alive) return
        setChapters((n.chapters || []).map(c => ({ index: c.index, title: c.title || '' })))
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [open, novelId])

  // 打开时聚焦输入框
  useEffect(() => {
    if (open) requestAnimationFrame(() => inputRef.current?.focus())
  }, [open])

  const commands = useMemo<Cmd[]>(() => {
    const q = query.trim().toLowerCase()
    const hit = (s: string) => !q || s.toLowerCase().includes(q)
    const list: Cmd[] = []

    const pages: Cmd[] = [
      { id: 'p-home', section: '跳转', label: '作品', hint: '作品库', kbd: 'Alt 1', run: () => nav('/') },
      { id: 'p-shelf', section: '跳转', label: '素材与草稿', kbd: 'Alt 7', run: () => nav('/shelf') },
      { id: 'p-kb', section: '跳转', label: '资料库', kbd: 'Alt 8', run: () => nav('/kb') },
      { id: 'p-settings', section: '跳转', label: '设置', kbd: 'Alt 9', run: () => nav('/settings') }
    ]
    if (novelId) {
      pages.push(
        {
          id: 'p-bible',
          section: '跳转',
          label: '设定',
          hint: '当前作品',
          kbd: 'Alt 2',
          run: () => nav(`/novel/${novelId}?tab=bible`)
        },
        {
          id: 'p-outline',
          section: '跳转',
          label: '规划',
          hint: '当前作品',
          kbd: 'Alt 3',
          run: () => nav(`/novel/${novelId}?tab=outline`)
        },
        {
          id: 'p-write',
          section: '跳转',
          label: '正文',
          hint: '当前作品',
          kbd: 'Alt 4',
          run: () => nav(`/novel/${novelId}?tab=write`)
        },
        {
          id: 'p-refine',
          section: '跳转',
          label: '审校',
          hint: '当前作品',
          kbd: 'Alt 5',
          run: () => nav(`/novel/${novelId}?tab=refine`)
        },
        {
          id: 'p-book',
          section: '跳转',
          label: '预览与导出',
          hint: '当前作品',
          kbd: 'Alt 6',
          run: () => nav(`/novel/${novelId}?tab=book`)
        },
        {
          id: 'p-butler',
          section: '跳转',
          label: '与 AI 讨论',
          hint: '当前作品',
          run: () => nav(`/butler?id=${novelId}`)
        }
      )
    }
    for (const c of pages) if (hit(c.label)) list.push(c)

    const chapCmds: Cmd[] = chapters
      .filter(c => {
        if (!q) return false
        const t = `第 ${c.index} 章 ${c.title}`
        return t.toLowerCase().includes(q) || String(c.index) === query.trim()
      })
      .slice(0, 30)
      .map(c => ({
        id: `c-${c.index}`,
        section: '章节',
        label: `第 ${c.index} 章 ${c.title}`,
        run: () => nav(`/novel/${novelId}/chapter/${c.index}`)
      }))
    list.push(...chapCmds)

    const novelCmds: Cmd[] = novels
      .filter(n => hit(n.title))
      .slice(0, 20)
      .map(n => ({
        id: `n-${n.id}`,
        section: '作品',
        label: n.title,
        run: () => nav(`/novel/${n.id}?tab=write`)
      }))
    list.push(...novelCmds)

    if (!q || '主题 深色 浅色 dark light theme'.includes(q)) {
      list.push({
        id: 'a-theme',
        section: '动作',
        label: '切换深浅色主题',
        run: dispatchThemeToggle
      })
    }
    return list
  }, [query, novels, chapters, novelId, nav])

  // 过滤结果变化时归零选中项，并修正滚动位置
  useEffect(() => setActive(0), [query, open])
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [active])

  if (!open) return null

  const run = (c: Cmd | undefined) => {
    if (!c) return
    close()
    c.run()
  }

  const onInputKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive(i => Math.min(i + 1, commands.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive(i => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      run(commands[active])
    }
  }

  let lastSection = ''
  let idx = -1

  return (
    <div
      className="cmdk-overlay"
      onMouseDown={e => {
        if (e.target === e.currentTarget) close()
      }}
    >
      <div className="cmdk" role="dialog" aria-modal="true" aria-label="命令面板">
        <header className="cmdk-head">
          <h2 className="ink-section-title">命令面板</h2>
          <span className="cmdk-shortcut" aria-hidden="true">
            <kbd className="ink-kbd">Ctrl</kbd>+<kbd className="ink-kbd">K</kbd>
          </span>
          <button type="button" className="cmdk-close" onClick={close} aria-label="关闭命令面板">
            <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="M6 6l12 12M18 6 6 18"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </header>
        <label className="ink-search cmdk-search">
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            aria-hidden="true"
          >
            <circle cx="11" cy="11" r="6.5" />
            <path d="M20 20l-4.4-4.4" strokeLinecap="round" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={onInputKey}
            placeholder="搜索章节、作品，或跳转到任意页面……"
            aria-label="搜索命令"
          />
        </label>
        <div ref={listRef} className="cmdk-list">
          {commands.length === 0 ? (
            <p className="cmdk-empty">没有匹配的命令。</p>
          ) : (
            commands.map(c => {
              idx += 1
              const i = idx
              const head = c.section !== lastSection ? c.section : null
              lastSection = c.section
              return (
                <div key={c.id}>
                  {head && <div className="cmdk-group">{head}</div>}
                  <button
                    data-idx={i}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => run(c)}
                    className={`cmdk-item${i === active ? ' is-active' : ''}`}
                  >
                    <SectionIcon section={c.section} />
                    <span className="cmdk-label">{c.label}</span>
                    {c.hint && <span className="cmdk-hint">{c.hint}</span>}
                    {c.kbd && <span className="cmdk-kbd">{c.kbd}</span>}
                  </button>
                </div>
              )
            })
          )}
        </div>
        <footer className="cmdk-foot">
          <span>
            <kbd className="ink-kbd">↑↓</kbd> 选择
          </span>
          <span>
            <kbd className="ink-kbd">Enter</kbd> 跳转
          </span>
          <span>
            <kbd className="ink-kbd">Esc</kbd> 关闭
          </span>
        </footer>
      </div>
    </div>
  )
}
