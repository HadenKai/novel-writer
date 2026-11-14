import { useDeferredValue, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../lib/api'
import { desktop } from '../lib/desktop'
import { GENRES } from '../lib/constants'
import { coverTone } from '../lib/cover'
import ModelSelect from '../components/ModelSelect'
import MenuSelect from '../components/MenuSelect'
import ModalShell from '../components/ModalShell'
import WritingStatsCard from '../components/WritingStatsCard'
import { CloudScroll, CoverArt, InkLandscape } from '../components/InkArt'
import { useModels } from '../lib/hooks/useModels'
import { useDailyStats } from '../lib/hooks/useDailyStats'
import { confirmDialog, alertDialog } from '../components/Dialog'
import { staggerIndex, withViewTransition } from '../lib/motion'
import type { Novel, NovelMeta, RecycleItem } from '../types'
import './home.css'

type ViewMode = 'grid' | 'list'
type SortOrder = 'updated' | 'title' | 'progress'
type IconName = 'plus' | 'search' | 'grid' | 'list' | 'trash' | 'chevron' | 'close' | 'book' | 'chart' | 'image'

function HomeIcon({ name }: { name: IconName }) {
  const paths: Record<IconName, React.ReactNode> = {
    image: (
      <>
        <rect x="3" y="4" width="14" height="12" rx="1.5" />
        <path d="m3.5 14 4-4 3 3 2-2 4 3.5" />
        <circle cx="13" cy="8" r="1.3" />
      </>
    ),
    plus: <path d="M10 4v12M4 10h12" />,
    search: (
      <>
        <circle cx="8.5" cy="8.5" r="5.5" />
        <path d="m13 13 4 4" />
      </>
    ),
    grid: (
      <>
        <rect x="3" y="3" width="5" height="5" rx="1" />
        <rect x="12" y="3" width="5" height="5" rx="1" />
        <rect x="3" y="12" width="5" height="5" rx="1" />
        <rect x="12" y="12" width="5" height="5" rx="1" />
      </>
    ),
    list: (
      <>
        <path d="M8 5h9M8 10h9M8 15h9" />
        <path d="M3 5h1M3 10h1M3 15h1" />
      </>
    ),
    trash: (
      <>
        <path d="M3 5h14M7 5V3h6v2M5 5l1 12h8l1-12M8 8v6M12 8v6" />
      </>
    ),
    chevron: <path d="m8 5 5 5-5 5" />,
    close: <path d="m5 5 10 10M15 5 5 15" />,
    book: (
      <>
        <path d="M5 3h10a1 1 0 0 1 1 1v13H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" />
        <path d="M6 3v11M3 15a2 2 0 0 1 2-2h11M9 7h4" />
      </>
    ),
    chart: <path d="M4 16V9M10 16V4M16 16v-5" />
  }
  return (
    <svg
      className="home-icon"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  )
}

function timeStr(ts: number) {
  if (!Number.isFinite(ts) || ts <= 0) return '暂无编辑记录'
  return new Date(ts).toLocaleDateString('zh-CN', { year: 'numeric', month: 'short', day: 'numeric' })
}

function recentTime(ts: number) {
  if (!Number.isFinite(ts) || ts <= 0) return '暂无编辑记录'
  const date = new Date(ts)
  const today = new Date()
  if (date.toDateString() === today.toDateString()) {
    return `今天 ${date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}`
  }
  today.setDate(today.getDate() - 1)
  return date.toDateString() === today.toDateString() ? '昨天' : timeStr(ts)
}

function progressOf(n: NovelMeta) {
  return n.outlineCount > 0 ? Math.max(0, Math.min(100, Math.round(((n.chaptersDone || 0) / n.outlineCount) * 100))) : 0
}

function progressText(n: NovelMeta) {
  if (n.outlineCount > 0) return `${n.chaptersDone || 0} / ${n.outlineCount} 章`
  return n.chaptersDone > 0 ? `已写 ${n.chaptersDone} 章` : '尚未开始'
}

function greeting() {
  const h = new Date().getHours()
  if (h < 5) return '夜深了'
  if (h < 11) return '早上好'
  if (h < 14) return '中午好'
  if (h < 18) return '下午好'
  return '晚上好'
}

/** 类型标签的颜色：按题材归到四种低饱和色里，同一题材始终同色 */
function genreTone(genre: string) {
  if (/奇幻|玄|仙|武|侠/.test(genre)) return 'jade'
  if (/言情|古风|宫|情/.test(genre)) return 'seal'
  if (/悬疑|推理|科幻|游戏|刑/.test(genre)) return 'slate'
  return 'gold'
}

function BookCover({ novel }: { novel: NovelMeta }) {
  const cover = api.coverUrl(novel.coverFile, novel.coverAt)
  const [failedUrl, setFailedUrl] = useState('')
  return (
    <span className="home-cover" aria-hidden="true">
      <CoverArt title={novel.title || '未命名作品'} genre={novel.genre} tone={coverTone(novel.id, novel.title)} />
      {cover && failedUrl !== cover && <img src={cover} alt="" loading="lazy" onError={() => setFailedUrl(cover)} />}
    </span>
  )
}

function BookCard({
  novel,
  modelName,
  coverBusy,
  disabled,
  index,
  onRemove,
  onPickCover
}: {
  novel: NovelMeta
  modelName?: string
  coverBusy: boolean
  disabled: boolean
  /** 列表中的位置：用于入场错峰动画 */
  index?: number
  onRemove: () => void
  onPickCover: () => void
}) {
  const title = novel.title || '未命名作品'
  return (
    <article
      className="home-book stagger-item"
      style={index === undefined ? undefined : staggerIndex(index)}
      aria-label={title}
    >
      <Link className="home-book-main" to={`/novel/${novel.id}`} aria-label={`打开《${title}》`}>
        <span className="home-book-stage">
          <BookCover novel={novel} />
        </span>
        <div className="home-book-info">
          <div className="home-book-text">
            <h3 title={title}>{title}</h3>
            <div className="home-book-meta">
              <span className={`ink-pill ink-pill--${genreTone(novel.genre || '')}`}>{novel.genre || '未分类'}</span>
              {modelName && (
                <span className="home-book-model" title={modelName}>
                  {modelName}
                </span>
              )}
            </div>
          </div>
          <div className="home-book-progress">
            <div
              className="ink-progress"
              role="progressbar"
              aria-label={`《${title}》章节进度`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progressOf(novel)}
              aria-valuetext={progressText(novel)}
            >
              <span style={{ width: `${progressOf(novel)}%` }} />
            </div>
            <span>{progressText(novel)}</span>
          </div>
          <div className="home-book-date" title={timeStr(novel.updatedAt)}>
            更新于 {recentTime(novel.updatedAt)}
          </div>
        </div>
      </Link>
      <CloudScroll className="home-book-ornament" />
      <div className="home-book-actions">
        <button
          type="button"
          className="home-text-button"
          onClick={onPickCover}
          disabled={disabled}
          aria-label={`更换《${title}》的封面`}
        >
          {coverBusy ? '上传中…' : '封面'}
        </button>
        <button
          type="button"
          className="home-text-button"
          onClick={onRemove}
          disabled={disabled}
          aria-label={`将《${title}》移入回收站`}
        >
          移除
        </button>
      </div>
    </article>
  )
}

export default function Home() {
  const navigate = useNavigate()
  const [novels, setNovels] = useState<NovelMeta[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [showNew, setShowNew] = useState(false)
  const [title, setTitle] = useState('')
  const [genre, setGenre] = useState(GENRES[0])
  const [creating, setCreating] = useState(false)
  const creatingRef = useRef(false)
  const models = useModels()
  const [modelId, setModelId] = useState('')
  const [folderPath, setFolderPath] = useState('')
  const [showRecycle, setShowRecycle] = useState(false)
  const [recycle, setRecycle] = useState<RecycleItem[]>([])
  const [recycleLoading, setRecycleLoading] = useState(false)
  const [recycleError, setRecycleError] = useState('')
  const [recycleBusy, setRecycleBusy] = useState('')
  const [removeBusy, setRemoveBusy] = useState('')
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<SortOrder>('updated')
  const [view, setView] = useState<ViewMode>(() => {
    try {
      return localStorage.getItem('novel-library-view') === 'list' ? 'list' : 'grid'
    } catch {
      return 'grid'
    }
  })
  const [notice, setNotice] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  const coverTargetRef = useRef<NovelMeta | null>(null)
  const [coverBusy, setCoverBusy] = useState('')

  const load = () => {
    setLoading(true)
    setLoadError('')
    return api
      .getNovels()
      .then(setNovels)
      .catch(e => {
        setLoadError((e as Error).message || '本地服务暂时不可用')
      })
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    void load()
  }, [])

  /** 通知壳层（侧栏「最近作品」）刷新列表：新增/删除/改名/换封面后不再等下一次路由切换 */
  const notifyLibraryChanged = () => {
    try {
      window.dispatchEvent(new Event('studio-novel-updated'))
    } catch {
      /* 事件不可用不影响主流程 */
    }
  }

  const changeView = (value: ViewMode) => {
    setView(value)
    try {
      localStorage.setItem('novel-library-view', value)
    } catch {
      /* 私密浏览不影响视图切换。 */
    }
  }

  const create = async () => {
    if (creatingRef.current) return
    if (!title.trim()) return alertDialog({ title: '书名不能为空', body: '请先填写作品名称。', tone: 'warning' })
    creatingRef.current = true
    setCreating(true)
    try {
      const n = await api.createNovel({
        title: title.trim(),
        genre,
        modelId: modelId || undefined,
        folderPath: folderPath.trim() || undefined
      })
      setShowNew(false)
      setTitle('')
      setModelId('')
      setFolderPath('')
      notifyLibraryChanged()
      withViewTransition(() => navigate(`/novel/${n.id}`))
    } catch (e) {
      void alertDialog({ title: '创建失败', body: (e as Error).message, tone: 'error' })
    } finally {
      creatingRef.current = false
      setCreating(false)
    }
  }

  const pickFolder = async () => {
    const shell = desktop()
    if (shell?.pickFolder) {
      const path = await shell.pickFolder().catch(() => null)
      if (path) setFolderPath(path)
    } else {
      void alertDialog({
        title: '当前无法选择文件夹',
        body: '浏览器模式下请手动输入路径，或在桌面版中选择文件夹。',
        tone: 'warning'
      })
    }
  }

  const pickCover = (n: NovelMeta) => {
    if (coverBusy) return
    coverTargetRef.current = n
    fileRef.current?.click()
  }

  const onCoverChosen = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    const target = coverTargetRef.current
    coverTargetRef.current = null
    if (!file || !target || coverBusy) return
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) {
      void alertDialog({ title: '请选择图片', body: '支持 PNG、JPG、WebP、GIF 格式。', tone: 'warning' })
      return
    }
    if (file.size > 5 * 1024 * 1024) {
      void alertDialog({ title: '图片超过大小限制', body: '请选择 5MB 以内的图片。', tone: 'warning' })
      return
    }
    setCoverBusy(target.id)
    setNotice('正在上传封面…')
    try {
      const { novel } = await api.uploadCover(target.id, file)
      setNovels(items =>
        items.map(item =>
          item.id === target.id
            ? { ...item, coverFile: novel.coverFile, coverAt: novel.coverAt, updatedAt: novel.updatedAt }
            : item
        )
      )
      setNotice(`《${target.title}》的封面已更新`)
      notifyLibraryChanged()
    } catch (err) {
      setNotice('封面上传失败，原封面已保留')
      void alertDialog({ title: '封面上传失败', body: (err as Error).message, tone: 'error' })
    } finally {
      setCoverBusy('')
    }
  }

  const remove = async (n: NovelMeta) => {
    if (removeBusy) return
    setRemoveBusy(n.id)
    try {
      const ok = await confirmDialog({
        title: `把《${n.title}》移入回收站？`,
        body: '作品将从作品库中移除，你可以随时在回收站恢复。',
        confirmText: '移入回收站',
        danger: true
      })
      if (!ok) return
      await api.deleteNovel(n.id)
      setNovels(items => items.filter(item => item.id !== n.id))
      setNotice(`《${n.title}》已移入回收站`)
      notifyLibraryChanged()
    } catch (e) {
      void alertDialog({ title: '删除失败', body: (e as Error).message, tone: 'error' })
    } finally {
      setRemoveBusy('')
    }
  }

  const loadRecycle = async () => {
    setRecycleLoading(true)
    setRecycleError('')
    try {
      setRecycle(await api.getRecycle())
    } catch (e) {
      setRecycleError((e as Error).message || '暂时无法读取回收站')
    } finally {
      setRecycleLoading(false)
    }
  }

  const restore = async (it: RecycleItem) => {
    if (recycleBusy) return
    setRecycleBusy(it.id)
    try {
      await api.restoreRecycle(it.id)
      setRecycle(items => items.filter(item => item.id !== it.id))
      setNotice(`《${it.title}》已恢复到作品库`)
      notifyLibraryChanged()
      await load()
    } catch (e) {
      void alertDialog({ title: '恢复失败', body: (e as Error).message, tone: 'error' })
    } finally {
      setRecycleBusy('')
    }
  }

  const purge = async (it: RecycleItem) => {
    if (recycleBusy) return
    setRecycleBusy(it.id)
    try {
      const ok = await confirmDialog({
        title: `彻底删除《${it.title}》？`,
        body: '此操作会永久清除该作品的全部数据，无法恢复。',
        confirmText: '彻底删除',
        danger: true
      })
      if (!ok) return
      await api.purgeRecycle(it.id)
      setRecycle(items => items.filter(item => item.id !== it.id))
      setNotice(`《${it.title}》已彻底删除`)
      notifyLibraryChanged()
    } catch (e) {
      void alertDialog({ title: '删除失败', body: (e as Error).message, tone: 'error' })
    } finally {
      setRecycleBusy('')
    }
  }

  // 搜索用延迟值过滤：输入框即时响应，列表在浏览器空闲时再重排（书多时不卡输入）
  const deferredSearch = useDeferredValue(search)
  const visibleNovels = useMemo(() => {
    const kw = deferredSearch.trim().toLocaleLowerCase()
    const filtered = kw
      ? novels.filter(n => `${n.title || ''} ${n.genre || ''}`.toLocaleLowerCase().includes(kw))
      : novels
    const ratio = (n: NovelMeta) => (n.outlineCount > 0 ? (n.chaptersDone || 0) / n.outlineCount : 0)
    return [...filtered].sort((a, b) => {
      const updated = (b.updatedAt || 0) - (a.updatedAt || 0)
      if (sort === 'title') return (a.title || '').localeCompare(b.title || '', 'zh-CN') || updated
      if (sort === 'progress') return ratio(b) - ratio(a) || updated
      return updated
    })
  }, [novels, deferredSearch, sort])
  const recent = useMemo(
    () => [...novels].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 3),
    [novels]
  )

  // 「继续创作」只为最近一本书拉目录元信息（不带正文），用来显示字数、写到第几章与主要人物
  const { today, streak } = useDailyStats()
  const featureId = recent[0]?.id || ''
  const featureAt = recent[0]?.updatedAt || 0
  const [featureMeta, setFeatureMeta] = useState<Novel | null>(null)
  useEffect(() => {
    if (!featureId) return
    let alive = true
    api
      .getNovelMeta(featureId)
      .then(n => {
        if (alive) setFeatureMeta(n)
      })
      .catch(() => {
        if (alive) setFeatureMeta(null)
      })
    return () => {
      alive = false
    }
  }, [featureId, featureAt])
  const feature = useMemo(() => {
    const n = featureMeta && featureMeta.id === featureId ? featureMeta : null
    if (!n) return null
    const chapters = [...(n.chapters || [])].sort((a, b) => a.index - b.index)
    const words = chapters.reduce((s, c) => s + (c.words || 0), 0)
    const plan = (n.targetWords || 0) * Math.max(n.chapterCount || 0, chapters.length)
    const cast = [n.protagonist, ...(n.characters || [])]
      .map(c => c?.name?.trim())
      .filter(Boolean)
      .slice(0, 3) as string[]
    // 与写作区的落点一致：上次停留的章节（按 oid 记忆），没有记录就是第一章
    let last: { oid?: string; index?: number } = {}
    try {
      last = JSON.parse(localStorage.getItem('writer-position:' + n.id) || '{}') || {}
    } catch {
      /* 回落到第一章 */
    }
    const at = chapters.find(c => (last.oid ? c.oid === last.oid : c.index === last.index)) || chapters[0]
    return { words, plan, cast, at }
  }, [featureMeta, featureId])

  const featureWords = feature?.words || 0
  const featureRatio =
    feature && feature.plan > 0 ? Math.min(100, Math.round((featureWords / feature.plan) * 100)) : null

  return (
    <div className="home-page">
      <header className="home-hero">
        <InkLandscape className="home-hero-art" pagoda />
        <div className="home-hero-copy">
          <h1>{novels.length || loading ? `${greeting()}，继续写下去` : `${greeting()}，从第一部作品开始`}</h1>
          <p>
            {today > 0 ? (
              <>
                今日已写 <strong className="ink-num">{today.toLocaleString('zh-CN')}</strong> 字
                {streak > 1 ? ` · 已连续写作 ${streak} 天` : ' · 加油，书写你的故事'}
              </>
            ) : streak > 0 ? (
              `今天还没有落笔 · 已连续写作 ${streak} 天，别让它断了`
            ) : (
              '落下第一句，故事就开始了'
            )}
          </p>
        </div>
      </header>

      <div className="home-layout">
        <div className="home-main">
          {!loading && !loadError && recent.length > 0 && !search.trim() && (
            <section className="home-feature-section" aria-label="继续创作">
              <Link
                className="home-feature"
                to={`/novel/${recent[0].id}?tab=write`}
                aria-label={`继续创作《${recent[0].title || '未命名作品'}》`}
              >
                <span className="home-feature-cover">
                  <BookCover novel={recent[0]} />
                </span>
                <span className="home-feature-body">
                  <span className="home-feature-head">
                    <span className="home-feature-title" title={recent[0].title}>
                      《{recent[0].title || '未命名作品'}》
                    </span>
                    <span className={`ink-pill ink-pill--${genreTone(recent[0].genre || '')}`}>
                      {recent[0].genre || '未分类'}
                    </span>
                  </span>
                  {feature && feature.cast.length > 0 && (
                    <span className="home-feature-meta">主要人物：{feature.cast.join('、')}</span>
                  )}
                  <span className="home-feature-progress">
                    <span className="home-feature-chapter">
                      {feature?.at
                        ? `第 ${feature.at.index} 章 · ${feature.at.title || '未命名章节'}`
                        : progressText(recent[0])}
                    </span>
                    <span className="home-feature-words">
                      {feature
                        ? feature.plan > 0
                          ? `${featureWords.toLocaleString('zh-CN')} / ${feature.plan.toLocaleString('zh-CN')} 字`
                          : `${featureWords.toLocaleString('zh-CN')} 字`
                        : `最近编辑 ${recentTime(recent[0].updatedAt)}`}
                    </span>
                  </span>
                  <span
                    className="ink-progress home-feature-track"
                    role="progressbar"
                    aria-label={`《${recent[0].title || '未命名作品'}》${featureRatio === null ? '章节' : '字数'}进度`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={featureRatio ?? progressOf(recent[0])}
                    aria-valuetext={
                      featureRatio === null ? progressText(recent[0]) : `已完成计划字数的 ${featureRatio}%`
                    }
                  >
                    <span style={{ width: `${featureRatio ?? progressOf(recent[0])}%` }} />
                  </span>
                </span>
                <span className="home-feature-cta">
                  <CloudScroll className="home-feature-cta-cloud" />
                  继续创作
                  <HomeIcon name="chevron" />
                </span>
              </Link>
            </section>
          )}

          <section className="home-library" aria-labelledby="home-library-heading" aria-busy={loading}>
            <div className="home-section-heading home-library-heading">
              <h2 id="home-library-heading" className="ink-bar-title">
                {search.trim() ? '搜索结果' : '我的作品'}
                <span className="home-count">{loading ? '—' : novels.length}</span>
              </h2>
              <button type="button" className="btn btn--outline btn--sm" onClick={() => setShowNew(true)}>
                <HomeIcon name="plus" />
                新建作品
              </button>
            </div>
            {!loading && !loadError && novels.length > 0 && (
              <div className="home-toolbar">
                <label className="ink-search home-search">
                  <HomeIcon name="search" />
                  <input
                    type="search"
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    placeholder="搜索书名或类型"
                    aria-label="搜索作品"
                  />
                  {search && (
                    <button
                      type="button"
                      className="home-icon-button"
                      onClick={() => setSearch('')}
                      aria-label="清空搜索"
                    >
                      <HomeIcon name="close" />
                    </button>
                  )}
                </label>
                <div className="home-view-controls">
                  <span className="home-sort">
                    <span>排序</span>
                    <MenuSelect
                      value={sort}
                      onChange={v => setSort(v as SortOrder)}
                      ariaLabel="作品排序"
                      className="home-sort-trigger"
                      options={[
                        { value: 'updated', label: '最近编辑' },
                        { value: 'title', label: '书名' },
                        { value: 'progress', label: '写作进度' }
                      ]}
                    />
                  </span>
                  <div className="home-view-switch" role="group" aria-label="作品显示方式">
                    <button
                      type="button"
                      aria-label="网格视图"
                      title="网格视图"
                      aria-pressed={view === 'grid'}
                      onClick={() => changeView('grid')}
                    >
                      <HomeIcon name="grid" />
                    </button>
                    <button
                      type="button"
                      aria-label="列表视图"
                      title="列表视图"
                      aria-pressed={view === 'list'}
                      onClick={() => changeView('list')}
                    >
                      <HomeIcon name="list" />
                    </button>
                  </div>
                </div>
              </div>
            )}

            {loading ? (
              <div className="home-skeleton-grid" role="status" aria-label="正在载入作品">
                {[0, 1, 2].map(i => (
                  <div key={i} className="home-skeleton-card">
                    <span className="skeleton home-skeleton-cover" />
                    <span className="home-skeleton-lines">
                      <span className="skeleton home-skeleton-line" />
                      <span className="skeleton home-skeleton-line home-skeleton-line--short" />
                    </span>
                  </div>
                ))}
              </div>
            ) : loadError ? (
              <div className="ink-empty home-empty" role="alert">
                <HomeIcon name="book" />
                <h3>暂时无法打开作品库</h3>
                <p>{loadError}</p>
                <button type="button" className="btn btn--ghost btn--md" onClick={() => void load()}>
                  重新加载
                </button>
              </div>
            ) : novels.length === 0 ? (
              <div className="ink-empty home-empty home-empty--welcome">
                <InkLandscape className="home-empty-art" />
                <h3>从第一部作品开始</h3>
                <p>
                  给故事起个名字就能动笔。
                  <br />
                  人物、设定和章节都可以在创作时慢慢完善。
                </p>
                <button type="button" className="btn btn--primary btn--lg" onClick={() => setShowNew(true)}>
                  <HomeIcon name="plus" />
                  新建作品
                </button>
                <span>已有正文？创建作品后，可以在作品内导入。</span>
              </div>
            ) : visibleNovels.length === 0 ? (
              <div className="ink-empty home-empty">
                <HomeIcon name="search" />
                <h3>没有找到相关作品</h3>
                <p>试试其他书名或类型，或清空搜索查看全部作品。</p>
                <button type="button" className="btn btn--ghost btn--md" onClick={() => setSearch('')}>
                  清空搜索
                </button>
              </div>
            ) : (
              <div className={`home-collection home-collection--${view}`}>
                {view === 'list' && (
                  <div className="home-list-heading" aria-hidden="true">
                    <span>作品名称</span>
                    <span>写作进度</span>
                    <span>最近编辑</span>
                    <span>操作</span>
                  </div>
                )}
                <div className="home-books">
                  {visibleNovels.map((n, i) => (
                    <BookCard
                      key={n.id}
                      novel={n}
                      index={i}
                      coverBusy={coverBusy === n.id}
                      disabled={!!coverBusy || !!removeBusy}
                      modelName={n.modelId ? models.find(model => model.id === n.modelId)?.name : undefined}
                      onRemove={() => void remove(n)}
                      onPickCover={() => pickCover(n)}
                    />
                  ))}
                </div>
              </div>
            )}
            {!loading && !loadError && novels.length > 0 && (
              <p className="home-result-count" role="status">
                {search.trim()
                  ? `找到 ${visibleNovels.length} 部，共 ${novels.length} 部作品`
                  : `共 ${novels.length} 部作品`}
              </p>
            )}
          </section>

          <footer className="home-utilities">
            <p className="home-notice" role="status">
              {notice}
            </p>
            <button
              type="button"
              className="home-text-button home-recycle-button"
              onClick={() => {
                setShowRecycle(true)
                void loadRecycle()
              }}
            >
              <HomeIcon name="trash" />
              回收站
            </button>
          </footer>
        </div>

        {!loadError && (
          <aside className="home-rail" aria-label="码字统计">
            <WritingStatsCard />
          </aside>
        )}
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        className="home-file-input"
        tabIndex={-1}
        onChange={onCoverChosen}
      />

      {showRecycle && (
        <ModalShell
          title="回收站"
          width={600}
          onClose={() => setShowRecycle(false)}
          busy={!!recycleBusy}
          maxHeight="80vh"
        >
          <div className="home-dialog">
            <p className="home-dialog-description">移除的作品会保留在这里。你可以恢复作品，或将其彻底删除。</p>
            {recycleLoading ? (
              <div className="home-dialog-empty" role="status">
                正在读取回收站…
              </div>
            ) : recycleError ? (
              <div className="home-dialog-empty" role="alert">
                <p>{recycleError}</p>
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => void loadRecycle()}>
                  重新加载
                </button>
              </div>
            ) : recycle.length === 0 ? (
              <div className="home-dialog-empty">
                <HomeIcon name="trash" />
                <h3>回收站是空的</h3>
                <p>移除的作品会显示在这里。</p>
              </div>
            ) : (
              <ul className="home-recycle-list">
                {recycle.map(it => (
                  <li key={it.id} className="home-recycle-item">
                    <div className="home-recycle-info">
                      <h3 title={it.title}>{it.title || '未命名作品'}</h3>
                      <p>
                        {it.genre || '未分类'} · 删除于 {timeStr(it.deletedAt)}
                      </p>
                    </div>
                    <div className="home-recycle-actions">
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        disabled={!!recycleBusy}
                        onClick={() => void restore(it)}
                        aria-label={`恢复《${it.title}》`}
                      >
                        恢复
                      </button>
                      <button
                        type="button"
                        className="btn btn--danger btn--sm"
                        disabled={!!recycleBusy}
                        onClick={() => void purge(it)}
                        aria-label={`彻底删除《${it.title}》`}
                      >
                        彻底删除
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </ModalShell>
      )}

      {showNew && (
        <ModalShell title="新建作品" width={480} onClose={() => setShowNew(false)} busy={creating} maxHeight="86vh">
          <form
            className="home-dialog home-create-form"
            onSubmit={e => {
              e.preventDefault()
              void create()
            }}
            onKeyDown={e => {
              if (e.key === 'Enter' && e.nativeEvent.isComposing) e.preventDefault()
            }}
          >
            <p className="home-dialog-description">先为故事起个名字，其余设定可以随时调整。</p>
            <fieldset disabled={creating} className="home-form-fields">
              <label className="home-field">
                <span>书名</span>
                <input
                  autoFocus
                  required
                  value={title}
                  onChange={e => setTitle(e.target.value)}
                  placeholder="例如：长夜燃灯"
                  className="home-input"
                />
              </label>
              <span className="home-field">
                <span>类型</span>
                <MenuSelect
                  value={genre}
                  onChange={setGenre}
                  ariaLabel="作品类型"
                  className="home-input"
                  options={GENRES.map(g => ({ value: g, label: g }))}
                />
              </span>
              <label className="home-field">
                <span>
                  使用模型 <small>可稍后设置</small>
                </span>
                <ModelSelect
                  value={modelId}
                  onChange={setModelId}
                  models={models}
                  placeholder="使用默认模型"
                  className="home-input"
                />
                {models.length === 0 && (
                  <span className="home-field-hint">尚未配置模型，可先创建作品，再到「模型设置」添加。</span>
                )}
              </label>
              <label className="home-field" htmlFor="home-folder">
                <span>
                  参考小说文件夹 <small>可选</small>
                </span>
              </label>
              <div className="home-folder-row">
                <input
                  id="home-folder"
                  value={folderPath}
                  onChange={e => setFolderPath(e.target.value)}
                  placeholder="输入文件夹路径"
                  aria-describedby="home-folder-hint"
                  className="home-input"
                />
                <button onClick={() => void pickFolder()} type="button" className="btn btn--ghost btn--md">
                  浏览…
                </button>
              </div>
              <p id="home-folder-hint" className="home-field-hint">
                用于分析参考小说的人物与剧情，辅助同人创作。不需要时可以留空。
              </p>
            </fieldset>
            <div className="home-dialog-footer">
              <button
                type="button"
                className="btn btn--ghost btn--md"
                disabled={creating}
                onClick={() => setShowNew(false)}
              >
                取消
              </button>
              <button type="submit" disabled={creating || !title.trim()} className="btn btn--primary btn--md">
                {creating ? '正在创建…' : '创建作品'}
              </button>
            </div>
          </form>
        </ModalShell>
      )}
    </div>
  )
}
