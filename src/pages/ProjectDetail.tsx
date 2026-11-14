import { useMemo, useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { useNovel } from '../lib/hooks/useNovel'
import type { Chapter } from '../types'

function fmtDate(ts: number) {
  try {
    const d = new Date(ts)
    return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日`
  } catch {
    return ''
  }
}

/** 章节正文首段摘要，用于列表折叠态预览 */
function excerpt(content: string, n = 68): string {
  const t = String(content || '')
    .replace(/\s+/g, ' ')
    .trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}

/**
 * 小说项目详情：点击一本书后展开其全部章节
 * 章节以清晰列表呈现，可就地展开看摘要，或进入编辑页修改正文。
 */
export default function ProjectDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { novel, loadError } = useNovel(id)
  const [openIdx, setOpenIdx] = useState<number | null>(null)
  const [query, setQuery] = useState('')
  const [showMeta, setShowMeta] = useState(true)

  const chapters: Chapter[] = useMemo(() => {
    const list = novel?.chapters || []
    return [...list].sort((a, b) => a.index - b.index)
  }, [novel])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return chapters
    return chapters.filter(
      c =>
        String(c.index).includes(q) ||
        (c.title || '').toLowerCase().includes(q) ||
        (c.content || '').toLowerCase().includes(q)
    )
  }, [chapters, query])

  if (loadError) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-10">
        <div className="card-surface p-6 text-[13px] text-[var(--seal)]">{loadError}</div>
        <div className="mt-4">
          <Link to="/" className="btn btn--ghost btn--md">
            ← 返回全部作品
          </Link>
        </div>
      </div>
    )
  }

  if (!novel) return <div className="p-10 text-[var(--text-dim)]">加载中……</div>

  const totalWords = chapters.reduce((s, c) => s + (c.words || 0), 0)
  const doneCount = chapters.filter(c => c.status === 'done').length
  const outlineCount = (novel.outline || []).length
  const progress = novel.chapterCount > 0 ? Math.min(100, Math.round((doneCount / novel.chapterCount) * 100)) : 0

  return (
    <div className="mx-auto h-full max-w-4xl px-6 py-6">
      {/* 头部：项目信息 */}
      <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[11px] text-[var(--text-faint)]">
            <Link to="/" className="transition hover:text-[var(--gold)]">
              全部作品
            </Link>
            <span>/</span>
            <span className="text-[var(--text-dim)]">{novel.genre || '未分类'}</span>
          </div>
          <h1 className="mt-1.5 truncate text-[16px] font-semibold tracking-tight text-[var(--text)]">
            《{novel.title}》
          </h1>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-[var(--text-faint)]">
            <span>更新于 {fmtDate(novel.updatedAt)}</span>
            <span>·</span>
            <span>大纲 {outlineCount} 章</span>
            <span>·</span>
            <span>成稿 {doneCount} 章</span>
            <span>·</span>
            <span>累计 {totalWords.toLocaleString()} 字</span>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <button onClick={() => navigate(`/butler?id=${id}`)} className="btn btn--primary btn--sm">
            去写作
          </button>
          <button onClick={() => navigate(`/novel/${id}`)} className="btn btn--ghost btn--sm">
            设定
          </button>
          <button onClick={() => navigate(`/butler?id=${id}`)} className="btn btn--outline btn--sm">
            问管家
          </button>
        </div>
      </div>

      {/* 进度条 */}
      <div className="card-surface mb-5 px-4 py-3">
        <div className="mb-2 flex items-baseline justify-between">
          <span className="text-[11px] text-[var(--text-faint)]">写作进度</span>
          <span className="mono text-[11px] text-[var(--gold)]">{progress}%</span>
        </div>
        <div className="h-1.5 w-full rounded-[3px] bg-[var(--panel2)]">
          <div
            className="h-full rounded-[3px] bg-[var(--gold)] transition-[width] duration-200"
            style={{ width: `${progress}%` }}
          />
        </div>
        <div className="mono mt-2 flex items-center justify-between text-[10px] text-[var(--text-faint)]">
          <span>
            {doneCount} / {novel.chapterCount} 章
          </span>
          <span>每章目标 {novel.targetWords > 0 ? novel.targetWords.toLocaleString() : '—'} 字</span>
        </div>
      </div>

      {/* 设定概览（可折叠） */}
      <div className="card-surface mb-5 overflow-hidden">
        <button
          onClick={() => setShowMeta(v => !v)}
          className="flex w-full items-center justify-between px-4 py-2.5 text-left transition-colors hover:bg-[var(--hover)]"
        >
          <span className="text-[12px] font-medium text-[var(--text)]">作品设定</span>
          <svg
            className={`h-3 w-3 shrink-0 text-[var(--text-faint)] transition-transform duration-150 ${showMeta ? 'rotate-180' : ''}`}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.8}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
        {showMeta && (
          <div className="px-4 py-3.5">
            <p className="whitespace-pre-wrap text-[12px] leading-[1.9] text-[var(--text-dim)]">
              {novel.synopsis?.trim() || '（尚未填写简介）'}
            </p>
            {novel.masterOutline?.trim() && (
              <div className="mt-3 rounded-[9px] bg-[var(--panel2)] px-3.5 py-2.5">
                <div className="mb-1 text-[10px] text-[var(--text-faint)]">总纲</div>
                <p className="whitespace-pre-wrap text-[12px] leading-[1.85] text-[var(--text-dim)]">
                  {novel.masterOutline.slice(0, 260)}
                  {novel.masterOutline.length > 260 ? '…' : ''}
                </p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* 章节列表 */}
      <div className="card-surface overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5">
          <div className="flex items-center gap-2">
            <span className="text-[12px] font-medium text-[var(--text)]">全部章节</span>
            <span className="mono rounded-[7px] bg-[var(--panel2)] px-1.5 py-px text-[10px] text-[var(--text-faint)]">
              {chapters.length}
            </span>
          </div>
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="搜索章号 / 标题 / 正文…"
            className="h-8 w-56 rounded-[9px] border border-transparent bg-[var(--panel2)] px-3 text-[12px] text-[var(--text)] placeholder:text-[var(--text-faint)]"
          />
        </div>

        {chapters.length === 0 ? (
          <div className="px-5 py-14 text-center">
            <div className="text-[13px] font-medium text-[var(--text-dim)]">还没有章节</div>
            <p className="mt-1.5 text-[12px] text-[var(--text-faint)]">先到「本书管家」里排大纲并撰写正文。</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-5 py-14 text-center text-[12px] text-[var(--text-faint)]">没有匹配的章节</div>
        ) : (
          <div className="divide-y divide-[var(--line-soft)]">
            {filtered.map(c => {
              const open = openIdx === c.index
              return (
                <div key={c.oid || c.index} className="cv-auto">
                  <button
                    onClick={() => setOpenIdx(open ? null : c.index)}
                    className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-[var(--hover)]"
                  >
                    <span
                      className={`h-1.5 w-1.5 shrink-0 rounded-full ${c.status === 'done' ? 'bg-[var(--jade)]' : 'bg-[var(--gold)]/60'}`}
                      title={c.status === 'done' ? '已定稿' : '草稿'}
                    />
                    <span className="mono w-8 shrink-0 text-right text-[11px] text-[var(--text-faint)]">{c.index}</span>
                    <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--text)]">
                      {c.title || `第 ${c.index} 章`}
                    </span>
                    {c.orphan && (
                      <span className="shrink-0 rounded-[7px] bg-[color-mix(in_srgb,var(--seal)_12%,var(--panel))] px-1.5 py-px text-[10px] text-[var(--seal)]">
                        孤立
                      </span>
                    )}
                    <span className="mono shrink-0 text-[11px] text-[var(--text-faint)]">
                      {(c.words || 0).toLocaleString()} 字
                    </span>
                    <svg
                      className={`h-3 w-3 shrink-0 text-[var(--text-faint)] transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={1.8}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M9 6l6 6-6 6" />
                    </svg>
                  </button>

                  {open && (
                    <div className="rounded-b bg-[var(--panel2)]/50 px-4 py-3.5">
                      <p className="serif whitespace-pre-wrap text-[12px] leading-[1.9] text-[var(--text-dim)]">
                        {excerpt(c.content, 200) || '（本章还没有正文）'}
                      </p>
                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        <button
                          onClick={() => navigate(`/novel/${id}/chapter/${c.index}`)}
                          className="btn btn--primary btn--sm"
                        >
                          查看 / 编辑
                        </button>
                        <button onClick={() => navigate(`/novel/${id}?tab=book`)} className="btn btn--ghost btn--sm">
                          在成书页阅读
                        </button>
                        <button onClick={() => navigate(`/novel/${id}?tab=refine`)} className="btn btn--ghost btn--sm">
                          送去精修
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
