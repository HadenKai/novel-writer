import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import './menu-select.css'

export interface MenuOption {
  value: string
  label: string
  /** 次要说明：面板里以淡色小字显示在标签右侧 */
  hint?: string
  /** 分组名；相同的相邻项会自动归到同一组 */
  group?: string
  disabled?: boolean
  /** 占位项（例如「请选择模型」）：弱化显示，不画选中点 */
  muted?: boolean
}

export interface MenuSelectProps {
  value: string
  onChange: (value: string) => void
  options: MenuOption[]
  disabled?: boolean
  /** 触发按钮的类名（沿用调用方原有的输入框样式） */
  className?: string
  ariaLabel?: string
  title?: string
  /** 面板宽度下限；实际宽度取 max(此值, 触发器宽度) */
  panelWidth?: number
  /** 面板相对触发器的对齐方式 */
  align?: 'left' | 'right'
  /** 没有选中项时触发器显示的文案 */
  emptyLabel?: string
}

interface PanelPos {
  left: number
  top?: number
  bottom?: number
  width: number
  maxHeight: number
}

/**
 * 自绘下拉菜单。
 *
 * 为什么不用原生 <select>：原生控件的下拉弹层由操作系统绘制，CSS 完全管不到，
 * 在暖纸墨色的界面里会突兀地弹出一个系统灰白列表框。这里改成按钮 + 浮层，
 * 弹层与页面同一套纸面语言，键盘与读屏行为按 listbox 规范实现。
 */
export default function MenuSelect({
  value,
  onChange,
  options,
  disabled,
  className,
  ariaLabel,
  title,
  panelWidth,
  align = 'left',
  emptyLabel = '请选择'
}: MenuSelectProps) {
  const listId = useId()
  const btnRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [pos, setPos] = useState<PanelPos | null>(null)

  const selectedIndex = options.findIndex(o => o.value === value)
  const current = selectedIndex >= 0 ? options[selectedIndex] : null

  const place = useCallback(() => {
    const el = btnRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const vh = window.innerHeight
    const vw = window.innerWidth
    const below = vh - r.bottom - 12
    const above = r.top - 12
    // 先估一个面板高度：装得下就往下开（与常规下拉一致），装不下才往上翻
    const estimated = Math.min(320, options.length * 30 + 24)
    const up = below < estimated && above > below
    const width = Math.max(panelWidth || 0, r.width, 176)
    const maxHeight = Math.max(132, Math.min(320, up ? above : below))
    // 靠近右边缘时改为右对齐，避免面板被视口截断
    let left = align === 'right' || r.left + width > vw - 8 ? r.right - width : r.left
    left = Math.min(Math.max(8, left), Math.max(8, vw - width - 8))
    setPos(up ? { left, bottom: vh - r.top + 6, width, maxHeight } : { left, top: r.bottom + 6, width, maxHeight })
  }, [align, panelWidth, options.length])

  const close = useCallback((focusBack = false) => {
    setOpen(false)
    if (focusBack) btnRef.current?.focus()
  }, [])

  const openMenu = useCallback(
    (fromIndex?: number) => {
      if (disabled) return
      setActive(fromIndex ?? (selectedIndex >= 0 ? selectedIndex : 0))
      setOpen(true)
    },
    [disabled, selectedIndex]
  )

  // 打开后按视口空间定位。面板 portal 到 body：container-type / 保留 transform 的祖先
  // （消息入场动画、容器查询布局）都会成为 fixed 的包含块，把按视口算的面板顶偏几百像素
  useLayoutEffect(() => {
    if (!open) return
    place()
  }, [open, place])

  // 打开期间跟随滚动与缩放重新定位
  useEffect(() => {
    if (!open) return
    const onChange = () => place()
    window.addEventListener('scroll', onChange, true)
    window.addEventListener('resize', onChange)
    return () => {
      window.removeEventListener('scroll', onChange, true)
      window.removeEventListener('resize', onChange)
    }
  }, [open, place])

  // 点击别处关闭
  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (panelRef.current?.contains(t) || btnRef.current?.contains(t)) return
      close(false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [open, close])

  // 打开时把当前项滚进可视区
  useEffect(() => {
    if (!open) return
    const node = panelRef.current?.querySelector<HTMLElement>(`#${CSS.escape(`${listId}-opt-${active}`)}`)
    node?.scrollIntoView({ block: 'nearest' })
  }, [open, active, listId])

  const move = (delta: number) => {
    if (!options.length) return
    let next = active
    for (let i = 0; i < options.length; i++) {
      next = (next + delta + options.length) % options.length
      if (!options[next].disabled) break
    }
    setActive(next)
  }

  const commit = (index: number) => {
    const opt = options[index]
    if (!opt || opt.disabled) return
    onChange(opt.value)
    close(true)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        if (!open) openMenu()
        else move(1)
        return
      case 'ArrowUp':
        e.preventDefault()
        if (!open) openMenu()
        else move(-1)
        return
      case 'Home':
        if (!open) return
        e.preventDefault()
        setActive(0)
        return
      case 'End':
        if (!open) return
        e.preventDefault()
        setActive(options.length - 1)
        return
      case 'Enter':
      case ' ':
        e.preventDefault()
        if (!open) openMenu()
        else commit(active)
        return
      case 'Escape':
        if (!open) return
        e.preventDefault()
        close(true)
        return
      case 'Tab':
        close(false)
        return
      default:
    }
  }

  const panelStyle: CSSProperties | undefined = pos
    ? {
        left: pos.left,
        top: pos.top,
        bottom: pos.bottom,
        width: pos.width,
        maxHeight: pos.maxHeight
      }
    : undefined

  let lastGroup: string | undefined
  return (
    <>
      <button
        type="button"
        ref={btnRef}
        className={`menu-select-trigger ${className || ''}`}
        disabled={disabled}
        title={title}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? `${listId}-opt-${active}` : undefined}
        onClick={() => (open ? close(false) : openMenu())}
        onKeyDown={onKeyDown}
      >
        <span className="menu-select-value">{current ? current.label : emptyLabel}</span>
        <svg className="menu-select-chevron" width="10" height="10" viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M6 9l6 6 6-6"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {open &&
        createPortal(
          <div
            ref={panelRef}
            id={listId}
            role="listbox"
            aria-label={ariaLabel}
            className="menu-select-panel"
            style={panelStyle}
          >
            {options.length === 0 ? (
              <p className="menu-select-empty">暂无可选项</p>
            ) : (
              options.map((o, i) => {
                const showGroup = o.group !== undefined && o.group !== lastGroup
                lastGroup = o.group
                return (
                  <div key={o.value || `idx-${i}`}>
                    {showGroup && <p className="menu-select-group">{o.group}</p>}
                    <div
                      id={`${listId}-opt-${i}`}
                      role="option"
                      aria-selected={o.value === value}
                      aria-disabled={o.disabled || undefined}
                      className={`menu-select-option${o.value === value && !o.muted ? ' is-selected' : ''}${
                        i === active ? ' is-active' : ''
                      }${o.disabled ? ' is-disabled' : ''}${o.muted ? ' is-muted' : ''}`}
                      onPointerEnter={() => !o.disabled && setActive(i)}
                      onClick={() => commit(i)}
                    >
                      <span className="menu-select-dot" aria-hidden="true" />
                      <span className="menu-select-option-label">{o.label}</span>
                      {o.hint && <span className="menu-select-hint">{o.hint}</span>}
                    </div>
                  </div>
                )
              })
            )}
          </div>,
          document.body
        )}
    </>
  )
}
