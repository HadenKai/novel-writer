import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import './shell.css'
import { Routes, Route, NavLink, useLocation, useNavigate, Navigate, useParams } from 'react-router-dom'
import type { ReactNode } from 'react'
import { api } from './lib/api'
import Home from './pages/Home'
import Studio from './pages/Studio'
import { STUDIO_SECTION, STUDIO_TABS, isStudioTab, type StudioTab } from './pages/studio-tabs'
import Butler from './pages/Butler'
import Knowledge from './pages/Knowledge'
import Settings from './pages/Settings'
import Shelf from './pages/Shelf'
import { DialogHost } from './components/Dialog'
import { ToastHost } from './components/Toast'
import CommandPalette from './components/CommandPalette'
import { openCommandPalette } from './lib/commands'
import ErrorBoundary from './components/ErrorBoundary'
import { InkLandscape, Seal } from './components/InkArt'
import { desktop } from './lib/desktop'
import { useDailyStats } from './lib/hooks/useDailyStats'
import { MOTION_TIER_EVENT, installLinkTransitions, supportsViewTransitions, withViewTransition } from './lib/motion'

type Theme = 'light' | 'dark'

function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      const saved = localStorage.getItem('studio-theme-ink') as Theme | null
      if (saved === 'light' || saved === 'dark') return saved
      return 'dark'
    } catch {
      return 'dark'
    }
  })

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
    document.documentElement.style.colorScheme = theme
  }, [theme])

  const explicitTheme = useRef(false)
  const toggle = () => {
    explicitTheme.current = true
    setTheme(t => (t === 'dark' ? 'light' : 'dark'))
  }
  useEffect(() => {
    if (!explicitTheme.current) return
    try {
      localStorage.setItem('studio-theme-ink', theme)
    } catch {}
  }, [theme])

  // 命令面板里的「切换深浅色主题」走全局事件进来，避免把 theme state 层层下传
  useEffect(() => {
    const onToggle = () => toggle()
    window.addEventListener('studio-toggle-theme', onToggle)
    return () => window.removeEventListener('studio-toggle-theme', onToggle)
  }, [])

  return { theme, toggle }
}

/* ===== 线性图标（1.5 描边，currentColor，24 栅格）===== */
function Icon({ name, size = 16, className }: { name: string; size?: number; className?: string }) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    className
  }
  switch (name) {
    case 'layers':
      return (
        <svg {...common}>
          <path d="M12 3.8 20.5 8.3 12 12.8 3.5 8.3Z" />
          <path d="m3.5 12.3 8.5 4.5 8.5-4.5" />
          <path d="m3.5 16.3 8.5 4.5 8.5-4.5" />
        </svg>
      )
    case 'books':
      return (
        <svg {...common}>
          <rect x="4" y="4.5" width="4" height="15" rx="0.8" />
          <rect x="9.5" y="6.5" width="3.6" height="13" rx="0.8" />
          <path d="m15 6.9 3.3-.9 2.9 13-3.3.9Z" />
          <path d="M3 19.5h18" />
        </svg>
      )
    case 'quill':
      return (
        <svg {...common}>
          <path d="M20 4c-7.5.4-12.6 5-13.6 12.6L5.5 20" />
          <path d="M20 4c-.6 6.8-4.6 11.2-11.6 12.4" />
          <path d="M11.5 10.8 15 9.6" />
        </svg>
      )
    case 'sitemap':
      return (
        <svg {...common}>
          <rect x="9.5" y="3.5" width="5" height="4" rx="1" />
          <rect x="3.5" y="16.5" width="5" height="4" rx="1" />
          <rect x="15.5" y="16.5" width="5" height="4" rx="1" />
          <path d="M12 7.5V12M6 16.5V12h12v4.5" />
        </svg>
      )
    case 'idcard':
      return (
        <svg {...common}>
          <rect x="3.5" y="5" width="17" height="14" rx="2" />
          <circle cx="9" cy="11" r="2.2" />
          <path d="M5.8 16.2c.6-1.6 1.8-2.5 3.2-2.5s2.6.9 3.2 2.5M14.5 10h3.5M14.5 13.5h3.5" />
        </svg>
      )
    case 'doc-check':
      return (
        <svg {...common}>
          <path d="M14 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5Z" />
          <path d="M14 3.5v5h5" />
          <path d="m9 14 2 2 4-4" />
        </svg>
      )
    case 'export':
      return (
        <svg {...common}>
          <path d="M12 4v11" />
          <path d="m7.5 10.5 4.5 4.5 4.5-4.5" />
          <path d="M5 19.5h14" />
        </svg>
      )
    case 'grid':
      return (
        <svg {...common}>
          <rect x="3" y="3" width="7.5" height="7.5" rx="1.5" />
          <rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5" />
          <rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5" />
          <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5" />
        </svg>
      )
    case 'folder':
      return (
        <svg {...common}>
          <path d="M3.5 6.5a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
        </svg>
      )
    case 'chat':
      return (
        <svg {...common}>
          <path d="M20 11.5a7 7 0 0 1-10.3 6.2L4.5 19.5l1.6-4.4A7 7 0 1 1 20 11.5Z" />
        </svg>
      )
    case 'archive':
      return (
        <svg {...common}>
          <rect x="3.5" y="4" width="17" height="4.5" rx="1.2" />
          <path d="M5.5 8.5V19a1.5 1.5 0 0 0 1.5 1.5h10A1.5 1.5 0 0 0 18.5 19V8.5" />
          <path d="M10 12h4" />
        </svg>
      )
    case 'list':
      return (
        <svg {...common}>
          <path d="M8 6h12M8 12h12M8 18h12" />
          <circle cx="4" cy="6" r="1" fill="currentColor" stroke="none" />
          <circle cx="4" cy="12" r="1" fill="currentColor" stroke="none" />
          <circle cx="4" cy="18" r="1" fill="currentColor" stroke="none" />
        </svg>
      )
    case 'sliders':
      return (
        <svg {...common}>
          <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
          <circle cx="14.5" cy="7" r="2.3" />
          <circle cx="8.5" cy="17" r="2.3" />
        </svg>
      )
    case 'messages':
      return (
        <svg {...common}>
          <path d="M12.5 4.5a7 7 0 0 0-7 7c0 1.1.26 2.15.72 3.08L5 18.5l3.4-1.1a7 7 0 1 0 4.1-12.9Z" />
        </svg>
      )
    case 'sparkle':
      return (
        <svg {...common}>
          <path d="M12 4l1.7 5.1L19 11l-5.3 1.9L12 18l-1.7-5.1L5 11l5.3-1.9z" />
          <path d="M18.5 15.5l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z" />
        </svg>
      )
    case 'book':
      return (
        <svg {...common}>
          <path d="M12 6.5C10.8 5.3 8.8 4.7 5.5 5c-.6.06-1 .56-1 1.16V18c0 .6.5 1.1 1.1 1 3-.1 4.9.5 6.4 1.6" />
          <path d="M12 6.5C13.2 5.3 15.2 4.7 18.5 5c.6.06 1 .56 1 1.16V18c0 .6-.5 1.1-1.1 1-3-.1-4.9.5-6.4 1.6" />
          <path d="M12 6.5V20.6" />
        </svg>
      )
    case 'gear':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
        </svg>
      )
    case 'sun':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2.5v2M12 19.5v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M2.5 12h2M19.5 12h2M4.2 19.8l1.4-1.4M18.4 7.6l1.4-1.4" />
        </svg>
      )
    case 'moon':
      return (
        <svg {...common}>
          <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />
        </svg>
      )
    case 'menu':
      return (
        <svg {...common}>
          <path d="M4 7h16M4 12h16M4 17h16" />
        </svg>
      )
    case 'chevron-left':
      return (
        <svg {...common}>
          <path d="M14.5 6l-6 6 6 6" />
        </svg>
      )
    case 'chevron-right':
      return (
        <svg {...common}>
          <path d="M9.5 6l6 6-6 6" />
        </svg>
      )
    case 'panel-left':
      return (
        <svg {...common}>
          <rect x="3.5" y="4.5" width="17" height="15" rx="1.8" />
          <path d="M9.5 4.5v15" />
        </svg>
      )
    case 'x':
      return (
        <svg {...common}>
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      )
    case 'pen':
      return (
        <svg {...common}>
          <path d="M14.5 5.5l4 4L8 20l-4.5.5L4 16z" />
          <path d="M12.5 7.5l4 4" />
        </svg>
      )
    case 'search':
      return (
        <svg {...common}>
          <circle cx="11" cy="11" r="6.5" />
          <path d="M20 20l-4.4-4.4" />
        </svg>
      )
    default:
      return null
  }
}

function NavItem({
  to,
  label,
  end,
  icon,
  onNavigate,
  activeWhen,
  collapsed
}: {
  to: string
  label: string
  end?: boolean
  icon?: ReactNode
  onNavigate?: () => void
  /** 自定义激活判断（优先于 NavLink 默认行为）：用于区分同路径不同查询参数的入口 */
  activeWhen?: (pathname: string, search: string) => boolean
  /** 侧栏收起态：仅显示图标，居中，附 title 提示 */
  collapsed?: boolean
}) {
  return (
    <NavLink
      to={to}
      end={end}
      onClick={onNavigate}
      title={collapsed ? label : undefined}
      className={({ isActive }) => {
        const active = activeWhen ? activeWhen(window.location.pathname, window.location.search) : isActive
        return `shell-nav-item${active ? ' is-active' : ''}${collapsed ? ' is-compact' : ''}`
      }}
    >
      <span className="shell-nav-icon">{icon}</span>
      <span className="shell-nav-label">{label}</span>
    </NavLink>
  )
}

/** 最近作品的首字小印：收起侧栏后也能分辨是哪本书 */
function BookMonogram({ title }: { title: string }) {
  return (
    <span className="shell-monogram" aria-hidden="true">
      {Array.from(title || '书')[0]}
    </span>
  )
}

function ThemeToggle({ theme, toggle }: { theme: Theme; toggle: () => void }) {
  return (
    <button
      onClick={toggle}
      title={theme === 'dark' ? '切换到宣纸（浅色）' : '切换到墨黑（深色）'}
      aria-label={theme === 'dark' ? '切换到浅色模式' : '切换到深色模式'}
      className="shell-icon-button"
    >
      <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={16} />
    </button>
  )
}

/** 自绘标题栏的窗口按钮（最小化 / 最大化 / 关闭），仅在桌面端渲染 */
function WindowControls() {
  const [maxed, setMaxed] = useState(false)
  const api = desktop()
  useEffect(() => {
    if (!api?.isMaximized) return
    api
      .isMaximized()
      .then(v => setMaxed(!!v))
      .catch(() => {})
    const off = api.onMaximized?.(v => setMaxed(!!v))
    return () => off?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  if (!api?.winClose) return null
  const btn = 'app-no-drag shell-window-btn'
  return (
    <div className="shell-window-controls">
      <button
        className={btn}
        title="最小化"
        aria-label="最小化"
        onClick={() => {
          api.winMinimize?.().catch(() => {})
        }}
      >
        <span className="block h-px w-3.5 bg-current" />
      </button>
      <button
        className={btn}
        title={maxed ? '向下还原' : '最大化'}
        aria-label={maxed ? '向下还原' : '最大化'}
        onClick={() => {
          const p = api.winMaximize?.()
          if (p) p.then(v => setMaxed(!!v)).catch(() => {})
        }}
      >
        {maxed ? (
          <span className="relative block h-3 w-3">
            <span className="absolute left-[3px] top-0 h-2.5 w-2.5 border-[1.5px] border-current" />
            <span className="absolute bottom-0 left-0 h-2.5 w-2.5 border-[1.5px] border-current bg-[var(--bg)]" />
          </span>
        ) : (
          <span className="block h-3 w-3 border-[1.5px] border-current" />
        )}
      </button>
      <button
        className={`${btn} shell-window-close`}
        title="关闭"
        aria-label="关闭"
        onClick={() => {
          api.winClose?.().catch(() => {})
        }}
      >
        <Icon name="x" size={13} />
      </button>
    </div>
  )
}

/** 作品工作区页签的图标（标签与顺序仍以 studio-tabs.ts 为准） */
const TAB_ICON: Record<StudioTab, string> = {
  write: 'quill',
  outline: 'sitemap',
  bible: 'idcard',
  refine: 'doc-check',
  book: 'export'
}

/** 由路径 + 查询参数推导当前所在板块名；作为页头面包屑的第二段 */
function sectionLabel(pathname: string, search: string): string {
  if (pathname === '/') return '作品'
  if (pathname === '/butler') return '与 AI 讨论'
  if (pathname.startsWith('/shelf')) return '素材与草稿'
  if (pathname === '/kb') return '资料库'
  if (pathname.startsWith('/settings')) return '设置'
  if (pathname.startsWith('/novel/')) {
    // 章节编辑页：标明落在正文区的第几章，与写作页签（「正文」）保持同一套命名
    const ch = pathname.match(/\/chapter\/(\d+)$/)
    if (ch) return `正文 · 第 ${Number(ch[1])} 章`
    const tab = new URLSearchParams(search).get('tab')
    return tab && tab in STUDIO_SECTION ? STUDIO_SECTION[tab as StudioTab] : STUDIO_SECTION.write
  }
  return ''
}

/**
 * 路由页面容器。
 *
 * 单独抽成 memo 组件是有意为之：侧栏收起/展开会改 Layout 的 state，
 * 若 Routes 直接写在 Layout 里，每次切换都会重建整棵页面子树，
 * 长列表页（章节列表、成书正文）会明显卡顿，甚至让点击「点几次才生效」。
 * 这里没有 props，memo 后 Layout 的 state 变化不会再触发页面重渲染；
 * 路由变化由 Routes 内部的 useLocation 自行响应，不受影响。
 */
function LegacyButlerRedirect() {
  const { id } = useParams()
  return <Navigate to={id ? `/butler?id=${encodeURIComponent(id)}` : '/butler'} replace />
}

/** 旧路径 `/projects/:id`（章节列表）与 `/projects/:id/chapter/:cid` → 工作台的写作区 */
function LegacyProjectRedirect() {
  const { id, cid } = useParams()
  if (!id) return <Navigate to="/" replace />
  return <Navigate to={cid ? `/novel/${id}/chapter/${cid}` : `/novel/${id}?tab=write`} replace />
}

/** 旧路径 `/novel/:id/refine`、`/novel/:id/read` → 工作台对应工作区 */
function LegacyTabRedirect({ tab }: { tab: StudioTab }) {
  const { id } = useParams()
  return <Navigate to={id ? `/novel/${id}?tab=${tab}` : '/'} replace />
}

const RoutedPages = memo(function RoutedPages() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/shelf" element={<Shelf />} />
      <Route path="/kb" element={<Knowledge />} />
      {/* 「小说项目」板块已并入全部作品（书架），旧入口统一回首页 */}
      <Route path="/projects" element={<Navigate to="/" replace />} />
      {/* 作品工作台：一本书的唯一入口，工作区由 ?tab= 驱动 */}
      <Route path="/novel/:id" element={<Studio />} />
      {/* 正在写某一章：章号走路径参数，便于前进后退与分享链接 */}
      <Route path="/novel/:id/chapter/:cid" element={<Studio />} />
      {/* 本书管家：必须带 ?id=，不带 id 直接回首页（独立闲聊入口已删除） */}
      <Route path="/butler" element={<Butler />} />
      {/* 旧路径兼容：历史版本与旧快捷方式统一重定向到工作台对应工作区 */}
      <Route path="/projects/:id" element={<LegacyProjectRedirect />} />
      <Route path="/projects/:id/chapter/:cid" element={<LegacyProjectRedirect />} />
      <Route path="/novel/:id/refine" element={<LegacyTabRedirect tab="refine" />} />
      <Route path="/novel/:id/read" element={<LegacyTabRedirect tab="book" />} />
      <Route path="/novel/:id/chat" element={<LegacyButlerRedirect />} />
      <Route path="/settings" element={<Settings />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
})

function Layout() {
  const location = useLocation()
  const nav = useNavigate()
  // 当前作品上下文：小说/项目路径或当前作品管家查询参数
  const match = location.pathname.match(/^\/(?:novel|projects)\/([^/]+)/)
  const butlerMatch = location.pathname === '/butler' ? new URLSearchParams(location.search).get('id') : null
  const novelId = match ? match[1] : butlerMatch
  // 作品工作区：顶部工具栏直接承载五个工作区页签，页面内不再另起一条横栏
  const studioId = location.pathname.match(/^\/novel\/([^/]+)/)?.[1] || ''
  const studioTabParam = new URLSearchParams(location.search).get('tab')
  const studioTab: StudioTab = studioId && isStudioTab(studioTabParam) ? studioTabParam : 'write'
  const { theme, toggle } = useTheme()
  // 移动端侧栏抽屉开关（桌面端常驻，不受影响）
  const [navOpen, setNavOpen] = useState(false)
  const closeNav = () => setNavOpen(false)
  // 桌面端侧栏收起/展开（持久化，跨会话保留）
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem('studio-nav-collapsed') === '1'
    } catch {
      return false
    }
  })
  const toggleCollapsed = () =>
    setCollapsed(c => {
      const n = !c
      try {
        localStorage.setItem('studio-nav-collapsed', n ? '1' : '0')
      } catch {}
      return n
    })

  const [recentBooks, setRecentBooks] = useState<{ id: string; title: string; genre?: string }[]>([])
  const [booksError, setBooksError] = useState(false)
  const currentBook = recentBooks.find(n => n.id === novelId)
  const bookTitle = currentBook?.title || ''
  const { streak } = useDailyStats()
  // 壳层按路由换表情：作品库的页头自带远山，工具栏改为透明；工作区工具栏承载页签
  const route = location.pathname === '/' ? 'home' : studioId ? 'studio' : 'page'
  useEffect(() => {
    let alive = true
    const load = () =>
      api
        .getNovels()
        .then(list => {
          if (!alive) return
          setRecentBooks([...list].sort((a, b) => b.updatedAt - a.updatedAt))
          setBooksError(false)
        })
        .catch(() => {
          if (alive) setBooksError(true)
        })
    void load()
    window.addEventListener('studio-novel-updated', load)
    // 从外部（浏览器/终端/另一窗口）改过书稿后，切回窗口时顺手刷新一次
    window.addEventListener('focus', load)
    return () => {
      alive = false
      window.removeEventListener('studio-novel-updated', load)
      window.removeEventListener('focus', load)
    }
    // 只在「切换到另一本书」时重新拉列表；同一本书内切换工作区页签不重复读盘
  }, [novelId])

  const [focusMode, setFocusMode] = useState(false)
  useEffect(() => {
    const onFocus = (e: Event) => setFocusMode((e as CustomEvent<boolean>).detail === true)
    window.addEventListener('studio-focus-mode', onFocus)
    return () => window.removeEventListener('studio-focus-mode', onFocus)
  }, [])
  useEffect(() => {
    if (navOpen && window.innerWidth < 1024) setFocusMode(false)
  }, [navOpen])

  const sidebarRef = useRef<HTMLElement>(null)
  const mobileNavRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!navOpen) return
    const previous = mobileNavRef.current
    const links = () =>
      Array.from(sidebarRef.current?.querySelectorAll<HTMLElement>('a[href],button:not([disabled])') || []).filter(
        el => el.getClientRects().length > 0
      )
    links()[0]?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        setNavOpen(false)
      }
      if (e.key !== 'Tab') return
      const items = links()
      if (!items.length) return
      const first = items[0],
        last = items[items.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      previous?.focus()
    }
  }, [navOpen])
  useEffect(() => {
    setNavOpen(false)
  }, [location.pathname, location.search])

  // 站内链接统一走 View Transitions：路由切换有连续的退场 / 进场，不再整屏硬切
  useEffect(() => installLinkTransitions(to => nav(to)), [nav])

  // 页面转场档位（见 lib/motion.ts）：full 走 View Transitions；lite 不截图，内容区用 CSS 进场。
  // 实测截图太慢时 motion.ts 会自动降到 lite 并广播，这里跟着换
  const [vtSupported, setVtSupported] = useState(() => supportsViewTransitions())
  useEffect(() => {
    const onTier = () => setVtSupported(supportsViewTransitions())
    window.addEventListener(MOTION_TIER_EVENT, onTier)
    return () => window.removeEventListener(MOTION_TIER_EVENT, onTier)
  }, [])
  // lite 档的进场：两个同效关键帧交替触发重播。用 layout effect 在绘制前换类名——
  // 普通 effect 会先以完全不透明画一帧新页，再跳回透明重播，像闪了一下
  const [enterPhase, setEnterPhase] = useState<'a' | 'b'>('a')
  useLayoutEffect(() => {
    if (!vtSupported) setEnterPhase(p => (p === 'a' ? 'b' : 'a'))
  }, [location.pathname, location.search, vtSupported])

  // 全局快捷键：Alt+1..9 快速跳页（文本输入/编辑态忽略）
  // 1 全部作品　2 设定　3 规划　4 正文　5 审校　6 预览与导出　7 素材与草稿　8 资料库　9 模型设置
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
      const el = e.target as HTMLElement | null
      const tag = el?.tagName || ''
      if (tag === 'INPUT' || tag === 'TEXTAREA' || el?.isContentEditable) return
      const pages: (string | null)[] = [
        '/',
        novelId ? `/novel/${novelId}?tab=bible` : null,
        novelId ? `/novel/${novelId}?tab=outline` : null,
        novelId ? `/novel/${novelId}?tab=write` : null,
        novelId ? `/novel/${novelId}?tab=refine` : null,
        novelId ? `/novel/${novelId}?tab=book` : null,
        '/shelf',
        '/kb',
        '/settings'
      ]
      const idx = Number(e.key) - 1
      if (idx >= 0 && idx < pages.length && pages[idx]) {
        e.preventDefault()
        withViewTransition(() => nav(pages[idx]!))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [novelId, nav])

  return (
    <div
      className={`writer-shell desktop-shell${collapsed ? ' nav-compact' : ''}${focusMode ? ' focus-mode' : ''}${navOpen ? ' nav-open' : ''}`}
      data-route={route}
    >
      <a className="shell-skip" href="#workspace-content">
        跳到正文区域
      </a>
      {navOpen && <button className="shell-scrim" aria-label="关闭导航遮罩" onClick={closeNav} />}
      <aside ref={sidebarRef} className="shell-sidebar" aria-label="主导航">
        <div className="shell-brand app-drag">
          {/* 竖排字标 + 朱砂印；收起侧栏时只留印 */}
          <span className="shell-brand-name" aria-hidden="true">
            小说工坊
          </span>
          <Seal text="稿" size={26} className="shell-brand-seal" />
          <span className="sr-only">小说工坊 · 长篇创作台</span>
          <button className="shell-mobile-close app-no-drag shell-icon-button" aria-label="关闭导航" onClick={closeNav}>
            <Icon name="x" />
          </button>
        </div>
        <nav className="shell-navigation" aria-label="应用导航">
          <NavItem to="/" label="作品" end icon={<Icon name="books" />} onNavigate={closeNav} collapsed={collapsed} />
          <NavItem to="/shelf" label="素材" icon={<Icon name="layers" />} onNavigate={closeNav} collapsed={collapsed} />
          <NavItem to="/kb" label="资料库" icon={<Icon name="book" />} onNavigate={closeNav} collapsed={collapsed} />
          <NavItem
            to="/settings"
            label="设置"
            icon={<Icon name="gear" />}
            onNavigate={closeNav}
            collapsed={collapsed}
          />
          <div className="shell-group-label">最近作品</div>
          {recentBooks.slice(0, 5).map(book => (
            <NavItem
              key={book.id}
              to={`/novel/${book.id}?tab=write`}
              label={book.title || '未命名作品'}
              icon={<BookMonogram title={book.title} />}
              collapsed={collapsed}
              onNavigate={closeNav}
              activeWhen={p => p.startsWith(`/novel/${book.id}`)}
            />
          ))}
          {!recentBooks.length && (
            <p className="shell-sidebar-note">{booksError ? '作品暂时无法读取' : '新建作品后，可在这里快速继续。'}</p>
          )}
          {novelId && (
            <>
              <div className="shell-group-label">当前作品</div>
              <NavItem
                to={`/butler?id=${novelId}`}
                label="与 AI 讨论"
                icon={<Icon name="messages" />}
                onNavigate={closeNav}
                collapsed={collapsed}
                activeWhen={(p, s) => p === '/butler' && new URLSearchParams(s).get('id') === novelId}
              />
            </>
          )}
        </nav>
        <div className="shell-sidebar-footer">
          <InkLandscape className="shell-sidebar-art" moon={false} />
          <div className="shell-streak" title="只统计手动保存的正文字数；AI 生成、导入与一键排版不计入">
            <span className="shell-streak-label">连续写作</span>
            <span className="shell-streak-value">
              <span className="ink-num">{streak}</span>
              <small>天</small>
            </span>
          </div>
          <div className="shell-storage-note">
            <span aria-hidden="true" /> 书稿保存在本机
          </div>
        </div>
      </aside>
      <main className="shell-main" aria-label="工作区">
        <header className="shell-toolbar app-drag">
          {route === 'studio' && <InkLandscape className="shell-toolbar-art" moon={false} />}
          <div className="shell-toolbar-leading">
            <button
              type="button"
              onClick={toggleCollapsed}
              className="shell-icon-button shell-desktop-toggle app-no-drag"
              aria-label={collapsed ? '展开侧栏' : '收起侧栏'}
              title={collapsed ? '展开侧栏' : '收起侧栏'}
              aria-expanded={!collapsed}
            >
              <Icon name="panel-left" size={19} />
            </button>
            <button
              ref={mobileNavRef}
              type="button"
              onClick={() => setNavOpen(true)}
              className="shell-icon-button shell-mobile-toggle app-no-drag"
              aria-label="打开导航"
              aria-expanded={navOpen}
            >
              <Icon name="panel-left" size={19} />
            </button>
            <div className="shell-breadcrumb">
              {bookTitle ? (
                <>
                  <span className="shell-book-title" title={bookTitle}>
                    {bookTitle}
                  </span>
                  <Seal text={Array.from(bookTitle)[0]} size={18} className="shell-book-seal" />
                  {currentBook?.genre && <span className="shell-book-genre">{currentBook.genre}</span>}
                </>
              ) : (
                route !== 'home' && (
                  <span className="shell-section">{sectionLabel(location.pathname, location.search)}</span>
                )
              )}
            </div>
          </div>
          {studioId && (
            <nav className="shell-toolbar-tabs app-no-drag" aria-label="作品工作区">
              {STUDIO_TABS.map(t => (
                <button
                  key={t.key}
                  type="button"
                  className={`shell-tab${studioTab === t.key ? ' is-active' : ''}`}
                  aria-current={studioTab === t.key ? 'page' : undefined}
                  onClick={() => withViewTransition(() => nav(`/novel/${studioId}?tab=${t.key}`))}
                >
                  <Icon name={TAB_ICON[t.key]} size={16} />
                  {t.label}
                </button>
              ))}
            </nav>
          )}
          <div className="shell-toolbar-actions app-no-drag">
            <button
              type="button"
              className="shell-search-button"
              onClick={openCommandPalette}
              aria-label="搜索作品、章节与命令"
              title="搜索作品、章节与命令（Ctrl+K）"
            >
              <Icon name="search" size={16} />
              <span>搜索</span>
              <kbd>Ctrl K</kbd>
            </button>
            <ThemeToggle theme={theme} toggle={toggle} />
            <WindowControls />
          </div>
        </header>
        <div
          id="workspace-content"
          className={`shell-content${vtSupported ? '' : ` route-enter-${enterPhase}`}`}
          tabIndex={-1}
        >
          <RoutedPages />
        </div>
      </main>
    </div>
  )
}

export default function App(): ReactNode {
  return (
    <ErrorBoundary>
      <Layout />
      {/* 应用内对话框宿主：confirmDialog / alertDialog 的挂载点，全局只此一处 */}
      <DialogHost />
      {/* 全局轻提示宿主：toast() 的挂载点 */}
      <ToastHost />
      {/* 全局命令面板：Ctrl+K 唤起 */}
      <CommandPalette />
    </ErrorBoundary>
  )
}
