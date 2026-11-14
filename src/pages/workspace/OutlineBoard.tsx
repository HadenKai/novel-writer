// 章节规划板：左侧章节表（章号 / 标题 / 摘要 / 状态），右侧编辑当前章的框架与专属指令。
// 旧版把每章渲染成一张带 8 行文本框的卡片，一百章时既找不到章也无法整体浏览。
import { useMemo, useState } from 'react'
import './outline-board.css'
import { inputCls, SIcon, Icon, iconBtn } from './shared'
import type { Chapter, ChapterOutline } from '../../types'

type OutlineBoardProps = {
  items: ChapterOutline[]
  chapters?: Chapter[]
  onChange: (index: number, patch: Partial<ChapterOutline>) => void
  onMove: (index: number, dir: -1 | 1) => void
  onRemove: (index: number) => void
  onAdd: () => void
  onOpenChapter?: (index: number) => void
}

/** 章节状态胶囊：有正文且已定稿 = 已完成（竹青），停笔草稿 = 草稿（朱砂），没有正文 = 未开始（中性） */
function chapterState(ch?: Chapter) {
  if (!ch || !(ch.content || '').trim()) return { label: '未开始', tone: '' }
  if (ch.status === 'draft') return { label: '草稿', tone: ' ink-status--seal' }
  return { label: '已完成', tone: ' ink-status--jade' }
}

function OutlineBoard({ items, chapters = [], onChange, onMove, onRemove, onAdd, onOpenChapter }: OutlineBoardProps) {
  const [filter, setFilter] = useState('')
  // 选中项以 oid 为真源、下标由它推导：上移/下移/插入/删除会让序号整体位移，
  // 若把下标当状态，用户刚点开的那一章会在列表变动后换成别的内容；
  // 而若在下标之外再记一个"锚点"来回写 state，就会把用户的主动换章误判成位移（已踩过）。
  const keyOf = (item: ChapterOutline) => item.oid || String(item.index)
  const [selectedOid, setSelectedOid] = useState<string | null>(null)

  const found = selectedOid ? items.findIndex(o => keyOf(o) === selectedOid) : -1
  // oid 失效（删除/换书/首次进入）时回落到第一条，而不是停在越界下标上
  const safeSelected = found >= 0 ? found : Math.min(0, Math.max(items.length - 1, 0))
  const current = items[safeSelected]

  const written = useMemo(() => {
    const map = new Map<number, Chapter>()
    for (const c of chapters) map.set(c.index, c)
    return map
  }, [chapters])

  const rows = items.map((item, i) => ({ item, i }))
  const visible = filter.trim()
    ? rows.filter(({ item }) =>
        (item.title + ' ' + (item.summary || '')).toLowerCase().includes(filter.trim().toLowerCase())
      )
    : rows
  const writtenCount = items.filter(o => (written.get(o.index)?.content || '').trim()).length

  const patch = (data: Partial<ChapterOutline>) => {
    if (current) onChange(safeSelected, data)
  }

  const currentChapter = current ? written.get(current.index) : undefined
  const currentState = chapterState(currentChapter)

  return (
    <div className="planning-board plan-board">
      <aside className="ink-card plan-table" aria-label="章节规划目录">
        <div className="plan-table__bar">
          <p className="plan-table__count">
            共 <b className="ink-num">{items.length}</b> 章 · 已写 <b className="ink-num">{writtenCount}</b> 章
          </p>
          <label className="ink-search plan-table__search">
            <Icon name="search" size={15} />
            <input
              value={filter}
              onChange={e => setFilter(e.target.value)}
              placeholder="搜索章节"
              aria-label="搜索章节规划"
            />
          </label>
          <button className="btn btn--ghost btn--sm" onClick={onAdd}>
            <SIcon name="plus" size={13} /> 添加章节
          </button>
        </div>
        <div className="plan-table__head" aria-hidden="true">
          <span>章号</span>
          <span>标题</span>
          <span className="plan-table__col-summary">摘要</span>
          <span>状态</span>
          <span />
        </div>
        <div className="plan-table__scroll">
          {visible.length === 0 && (
            <p className="plan-table__empty">{items.length ? '没有匹配的章节' : '尚无章节规划'}</p>
          )}
          {visible.map(({ item, i }) => {
            const chapter = written.get(item.index)
            const state = chapterState(chapter)
            const active = current === item
            const summary = (item.summary || '').replace(/\s+/g, ' ').trim()
            return (
              <div key={item.oid || i} className={`plan-row${active ? ' is-active' : ''}`}>
                <button className="plan-row__main" onClick={() => setSelectedOid(keyOf(item))} aria-current={active}>
                  <span className="plan-row__no mono">{String(item.index).padStart(2, '0')}</span>
                  <span className="plan-row__title">{item.title || '未命名章节'}</span>
                  <span className={`plan-row__summary${summary ? '' : ' is-empty'}`}>{summary || '—'}</span>
                  <span
                    className={`ink-status plan-row__state${state.tone}`}
                    title={chapter?.words ? `已写 ${chapter.words} 字` : undefined}
                  >
                    {state.label}
                  </span>
                </button>
                <div className="plan-row__ops">
                  <button
                    onClick={() => onMove(i, -1)}
                    disabled={i === 0}
                    className={`${iconBtn} disabled:pointer-events-none disabled:opacity-30`}
                    aria-label={`把第 ${item.index} 章上移`}
                    title="上移"
                  >
                    <SIcon name="up" size={13} />
                  </button>
                  <button
                    onClick={() => onMove(i, 1)}
                    disabled={i >= items.length - 1}
                    className={`${iconBtn} disabled:pointer-events-none disabled:opacity-30`}
                    aria-label={`把第 ${item.index} 章下移`}
                    title="下移"
                  >
                    <SIcon name="down" size={13} />
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      </aside>

      <section className="ink-card plan-detail" aria-label="当前章节规划">
        {!current ? (
          <div className="ink-empty plan-detail__empty">
            <h3>暂无章节规划</h3>
            <p>点「添加章节」新建一章，或到「与 AI 讨论」让 AI 先拟一份总纲。</p>
          </div>
        ) : (
          <>
            <header className="plan-detail__head">
              <div className="plan-detail__meta">
                <span className="ink-kicker">第 {current.index} 章</span>
                <span className={`ink-status${currentState.tone}`}>{currentState.label}</span>
                {!!currentChapter?.words && (
                  <span className="plan-detail__words mono">已写 {currentChapter.words.toLocaleString()} 字</span>
                )}
              </div>
              <div className="plan-detail__actions">
                {onOpenChapter && (
                  <button className="btn btn--ghost btn--sm" onClick={() => onOpenChapter(current.index)}>
                    <Icon name="open" size={14} /> 前往正文
                  </button>
                )}
                <button className="btn btn--danger btn--sm" onClick={() => onRemove(safeSelected)} title="删除本章规划">
                  删除规划
                </button>
              </div>
              <input
                className="plan-detail__title"
                value={current.title}
                onChange={e => patch({ title: e.target.value })}
                placeholder="章节标题"
                aria-label={`第 ${current.index} 章标题`}
              />
            </header>

            <label className="plan-detail__field">
              <span>本章框架</span>
              <textarea
                className={`${inputCls} plan-detail__frame`}
                rows={12}
                value={current.summary}
                onChange={e => patch({ summary: e.target.value })}
                placeholder={
                  '本章要发生什么：\n【开场】场景、氛围、切入画面\n【事件】1. … 2. … 3. …\n【交锋】人物互动与冲突\n【情感】主角情感弧线\n【钩子】结尾悬念'
                }
              />
            </label>

            <label className="plan-detail__field">
              <span>本章指令（优先于全书写作偏好）</span>
              <textarea
                className={inputCls}
                rows={4}
                value={current.customPrompt}
                onChange={e => patch({ customPrompt: e.target.value })}
                placeholder={'例如：\n· 以雨夜追逐战开场，节奏要快\n· 结尾让主角捡到半块玉佩，埋下身世伏笔'}
              />
            </label>
          </>
        )}
      </section>
    </div>
  )
}

export default OutlineBoard
