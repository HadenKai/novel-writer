import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import '../pages/collab.css'
import type { ReactNode } from 'react'

export interface QuickPrompt {
  label: string
  text: string
  icon?: string
}

export interface ComposerProps {
  value: string
  onChange: (v: string) => void
  /** 传 text 表示直接发送该文本（快捷指令），不传则发送输入框当前内容 */
  onSend: (text?: string) => void
  onStop?: () => void
  running?: boolean
  disabled?: boolean
  /** 仅阻止发送，保留草稿编辑（例如尚未配置模型） */
  sendDisabled?: boolean
  hasAttachments?: boolean
  /** 单行占位符 */
  placeholder?: string
  quickPrompts?: QuickPrompt[]
  /** 输入区左下角自定义内容（如附选段入口、代改开关） */
  toolbar?: ReactNode
  /** ＋ 号的回调：点击展开/收起附加面板（如「附选段」）。不传则 ＋ 显示为不可点击 */
  onPlus?: () => void
  /** ＋ 号的悬浮提示 */
  plusTitle?: string
  /** 附件面板当前是否展开，展开时 ＋ 高亮 */
  plusActive?: boolean
  /** 发送钮左侧的自定义内容（通常是模型选择器） */
  modelSlot?: ReactNode
  /** 右下角提示文案，如「Enter 发送 · Shift+Enter 换行」 */
  hint?: string
  /** 输入框与工具条之间的内容（如随消息发送的附件缩略图） */
  topSlot?: ReactNode
  /** 提供 时 ＋ 变成下拉菜单入口（插入图片 / 附加文档 / 附选段） */
  plusMenu?: { label: string; onSelect: () => void }[]
  /** 回复进行中按 Enter：把输入排进队列，等本轮结束后自动发出 */
  onQueue?: (text: string) => void
  /** 输入框上方的内容（如排队中的消息） */
  aboveSlot?: ReactNode
}

/* 小尺寸线性图标（14px 栅格，1.8 描边） */
function CIcon({ name, size = 14 }: { name: string; size?: number }) {
  const p = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.9,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const
  }
  switch (name) {
    case 'plus':
      return (
        <svg {...p}>
          <path d="M12 5v14M5 12h14" />
        </svg>
      )
    case 'arrow-up':
      return (
        <svg {...p}>
          <path d="M12 19V5M6 11l6-6 6 6" />
        </svg>
      )
    case 'stop':
      return (
        <svg {...p}>
          <rect x="6.5" y="6.5" width="11" height="11" rx="1.6" fill="currentColor" stroke="none" />
        </svg>
      )
    case 'route':
      return (
        <svg {...p}>
          <circle cx="6" cy="18" r="2.4" />
          <circle cx="18" cy="6" r="2.4" />
          <path d="M8.4 18H15a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h6.6" />
        </svg>
      )
    case 'zap':
      return (
        <svg {...p}>
          <path d="M13 3 4.5 13.5H11L10.5 21 19 10.5h-6.5z" />
        </svg>
      )
    case 'pulse':
      return (
        <svg {...p}>
          <path d="M3 12h4l2.5-6 4 12L16 12h5" />
        </svg>
      )
    case 'check':
      return (
        <svg {...p}>
          <path d="M4 12.5l5 5L20 6.5" />
        </svg>
      )
    case 'branch':
      return (
        <svg {...p}>
          <circle cx="6.5" cy="5.5" r="2.2" />
          <circle cx="6.5" cy="18.5" r="2.2" />
          <circle cx="17" cy="8" r="2.2" />
          <path d="M6.5 7.7v8.6M8.7 6h4.8a3.5 3.5 0 0 1 3.5 3.5" />
        </svg>
      )
    case 'eraser':
      return (
        <svg {...p}>
          <path d="M16.5 4.5l3 3a2 2 0 0 1 0 2.8L10.8 19H4.5l-1.2-1.2a2 2 0 0 1 0-2.8l10.4-10.5a2 2 0 0 1 2.8 0Z" />
          <path d="M8.5 14.5l5-5" />
        </svg>
      )
    case 'sparkle':
      return (
        <svg {...p}>
          <path d="M12 4l1.6 4.9L18.5 11l-4.9 1.6L12 17.5l-1.6-4.9L5.5 11l4.9-2.1z" />
        </svg>
      )
    default:
      return (
        <svg {...p}>
          <path d="M12 4l1.6 4.9L18.5 11l-4.9 1.6L12 17.5l-1.6-4.9L5.5 11l4.9-2.1z" />
        </svg>
      )
  }
}

/**
 * 一体化输入区（composer）
 * 视觉：大圆角白卡 + 细描边；左下能力开关 / 右下模型 + 方形发送钮；卡下快捷指令
 * 交互：Enter 发送、Shift+Enter 换行；生成中切换为「停止」
 */
export default function Composer({
  value,
  onChange,
  onSend,
  onStop,
  running = false,
  disabled = false,
  sendDisabled = false,
  hasAttachments = false,
  placeholder,
  quickPrompts,
  toolbar,
  modelSlot,
  hint,
  onPlus,
  plusTitle,
  plusActive = false,
  topSlot,
  plusMenu,
  onQueue,
  aboveSlot
}: ComposerProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const inputId = useId()
  const menuButtonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLSpanElement>(null)
  const ph = placeholder ?? '描述你的问题或写作要求…'
  const canSend = !running && !disabled && !sendDisabled && (value.trim().length > 0 || hasAttachments)
  const canQueue = running && !!onQueue && !disabled && value.trim().length > 0
  const queue = () => {
    if (!canQueue) return
    onQueue?.(value.trim())
    onChange('')
  }

  // 输入框随内容增高：最少 1 行，最多 240px，超出后框内滚动
  const taRef = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const el = taRef.current
    if (!el) return
    const MAX = 240
    el.style.height = 'auto'
    const next = Math.min(el.scrollHeight, MAX)
    el.style.height = `${next}px`
    el.style.overflowY = el.scrollHeight > MAX ? 'auto' : 'hidden'
  }, [value])

  // 点外面关菜单：不用 fixed 遮罩——container-type 祖先会把它限制在内容区里，
  // 点会话栏 / 工具条就关不掉；document 级监听不受包含块影响
  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (menuRef.current?.contains(t) || menuButtonRef.current?.contains(t)) return
      setMenuOpen(false)
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [menuOpen])

  return (
    <div
      className="collab-composer shrink-0 px-3 pb-4 pt-2 sm:px-6"
      onKeyDown={e => {
        if (e.key === 'Escape' && menuOpen) {
          setMenuOpen(false)
          menuButtonRef.current?.focus()
        }
      }}
    >
      <div className="mx-auto max-w-[760px]">
        {aboveSlot}
        <div className="collab-input-shell">
          <label htmlFor={inputId} className="collab-input-label">
            消息
          </label>
          <textarea
            id={inputId}
            aria-describedby={hint ? `${inputId}-hint` : undefined}
            ref={taRef}
            value={value}
            onChange={e => onChange(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                if (canSend) onSend()
                else if (canQueue) queue()
              }
            }}
            rows={1}
            disabled={disabled}
            placeholder={ph}
            className="reader-scroll block w-full resize-none border-0 bg-transparent px-4 pb-1 pt-3.5 text-[13px] leading-[1.8] text-[var(--text)] outline-none placeholder:text-[var(--text-faint)] disabled:opacity-50"
          />

          {topSlot}

          <div className="collab-composer-tools flex flex-wrap items-center justify-between gap-2 px-2.5 pb-2.5 pt-1">
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              {plusMenu?.length ? (
                <span className="relative">
                  <button
                    type="button"
                    ref={menuButtonRef}
                    disabled={disabled}
                    aria-expanded={menuOpen}
                    aria-controls={`${inputId}-tools`}
                    onClick={() => setMenuOpen(v => !v)}
                    title={plusTitle || '添加附件'}
                    aria-label={plusTitle || '添加附件'}
                    className={`collab-tool-button flex h-8 shrink-0 cursor-pointer items-center justify-center gap-1 rounded-[9px] px-2 transition-colors ${
                      menuOpen
                        ? 'bg-[color-mix(in_srgb,var(--gold)_12%,var(--panel))] text-[var(--gold)]'
                        : 'text-[var(--text-faint)] hover:bg-[var(--panel2)] hover:text-[var(--text-dim)]'
                    }`}
                  >
                    <CIcon name="plus" size={15} />
                    <span>添加</span>
                  </button>
                  {menuOpen && (
                    <>
                      <span
                        ref={menuRef}
                        id={`${inputId}-tools`}
                        className="collab-tool-menu absolute bottom-10 left-0 z-30 block w-[248px] rounded-[12px] border border-[var(--line)] bg-[var(--panel)] p-1 shadow-[var(--sh-3)]"
                      >
                        {plusMenu.map(item => (
                          <button
                            key={item.label}
                            type="button"
                            onClick={() => {
                              setMenuOpen(false)
                              item.onSelect()
                            }}
                            className="block w-full truncate rounded-[9px] px-2.5 py-2 text-left text-[12px] text-[var(--text-dim)] transition hover:bg-[var(--panel2)] hover:text-[var(--text)]"
                          >
                            {item.label}
                          </button>
                        ))}
                      </span>
                    </>
                  )}
                </span>
              ) : onPlus ? (
                <button
                  type="button"
                  onClick={onPlus}
                  disabled={disabled}
                  aria-expanded={plusActive}
                  aria-label={plusTitle || '展开更多选项'}
                  title={plusTitle || '展开更多选项'}
                  className={`collab-tool-button flex h-8 shrink-0 cursor-pointer items-center justify-center gap-1 rounded-[9px] px-2 transition-colors ${
                    plusActive
                      ? 'bg-[color-mix(in_srgb,var(--gold)_12%,var(--panel))] text-[var(--gold)]'
                      : 'text-[var(--text-faint)] hover:bg-[var(--panel2)] hover:text-[var(--text-dim)]'
                  }`}
                >
                  <CIcon name="plus" size={15} />
                  <span>添加</span>
                </button>
              ) : null}
              {toolbar}
            </div>
            <div className="collab-send-tools flex min-w-0 flex-wrap items-center gap-1.5">
              {modelSlot}
              {hint && (
                <span id={`${inputId}-hint`} className="collab-key-hint">
                  {hint}
                </span>
              )}
              {running ? (
                <>
                  {canQueue && (
                    <button
                      type="button"
                      onClick={queue}
                      title="排队发送（Enter）：本轮回复结束后自动发出"
                      aria-label="排队发送"
                      className="collab-queue-btn flex h-8 items-center gap-1 px-2.5 text-[12px] transition-colors"
                    >
                      <CIcon name="route" size={13} />
                      排队
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={onStop}
                    title="停止生成"
                    aria-label="停止生成"
                    disabled={!onStop}
                    className="collab-round collab-round--stop"
                  >
                    <CIcon name="stop" size={13} />
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => onSend()}
                  disabled={!canSend}
                  title="发送（Enter）"
                  aria-label="发送消息"
                  className={`collab-round collab-round--send${canSend ? ' is-ready' : ''}`}
                >
                  <CIcon name="arrow-up" size={15} />
                </button>
              )}
            </div>
          </div>
        </div>

        {/* 卡下快捷指令：矩形描边 chip，点击即发送 */}
        {quickPrompts && quickPrompts.length > 0 && (
          <div className="mt-2.5 flex flex-wrap justify-center gap-2">
            {quickPrompts.map(q => (
              <button
                key={q.label}
                type="button"
                onClick={() => onSend(q.text)}
                disabled={running || disabled || sendDisabled}
                title={q.text}
                className="flex items-center gap-1.5 rounded-[9px] bg-[var(--panel2)]/60 px-3 py-1.5 text-[12px] text-[var(--text-dim)] transition-colors hover:bg-[color-mix(in_srgb,var(--gold)_8%,var(--panel))] hover:text-[var(--text)] disabled:opacity-40"
              >
                <CIcon name={q.icon || 'sparkle'} size={13} />
                {q.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
