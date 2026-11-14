import { useEffect, useRef, useState, useCallback, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/**
 * 应用内对话框：替代原生 confirm / alert。
 *
 * 为什么不用原生弹窗：Electron 里 window.confirm/alert 是系统级模态，
 * 会阻塞渲染进程事件循环（连滚动都停）、样式与产品割裂、且无法在
 * 深色主题下保持一致观感。这里给出一套 Promise 化的应用内对话框，
 * 调用方仍是直线写法：
 *
 *   const ok = await confirmDialog({ title: '删除会话', body: '…', danger: true })
 *   if (!ok) return
 *   await alertDialog({ title: '保存失败', body: e.message, tone: 'error' })
 *
 * 实现要点：
 * - 单实例宿主 DialogHost 挂在 App 根部；confirmDialog/alertDialog 通过
 *   模块级队列与宿主通信，任意组件可直接 import 调用。
 * - Esc / 点遮罩关闭，焦点自动落到确认按钮，打开时锁 body 滚动。
 * - 动效沿用 index.css 的 --ease 与既有 keyframes，reduced-motion 下自动禁用。
 */

export type DialogTone = 'info' | 'success' | 'warning' | 'error'

export interface DialogOptions {
  title?: ReactNode
  body?: ReactNode
  /** 确认按钮文案（confirm 默认「确定」，alert 默认「好」） */
  confirmText?: string
  /** 取消按钮文案，仅 confirm 使用 */
  cancelText?: string
  /** 危险操作：确认按钮与图标转为警示色 */
  danger?: boolean
  /** alert 的语气：控制图标与强调色 */
  tone?: DialogTone
}

interface PendingRequest extends DialogOptions {
  kind: 'confirm' | 'alert'
  id: number
  resolve: (v: boolean) => void
}

// 模块级队列：宿主尚未挂载或已有对话框在展示时，请求在此排队
const queue: PendingRequest[] = []
let seq = 0
let hostPush: ((req: PendingRequest) => void) | null = null

function enqueue(req: Omit<PendingRequest, 'resolve'>): Promise<boolean> {
  if (!hostPush) {
    // 宿主未挂载（极早期调用）：退化为原生弹窗，保证功能不丢
    const text = toPlainText(req.body, req.title)
    if (req.kind === 'confirm') return Promise.resolve(window.confirm(text))
    window.alert(text)
    return Promise.resolve(true)
  }
  return new Promise<boolean>(resolve => {
    hostPush!({ ...req, resolve })
  })
}

function toPlainText(body: ReactNode, title: ReactNode): string {
  const t = typeof title === 'string' ? title : ''
  const b = typeof body === 'string' ? body : ''
  return [t, b].filter(Boolean).join('\n\n')
}

/** 确认对话框，返回用户是否点了确认（Esc / 取消 / 点遮罩 → false） */
export function confirmDialog(opts: DialogOptions): Promise<boolean> {
  return enqueue({ kind: 'confirm', id: ++seq, ...opts })
}

/** 提示对话框（只有一个「好」按钮），恒返回 true，便于 await 串联 */
export function alertDialog(opts: DialogOptions): Promise<boolean> {
  return enqueue({ kind: 'alert', id: ++seq, ...opts })
}

const TONE_ICON: Record<DialogTone, string> = {
  info: 'info',
  success: 'check',
  warning: 'alert-triangle',
  error: 'alert-octagon'
}

const TONE_COLOR: Record<DialogTone, string> = {
  info: 'var(--gold)',
  success: 'var(--jade)',
  warning: 'var(--gold)',
  error: 'var(--seal)'
}

/** 对话框宿主：在 App 根部挂一次即可 */
export function DialogHost() {
  const [item, setItem] = useState<PendingRequest | null>(null)
  const confirmBtnRef = useRef<HTMLButtonElement | null>(null)
  // 当前展示项的镜像：排队/关闭的副作用必须放在 setState updater 之外——
  // StrictMode（main.tsx 已开启）在开发模式会双调用 updater，
  // updater 里 queue.shift()/queue.push() 会执行两次，排队的对话框被吞、永远不 resolve
  const itemRef = useRef<PendingRequest | null>(null)
  itemRef.current = item

  useEffect(() => {
    hostPush = req => {
      if (itemRef.current) {
        queue.push(req)
        return // 已在展示，排队等待
      }
      itemRef.current = req
      setItem(req)
    }
    return () => {
      hostPush = null
    }
  }, [])

  const close = useCallback((result: boolean) => {
    const cur = itemRef.current
    const next = queue.shift() || null
    itemRef.current = next
    cur?.resolve(result)
    setItem(next)
  }, [])

  // 每次换项后把焦点交给确认按钮
  useEffect(() => {
    if (item) confirmBtnRef.current?.focus()
  }, [item?.id, item])

  // 锁滚动 + 键盘：Esc 关闭；alert 额外支持 Enter 确认
  useEffect(() => {
    if (!item) return
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        close(item.kind === 'alert')
      } else if (e.key === 'Enter' && item.kind === 'alert') {
        e.preventDefault()
        close(true)
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.body.style.overflow = prevOverflow
      document.removeEventListener('keydown', onKey, true)
    }
  }, [item, close])

  if (!item) return null

  const isConfirm = item.kind === 'confirm'
  const tone: DialogTone = item.tone || (item.danger ? 'error' : 'info')
  const iconName = isConfirm && item.danger ? 'alert-triangle' : TONE_ICON[tone]
  const iconColor = isConfirm && item.danger ? TONE_COLOR.error : TONE_COLOR[tone]

  return createPortal(
    <div
      className="dlg-overlay"
      role="presentation"
      onMouseDown={e => {
        if (e.target === e.currentTarget) close(!isConfirm)
      }}
    >
      <div
        className="dlg"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={item.title ? `dlg-title-${item.id}` : undefined}
        aria-describedby={item.body ? `dlg-body-${item.id}` : undefined}
      >
        <div className="dlg__head">
          <span className="dlg__icon" style={{ color: iconColor }}>
            <ToneIcon name={iconName} />
          </span>
          {item.title ? (
            <h2 className="dlg__title" id={`dlg-title-${item.id}`}>
              {item.title}
            </h2>
          ) : null}
        </div>
        {item.body ? (
          <div className="dlg__body" id={`dlg-body-${item.id}`}>
            {item.body}
          </div>
        ) : null}
        <div className="dlg__foot">
          {isConfirm ? (
            <button type="button" className="btn btn--ghost btn--md" onClick={() => close(false)}>
              {item.cancelText || '取消'}
            </button>
          ) : null}
          <button
            ref={confirmBtnRef}
            type="button"
            className={`btn btn--md ${item.danger ? 'btn--danger-solid' : 'btn--primary'}`}
            onClick={() => close(true)}
          >
            {item.confirmText || (isConfirm ? '确定' : '好')}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

function ToneIcon({ name }: { name: string }) {
  const common = {
    width: 18,
    height: 18,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.7,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const
  }
  switch (name) {
    case 'check':
      return (
        <svg {...common}>
          <path d="M20 6 9 17l-5-5" />
        </svg>
      )
    case 'alert-triangle':
      return (
        <svg {...common}>
          <path d="M10.3 3.6 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.6a2 2 0 0 0-3.4 0Z" />
          <path d="M12 9v4" />
          <path d="M12 17h.01" />
        </svg>
      )
    case 'alert-octagon':
      return (
        <svg {...common}>
          <path d="M7.9 2h8.2L22 7.9v8.2L16.1 22H7.9L2 16.1V7.9Z" />
          <path d="M12 8v4" />
          <path d="M12 16h.01" />
        </svg>
      )
    default:
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 16v-4" />
          <path d="M12 8h.01" />
        </svg>
      )
  }
}
