import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { api } from '../lib/api'
import { broadcastModelUpdate, thinkingLabelOf, thinkingSteps, thinkingValue, withThinking } from '../lib/thinking'
import { toast } from './Toast'
import type { ModelConfig } from '../types'
import './menu-select.css'
import './model-picker.css'

// 模型选择器：「中转站 → 模型」两级面板，底部是思考强度滑杆与「管理模型」入口。
// 中转站按 provider + baseUrl 分组，组名优先取用户自定义名，否则显示站点域名。
// 不用原生 <select>：系统绘制的下拉弹层管不到样式，会在墨色界面里突兀成灰白列表框。

export function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname || baseUrl
  } catch {
    return baseUrl
  }
}

export function groupOfModels(models: ModelConfig[]) {
  const map = new Map<
    string,
    { key: string; provider: string; baseUrl: string; label: string; models: ModelConfig[] }
  >()
  for (const m of models) {
    const provider = m.provider === 'gemini' ? 'gemini' : 'openai'
    const base = (m.baseUrl || '').replace(/\/+$/, '')
    const key = `${provider}||${base}`
    if (!map.has(key)) {
      map.set(key, {
        key,
        provider,
        baseUrl: base,
        label: m.stationName || hostOf(base),
        models: []
      })
    }
    map.get(key)!.models.push(m)
  }
  const groups = [...map.values()]
  groups.sort(
    (a, b) =>
      (a.provider === 'gemini' ? 1 : 0) - (b.provider === 'gemini' ? 1 : 0) ||
      a.label.localeCompare(b.label) ||
      a.baseUrl.localeCompare(b.baseUrl)
  )
  return groups
}
type StationGroup = ReturnType<typeof groupOfModels>[number]

/** 面板里的站点名：同名（常见于同一台机器上的多个本地服务）时补上端口，免得看着是同一家 */
function stationLabels(groups: StationGroup[]) {
  const count = new Map<string, number>()
  for (const g of groups) count.set(g.label, (count.get(g.label) || 0) + 1)
  return new Map(
    groups.map(g => {
      if ((count.get(g.label) || 0) < 2) return [g.key, g.label]
      try {
        const u = new URL(g.baseUrl)
        return [g.key, u.port ? `${g.label}:${u.port}` : `${g.label}${u.pathname}`]
      } catch {
        return [g.key, g.label]
      }
    })
  )
}

/** 中转站的类型徽标：只用模型配置里真实存在的信息，不臆造能力标签 */
function stationBadge(g: StationGroup): { text: string; tone: 'gemini' | 'local' | 'api' } {
  if (g.provider === 'gemini') return { text: 'Gemini', tone: 'gemini' }
  if (g.models.length && g.models.every(m => m.local)) return { text: '本地', tone: 'local' }
  return { text: 'API', tone: 'api' }
}

function fmtContext(tokens?: number): string {
  if (!tokens) return ''
  if (tokens >= 1_000_000) return `${Math.round(tokens / 1_048_576)}M`
  return `${Math.round(tokens / 1024)}K`
}

function PIcon({
  name,
  size = 14
}: {
  name: 'check' | 'chevron' | 'down' | 'station' | 'sliders' | 'spark'
  size?: number
}) {
  const p = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.9,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true
  }
  if (name === 'check')
    return (
      <svg {...p}>
        <path d="M5 12.5l4.5 4.5L19 7.5" />
      </svg>
    )
  if (name === 'chevron')
    return (
      <svg {...p}>
        <path d="M9 6l6 6-6 6" />
      </svg>
    )
  if (name === 'down')
    return (
      <svg {...p}>
        <path d="M6 9l6 6 6-6" />
      </svg>
    )
  if (name === 'station')
    return (
      <svg {...p}>
        <rect x="3.5" y="4.5" width="17" height="6" rx="1.6" />
        <rect x="3.5" y="13.5" width="17" height="6" rx="1.6" />
        <path d="M7.5 7.5h.01M7.5 16.5h.01" />
      </svg>
    )
  if (name === 'sliders')
    return (
      <svg {...p}>
        <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
        <circle cx="16" cy="7" r="2" />
        <circle cx="10" cy="17" r="2" />
      </svg>
    )
  return (
    <svg {...p}>
      <path d="M12 4l1.6 4.9L18.5 11l-4.9 1.6L12 17.5l-1.6-4.9L5.5 11l4.9-2.1z" />
    </svg>
  )
}

export interface ModelSelectProps {
  value: string
  onChange: (id: string) => void
  models: ModelConfig[]
  disabled?: boolean
  /** 触发器类名：field 形态沿用调用方原有的输入框样式 */
  className?: string
  /** 提供时，列表顶部多一项「空值」（如「使用默认模型」） */
  placeholder?: string
  /** field：表单里的输入框形态；pill：输入区工具条里的紧凑胶囊 */
  variant?: 'field' | 'pill'
  /** 开启后 Ctrl+T 在当前页循环切换思考强度（只给主对话页用，避免多处同时响应） */
  hotkey?: boolean
  /** 空值实际落到哪个模型（如「本书默认」= 本书的 modelId）；不传则按全局默认模型回落 */
  fallbackId?: string
}

interface Pos {
  left: number
  top?: number
  bottom?: number
  width: number
  maxHeight: number
}
export default function ModelSelect({
  value,
  onChange,
  models,
  disabled,
  className,
  placeholder,
  variant = 'field',
  hotkey = false,
  fallbackId
}: ModelSelectProps) {
  const navigate = useNavigate()
  const btnRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const stationRef = useRef<HTMLButtonElement>(null)
  const subRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<Pos | null>(null)
  const [subOpen, setSubOpen] = useState(false)
  const [subPos, setSubPos] = useState<{ left: number; top: number } | null>(null)
  // 面板里正在浏览的中转站（与当前选中模型所在站点可以不同：先看看别家有哪些模型）
  const [viewKey, setViewKey] = useState('')
  // 拖动滑杆时先改本地显示，停手 320ms 后才落盘，避免一次拖动连发多笔整表写入
  const [pendingLevel, setPendingLevel] = useState<string | null>(null)
  const saveTimer = useRef<number | undefined>(undefined)
  const leaveTimer = useRef<number | undefined>(undefined)
  const saveSeq = useRef(0)
  const focusOnOpen = useRef(false)

  const groups = groupOfModels(models)
  const current = models.find(m => m.id === value) || null
  // 空值时后端按「默认模型 → 第一个」回落（server/models.mjs 的 resolveConn），思考强度就作用在它身上
  const effective =
    current ||
    (value
      ? null
      : (fallbackId && models.find(m => m.id === fallbackId)) || models.find(m => m.isDefault) || models[0] || null)
  // 实际生效模型所在的站点：打开面板时先看它，子菜单的勾也打在它上面
  const currentKey = groups.find(g => g.models.some(m => m.id === effective?.id))?.key || ''
  const viewGroup = groups.find(g => g.key === viewKey) || groups.find(g => g.key === currentKey) || groups[0]
  const labels = stationLabels(groups)
  const steps = thinkingSteps(effective)
  const level = pendingLevel ?? thinkingValue(effective)
  const levelIndex = Math.max(
    0,
    steps.findIndex(s => s.value === level)
  )
  const levelLabel = thinkingLabelOf(effective, level)

  const place = useCallback(() => {
    const el = btnRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    const width = Math.min(Math.max(300, variant === 'field' ? r.width : 0), 380, vw - 16)
    const below = vh - r.bottom - 12
    const above = r.top - 12
    const up = below < 360 && above > below
    const maxHeight = Math.max(220, Math.min(520, up ? above : below))
    let left = variant === 'pill' || r.left + width > vw - 8 ? r.right - width : r.left
    left = Math.min(Math.max(8, left), Math.max(8, vw - width - 8))
    setPos(up ? { left, bottom: vh - r.top + 8, width, maxHeight } : { left, top: r.bottom + 8, width, maxHeight })
  }, [variant])

  const close = useCallback((focusBack = false) => {
    setOpen(false)
    setSubOpen(false)
    if (focusBack) btnRef.current?.focus()
  }, [])

  const openPanel = () => {
    if (disabled) return
    setViewKey(currentKey)
    focusOnOpen.current = true
    setOpen(true)
  }

  useLayoutEffect(() => {
    if (open) place()
  }, [open, place])

  // 子菜单贴着「中转站」那一行，右侧放不下就翻到左侧
  useLayoutEffect(() => {
    if (!open || !subOpen) return
    const row = stationRef.current?.getBoundingClientRect()
    const panel = panelRef.current?.getBoundingClientRect()
    if (!row || !panel) return
    const subWidth = 248
    const right = panel.right + 6
    const left = right + subWidth > window.innerWidth - 8 ? Math.max(8, panel.left - subWidth - 6) : right
    const top = Math.min(row.top - 6, window.innerHeight - 8 - Math.min(320, groups.length * 40 + 16))
    setSubPos({ left, top: Math.max(8, top) })
  }, [open, subOpen, pos, groups.length])

  // 打开时把焦点放到当前模型那一行（键盘用户可以直接上下选）
  useEffect(() => {
    if (!open || !focusOnOpen.current) return
    focusOnOpen.current = false
    const panel = panelRef.current
    const target =
      panel?.querySelector<HTMLElement>('.mp-model[aria-current="true"]') ||
      panel?.querySelector<HTMLElement>('.mp-model')
    target?.focus({ preventScroll: true })
    target?.scrollIntoView({ block: 'nearest' })
  }, [open])

  useEffect(() => {
    if (!open) return
    const onScroll = (e: Event) => {
      const t = e.target as Node
      if (panelRef.current?.contains(t) || subRef.current?.contains(t)) return
      place()
    }
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (panelRef.current?.contains(t) || subRef.current?.contains(t) || btnRef.current?.contains(t)) return
      close(false)
    }
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', place)
    document.addEventListener('pointerdown', onDown, true)
    return () => {
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', place)
      document.removeEventListener('pointerdown', onDown, true)
    }
  }, [open, place, close])

  useEffect(() => {
    if (disabled && open) close(false)
  }, [disabled, open, close])
  // 思考强度是模型自身的配置（与「模型设置」里的分段按钮同一个字段），改这里等于改那里
  const commitLevel = async (m: ModelConfig, next: string) => {
    const seq = ++saveSeq.current
    try {
      const saved = await api.updateModel(m.id, withThinking(m, next))
      broadcastModelUpdate({ ...m, ...saved })
    } catch (e) {
      toast.error(`思考强度保存失败：${(e as Error).message}`)
    } finally {
      if (seq === saveSeq.current) setPendingLevel(null)
    }
  }

  const flushRef = useRef<(() => void) | null>(null)
  const setLevel = (next: string, announce = false) => {
    const m = effective
    if (!m || next === level) return
    setPendingLevel(next)
    window.clearTimeout(saveTimer.current)
    flushRef.current = () => {
      flushRef.current = null
      void commitLevel(m, next)
    }
    saveTimer.current = window.setTimeout(() => flushRef.current?.(), 320)
    if (announce) toast(`思考强度：${thinkingLabelOf(m, next)}`)
  }

  // 卸载时还没落盘的改动立刻补存，不因为切页而丢
  useEffect(
    () => () => {
      window.clearTimeout(saveTimer.current)
      window.clearTimeout(leaveTimer.current)
      flushRef.current?.()
    },
    []
  )

  const cycleRef = useRef<() => void>(() => {})
  cycleRef.current = () => {
    if (!effective) toast('请先选择模型')
    else if (!steps.length) toast('本地模型不支持调节思考强度')
    else setLevel(steps[(levelIndex + 1) % steps.length].value, true)
  }
  useEffect(() => {
    if (!hotkey) return
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 't') return
      e.preventDefault()
      cycleRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [hotkey])

  const pick = (id: string) => {
    if (id !== value) onChange(id)
    close(true)
  }

  const openSub = () => {
    window.clearTimeout(leaveTimer.current)
    if (groups.length > 1) setSubOpen(true)
  }
  // 鼠标从「中转站」斜着移向子菜单时会擦过下面的模型列表，给 180ms 宽限再收起
  const leaveSub = () => {
    window.clearTimeout(leaveTimer.current)
    leaveTimer.current = window.setTimeout(() => setSubOpen(false), 180)
  }

  const rows = (root: HTMLElement | null) =>
    root
      ? [...root.querySelectorAll<HTMLElement>('button:not([disabled]):not([tabindex="-1"]), input[type="range"]')]
      : []

  const focusFirstSub = () =>
    requestAnimationFrame(() => {
      const sub = subRef.current
      ;(
        sub?.querySelector<HTMLElement>('.mp-sub-item.is-viewing') || sub?.querySelector<HTMLElement>('.mp-sub-item')
      )?.focus()
    })

  const onPanelKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close(true)
      return
    }
    if (e.key === 'Tab') {
      close(false)
      return
    }
    const t = e.target as HTMLElement
    if (t === stationRef.current && e.key === 'ArrowRight') {
      e.preventDefault()
      openSub()
      focusFirstSub()
      return
    }
    // 滑杆自己吃方向键（调档），这里不抢
    if (t.tagName === 'INPUT') return
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const list = rows(panelRef.current)
    const i = list.indexOf(t)
    const next = list[(i + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length]
    next?.focus()
  }

  const onSubKey = (e: React.KeyboardEvent) => {
    const list = [...(subRef.current?.querySelectorAll<HTMLElement>('.mp-sub-item') || [])]
    const i = list.indexOf(e.target as HTMLElement)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      list[(i + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length]?.focus()
    } else if (e.key === 'ArrowLeft' || e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      setSubOpen(false)
      stationRef.current?.focus()
    } else if (e.key === 'Tab') {
      close(false)
    }
  }

  // 焦点离开整个选择器（面板、子菜单、触发器）时收起
  const onBlurOut = (e: React.FocusEvent) => {
    const t = e.relatedTarget as Node | null
    if (!t) return
    if (panelRef.current?.contains(t) || subRef.current?.contains(t) || btnRef.current?.contains(t)) return
    close(false)
  }
  const panelStyle: CSSProperties | undefined = pos
    ? { left: pos.left, top: pos.top, bottom: pos.bottom, width: pos.width, maxHeight: pos.maxHeight }
    : undefined
  const fill = steps.length > 1 ? (levelIndex / (steps.length - 1)) * 100 : 0
  // 胶囊形态直接显示实际会用到的模型；表单里保留「使用默认模型」这类占位文案，语义更清楚
  const shown = variant === 'pill' ? effective : current
  const triggerText = shown ? shown.name : (placeholder ?? '选择模型')

  return (
    <>
      <button
        type="button"
        ref={btnRef}
        className={`menu-select-trigger mp-trigger mp-trigger--${variant} ${className || ''}`}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`选择模型：${triggerText}${levelLabel ? `，思考强度${levelLabel}` : ''}`}
        title={
          effective
            ? `${current ? '' : '默认 · '}${effective.name}${effective.model && effective.model !== effective.name ? ` · ${effective.model}` : ''}`
            : undefined
        }
        onClick={() => (open ? close(false) : openPanel())}
        onKeyDown={e => {
          if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            e.preventDefault()
            openPanel()
          }
        }}
      >
        {variant === 'pill' && (
          <span className="mp-trigger-mark">
            <PIcon name="spark" size={12} />
          </span>
        )}
        <span className={`menu-select-value mp-trigger-name${shown ? '' : ' is-empty'}`}>{triggerText}</span>
        {/* 表单里还没选模型时只显示占位文案，档位徽标跟着具体模型走 */}
        {levelLabel && shown && (
          <span className="mp-trigger-level">{variant === 'pill' ? levelLabel : `思考 ${levelLabel}`}</span>
        )}
        <span className="menu-select-chevron mp-trigger-chevron">
          <PIcon name="down" size={12} />
        </span>
      </button>

      {/* 面板与子菜单 portal 到 body：fixed 按视口坐标定位，若留在页面 DOM 里，
          container-type / 入场动画保留的 transform 祖先会把它顶偏（Chromium 126 实证） */}
      {open &&
        createPortal(
          <div
            ref={panelRef}
            role="dialog"
            aria-label="选择模型"
            className="mp-panel"
            style={panelStyle}
            onKeyDown={onPanelKey}
            onBlur={onBlurOut}
          >
            <button
              type="button"
              ref={stationRef}
              className={`mp-station${subOpen ? ' is-open' : ''}${groups.length > 1 ? '' : ' is-single'}`}
              aria-haspopup={groups.length > 1 ? 'menu' : undefined}
              aria-expanded={groups.length > 1 ? subOpen : undefined}
              onPointerEnter={openSub}
              onPointerLeave={leaveSub}
              onClick={e => {
                if (groups.length < 2) return
                openSub()
                if (e.detail === 0) focusFirstSub()
              }}
            >
              <span className="mp-station-icon">
                <PIcon name="station" size={15} />
              </span>
              <span className="mp-station-text">
                <small>中转站</small>
                <b>{viewGroup ? labels.get(viewGroup.key) : '尚未配置'}</b>
              </span>
              {viewGroup && (
                <span className={`mp-badge mp-badge--${stationBadge(viewGroup).tone}`}>
                  {stationBadge(viewGroup).text}
                </span>
              )}
              {groups.length > 1 && (
                <span className="mp-station-chev">
                  <PIcon name="chevron" size={13} />
                </span>
              )}
            </button>

            <div className="mp-section-head">
              <span>模型</span>
              {viewGroup && <small>{viewGroup.models.length} 个</small>}
            </div>
            <div className="mp-list" onPointerEnter={leaveSub}>
              {placeholder !== undefined && (
                <button
                  type="button"
                  className="mp-model mp-model--muted"
                  aria-current={!value ? 'true' : undefined}
                  onClick={() => pick('')}
                >
                  <span className="mp-model-main">
                    <span className="mp-model-name">{placeholder}</span>
                  </span>
                  <span className="mp-check">{!value && <PIcon name="check" size={14} />}</span>
                </button>
              )}
              {viewGroup?.models.map(m => {
                const on = m.id === value
                return (
                  <button
                    type="button"
                    key={m.id}
                    className={`mp-model${on ? ' is-selected' : ''}`}
                    aria-current={on ? 'true' : undefined}
                    onClick={() => pick(m.id)}
                  >
                    <span className="mp-model-main">
                      <span className="mp-model-name">{m.name}</span>
                      {m.model && m.model !== m.name && <span className="mp-model-id">{m.model}</span>}
                    </span>
                    <span className="mp-model-badges">
                      {m.isDefault && <span className="mp-badge mp-badge--gold">默认</span>}
                      {m.local && <span className="mp-badge mp-badge--local">本地</span>}
                      {m.local && fmtContext(m.contextTokens) && (
                        <span className="mp-badge">{fmtContext(m.contextTokens)}</span>
                      )}
                    </span>
                    <span className="mp-check">{on && <PIcon name="check" size={14} />}</span>
                  </button>
                )
              })}
              {!groups.length && <p className="mp-empty">还没有可用的模型，先到「模型设置」添加一个。</p>}
            </div>
            <div className="mp-think">
              <div className="mp-think-head">
                <span className="mp-think-title">
                  <PIcon name="spark" size={13} />
                  思考强度
                </span>
                {hotkey && (
                  <span className="mp-think-keys" aria-hidden="true">
                    <kbd className="ink-kbd">Ctrl</kbd>
                    <kbd className="ink-kbd">T</kbd>
                  </span>
                )}
                <b className="mp-think-value">{steps.length ? levelLabel : '—'}</b>
              </div>
              {steps.length > 0 ? (
                <>
                  <input
                    type="range"
                    className="mp-range"
                    min={0}
                    max={steps.length - 1}
                    step={1}
                    value={levelIndex}
                    aria-label="思考强度"
                    aria-valuetext={levelLabel}
                    style={{ '--mp-fill': `${fill}%` } as CSSProperties}
                    onChange={e => setLevel(steps[Number(e.target.value)]?.value || level)}
                  />
                  <div className="mp-ticks" aria-hidden="true">
                    {steps.map((s, i) => (
                      <button
                        type="button"
                        tabIndex={-1}
                        key={s.value}
                        className={i === levelIndex ? 'is-on' : ''}
                        style={{ left: `${steps.length > 1 ? (i / (steps.length - 1)) * 100 : 0}%` }}
                        onClick={() => setLevel(s.value)}
                      >
                        {s.label}
                      </button>
                    ))}
                  </div>
                  <p className="mp-think-note">
                    {!current && effective ? `作用于「${effective.name}」，` : ''}
                    {effective?.provider === 'gemini' ? '档位越高想得越久' : '「自动」由服务商决定'}
                    ，随模型保存，各处同步生效。
                  </p>
                </>
              ) : (
                <p className="mp-think-note">
                  {effective ? '本地部署的模型不接收思考参数。' : '先选择一个模型，再调整思考强度。'}
                </p>
              )}
            </div>

            <button
              type="button"
              className="mp-manage"
              onClick={() => {
                close(false)
                navigate('/settings')
              }}
            >
              <PIcon name="sliders" size={15} />
              <span>管理模型</span>
              <PIcon name="chevron" size={13} />
            </button>
          </div>,
          document.body
        )}

      {open &&
        subOpen &&
        groups.length > 1 &&
        createPortal(
          <div
            ref={subRef}
            role="menu"
            aria-label="中转站"
            className="mp-sub"
            style={subPos ? { left: subPos.left, top: subPos.top } : { visibility: 'hidden' }}
            onPointerEnter={() => window.clearTimeout(leaveTimer.current)}
            onPointerLeave={leaveSub}
            onKeyDown={onSubKey}
            onBlur={onBlurOut}
          >
            {groups.map(g => {
              const badge = stationBadge(g)
              return (
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={g.key === currentKey}
                  key={g.key}
                  className={`mp-sub-item${g.key === viewGroup?.key ? ' is-viewing' : ''}`}
                  onPointerEnter={() => setViewKey(g.key)}
                  onFocus={() => setViewKey(g.key)}
                  onClick={() => {
                    setViewKey(g.key)
                    setSubOpen(false)
                    // 等列表换成这个站点的模型后再落焦点
                    requestAnimationFrame(() =>
                      panelRef.current?.querySelector<HTMLElement>('.mp-model:not(.mp-model--muted)')?.focus()
                    )
                  }}
                >
                  <span className="mp-sub-name">{labels.get(g.key)}</span>
                  <span className={`mp-badge mp-badge--${badge.tone}`}>{badge.text}</span>
                  <small>{g.models.length}</small>
                  <span className="mp-check">{g.key === currentKey && <PIcon name="check" size={13} />}</span>
                </button>
              )
            })}
          </div>,
          document.body
        )}
    </>
  )
}
