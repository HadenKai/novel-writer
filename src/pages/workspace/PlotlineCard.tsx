// 从 Workspace.tsx 拆出的组件（原文件 1981 行 → 主文件 + 10 个小文件）。
// 墨金泳道：色条 + 线名 / 目标，节点按章号排开、鎏金细线相连；点泳道或节点在行内展开完整编辑。
import { memo, useId, useRef, useState } from 'react'
import './plotline.css'
import {
  inputCls,
  labelCls,
  SIcon,
  Icon,
  PLOT_TYPES,
  PLOT_STATUS,
  STATUS_COLOR,
  newId,
  iconBtn,
  iconBtnDanger,
  plotTone
} from './shared'
import MenuSelect from '../../components/MenuSelect'
import type { Plotline, PlotBeat } from '../../types'

type PlotlineCardProps = {
  line: Plotline
  onChange: (patch: Partial<Plotline>) => void
  onRemove: () => void
  /** 已写到第几章：标出「当前进度」所在的节点（0 = 不标） */
  progress?: number
}

// 展开态是组件内部 state，父级列表增删其它线时不必重渲染本条。
function PlotlineCard({ line, onChange, onRemove, progress = 0 }: PlotlineCardProps) {
  const [open, setOpen] = useState(false)
  // 多张剧情线卡片同页渲染，label/input 必须靠实例级 id 关联，不能写死。
  const uid = useId()
  const status = PLOT_STATUS.find(s => s.key === line.status) || PLOT_STATUS[0]
  const lineName = line.name || '未命名剧情线'
  const beats = line.beats || []
  // 泳道只是视图：按章号排开（未定章号的排在最后），编辑区仍保持原有顺序
  const sorted = [...beats].sort((a, b) => (a.chapter || 9999) - (b.chapter || 9999))
  const current = progress > 0 ? [...sorted].reverse().find(b => b.chapter > 0 && b.chapter <= progress) : undefined
  // 节点名输入框：点泳道里的节点时展开编辑并聚焦到对应输入
  const beatInputs = useRef(new Map<string, HTMLInputElement>())
  const pendingFocus = useRef<string | null>(null)

  const focusBeat = (bid: string) => {
    const el = beatInputs.current.get(bid)
    if (!el) return false
    el.focus({ preventScroll: true })
    el.scrollIntoView({ block: 'center' })
    return true
  }
  const openAt = (bid?: string) => {
    if (bid && open && focusBeat(bid)) return
    pendingFocus.current = bid || null
    setOpen(true)
  }
  const bindBeatInput = (bid: string) => (el: HTMLInputElement | null) => {
    if (!el) {
      beatInputs.current.delete(bid)
      return
    }
    beatInputs.current.set(bid, el)
    if (pendingFocus.current === bid) {
      pendingFocus.current = null
      focusBeat(bid)
    }
  }

  const updateBeat = (bid: string, patch: Partial<PlotBeat>) =>
    onChange({ beats: line.beats.map(b => (b.id === bid ? { ...b, ...patch } : b)) })
  const addBeat = () => {
    const bid = newId()
    onChange({ beats: [...line.beats, { id: bid, title: '', summary: '', chapter: 0 }] })
    openAt(bid)
  }
  const removeBeat = (bid: string) => onChange({ beats: line.beats.filter(b => b.id !== bid) })
  const sortBeats = () => onChange({ beats: [...line.beats].sort((a, b) => (a.chapter || 9999) - (b.chapter || 9999)) })

  return (
    <article className={`plan-lane plan-lane--${plotTone(line.type)}${open ? ' is-open' : ''}`} aria-label={lineName}>
      <div className="plan-lane__row">
        <button
          type="button"
          className="plan-lane__label"
          onClick={() => setOpen(o => !o)}
          aria-expanded={open}
          aria-label={`${open ? '折叠' : '展开'}剧情线「${lineName}」`}
        >
          <span className="plan-lane__bar" aria-hidden="true" />
          <span className="plan-lane__text">
            <span className={`plan-lane__name${line.status === 'done' ? ' is-done' : ''}`}>{lineName}</span>
            <span className="plan-lane__meta">
              <span className="plan-lane__type">{line.type}</span>
              <span className={STATUS_COLOR[line.status]}>{status.label}</span>
              <span className="mono">{beats.length} 节点</span>
            </span>
            <span className="plan-lane__goal" title={line.goal || line.description || undefined}>
              {line.goal || line.description || '（无概述）'}
            </span>
          </span>
        </button>

        <ol className="plan-lane__track" aria-label={`「${lineName}」的推进节点`}>
          {sorted.length === 0 && (
            <li>
              <span className="plan-lane__none">暂无节点</span>
            </li>
          )}
          {sorted.map(b => (
            <li key={b.id}>
              <button
                type="button"
                className={`plan-beat${current?.id === b.id ? ' is-current' : ''}`}
                onClick={() => openAt(b.id)}
                title={b.summary || undefined}
                aria-label={`编辑节点：${b.chapter ? `第${b.chapter}章` : '章号未定'} ${b.title || '未命名节点'}`}
              >
                <span className="plan-beat__ch">{b.chapter ? `第${b.chapter}章` : '章号未定'}</span>
                <span className="plan-beat__title">{b.title || '未命名节点'}</span>
              </button>
            </li>
          ))}
          <li className="plan-lane__add">
            <button
              type="button"
              className="plan-lane__plus"
              onClick={addBeat}
              aria-label={`给「${lineName}」添加推进节点`}
              title="添加推进节点"
            >
              <SIcon name="plus" size={15} />
            </button>
          </li>
        </ol>

        <button
          type="button"
          onClick={onRemove}
          className={`${iconBtnDanger} plan-lane__del`}
          aria-label={`删除剧情线「${lineName}」`}
          title="删除这条剧情线"
        >
          <Icon name="trash" size={16} />
        </button>
      </div>

      {open && (
        <div className="plan-lane__editor">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div>
              <label className={labelCls} htmlFor={`${uid}-name`}>
                线名
              </label>
              <input
                id={`${uid}-name`}
                className={inputCls}
                value={line.name}
                onChange={e => onChange({ name: e.target.value })}
                placeholder="如：登顶之路"
              />
            </div>
            <div>
              <span className={labelCls}>类型</span>
              <MenuSelect
                className={inputCls}
                value={line.type}
                onChange={v => onChange({ type: v })}
                ariaLabel="剧情线类型"
                options={PLOT_TYPES.map(t => ({ value: t, label: t }))}
              />
            </div>
            <div>
              <span className={labelCls}>状态</span>
              <MenuSelect
                className={inputCls}
                value={line.status}
                onChange={v => onChange({ status: v as Plotline['status'] })}
                ariaLabel="剧情线状态"
                options={PLOT_STATUS.map(s => ({ value: s.key, label: s.label }))}
              />
            </div>
          </div>
          <div>
            <label className={labelCls} htmlFor={`${uid}-goal`}>
              目标（这条线最终要达成什么）
            </label>
            <input
              id={`${uid}-goal`}
              className={inputCls}
              value={line.goal}
              onChange={e => onChange({ goal: e.target.value })}
              placeholder="如：主角查明灭门真相并复仇"
            />
          </div>
          <div>
            <label className={labelCls} htmlFor={`${uid}-desc`}>
              概述（如何推进、在哪爆发、如何收束）
            </label>
            <textarea
              id={`${uid}-desc`}
              className={inputCls}
              rows={3}
              value={line.description}
              onChange={e => onChange({ description: e.target.value })}
              placeholder="起于何处、经过哪些转折、终于何处；与总纲的哪个阶段/伏笔对应"
            />
          </div>
          <div>
            <label className={labelCls} htmlFor={`${uid}-chars`}>
              关联人物（用顿号分隔）
            </label>
            <input
              id={`${uid}-chars`}
              className={inputCls}
              value={line.characters.join('、')}
              onChange={e =>
                onChange({
                  characters: e.target.value
                    .split(/[、,]/)
                    .map(s => s.trim())
                    .filter(Boolean)
                })
              }
              placeholder="如：林晚、沈修言"
            />
          </div>
          <div>
            <div className="mb-2 flex items-center justify-between gap-3">
              <span className="plan-label !mb-0">推进节点（按章号递增）</span>
              <div className="flex gap-3">
                {line.beats.length > 1 && (
                  <button onClick={sortBeats} className="plan-textbtn">
                    按章号排序
                  </button>
                )}
                <button onClick={addBeat} className="plan-textbtn plan-textbtn--gold" aria-label="添加推进节点">
                  <SIcon name="plus" size={12} /> 加节点
                </button>
              </div>
            </div>
            <div className="space-y-2">
              {line.beats.map((b, i) => (
                <div key={b.id} className="ink-well plan-beat-edit">
                  <div className="flex items-center gap-2">
                    <span className="mono w-5 shrink-0 text-center text-[12px] text-[var(--text-faint)]" aria-hidden>
                      {i + 1}
                    </span>
                    <input
                      ref={bindBeatInput(b.id)}
                      className="plan-beat-edit__title"
                      value={b.title}
                      onChange={e => updateBeat(b.id, { title: e.target.value })}
                      placeholder="节点名（如：初入宗门）"
                      aria-label={`第 ${i + 1} 个节点名`}
                    />
                    <div className="flex shrink-0 items-center gap-1 text-[12px] text-[var(--text-faint)]">
                      约
                      <input
                        type="number"
                        min={0}
                        className="plan-beat-edit__ch"
                        value={b.chapter || ''}
                        onChange={e =>
                          updateBeat(b.id, { chapter: Math.max(0, Math.floor(Number(e.target.value) || 0)) })
                        }
                        placeholder="?"
                        aria-label={`节点「${b.title || i + 1}」的章号`}
                      />
                      章
                      <button
                        onClick={() => removeBeat(b.id)}
                        className={`${iconBtn} hover:!text-[var(--seal)]`}
                        aria-label={`删除节点「${b.title || i + 1}」`}
                        title="删除该节点"
                      >
                        <SIcon name="x" size={12} />
                      </button>
                    </div>
                  </div>
                  <textarea
                    className="plan-beat-edit__summary"
                    rows={2}
                    value={b.summary}
                    onChange={e => updateBeat(b.id, { summary: e.target.value })}
                    placeholder="该节点发生什么（60~120 字），将提示给 AI 对齐推进"
                    aria-label={`节点「${b.title || i + 1}」的内容`}
                  />
                </div>
              ))}
              {line.beats.length === 0 && (
                <p className="rounded-[var(--r-md)] border border-dashed border-[var(--line-strong)] py-3 text-center text-[12px] text-[var(--text-faint)]">
                  暂无节点
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </article>
  )
}

export default memo(PlotlineCard)
