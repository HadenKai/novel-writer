import { useCallback, useId, useLayoutEffect, useRef, useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

type ModalEntry = { id: symbol; panel: HTMLDivElement | null }

// ModalShell 实例按打开顺序登记。Escape / Tab 只由当前最上层的实例处理。
const modalStack: ModalEntry[] = []

function isVisible(element: Element) {
  if (!(element instanceof HTMLElement)) return false
  if (element.getAttribute('aria-hidden') === 'true') return false
  const style = window.getComputedStyle(element)
  return style.display !== 'none' && style.visibility !== 'hidden'
}

function hasHigherDialog(panel: HTMLDivElement | null) {
  if (!panel) return false
  const layers = [...document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"]')].filter(isVisible)
  return layers.some((layer, index) => layer === panel && layers.slice(index + 1).length > 0)
}

function getFocusable(panel: HTMLDivElement) {
  return [
    ...panel.querySelectorAll<HTMLElement>(
      'a[href], area[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), iframe, object, embed, [contenteditable="true"], [tabindex]:not([tabindex="-1"])'
    )
  ].filter(element => isVisible(element) && !element.hasAttribute('aria-hidden'))
}

/**
 * 轻量模态壳：统一 workspace / butler 下若干「AI 规划」「导入」「分析」弹窗的
 * 遮罩、面板、标题行、分隔线，以及无障碍语义。
 *
 * 弹窗用 portal 挂到 body，支持嵌套弹窗。最上层实例独占 Escape、Tab 和焦点，
 * 关闭时焦点回到打开它的控件；busy 时遮罩、Escape、关闭按钮均不可关闭。
 */
export default function ModalShell({
  title,
  width = 640,
  onClose,
  busy = false,
  maxHeight = '86vh',
  children
}: {
  title: ReactNode
  width?: number
  onClose: () => void
  busy?: boolean
  maxHeight?: string
  children: ReactNode
}) {
  const panelRef = useRef<HTMLDivElement | null>(null)
  const entryRef = useRef<ModalEntry>({ id: Symbol('modal'), panel: null })
  const openerRef = useRef<HTMLElement | null>(null)
  const closeRef = useRef(onClose)
  const busyRef = useRef(busy)
  const titleId = useId()

  closeRef.current = onClose
  busyRef.current = busy

  const isTopLayer = useCallback(() => {
    return modalStack[modalStack.length - 1] === entryRef.current && !hasHigherDialog(panelRef.current)
  }, [])

  const tryClose = useCallback(() => {
    if (!busyRef.current && isTopLayer()) closeRef.current()
  }, [isTopLayer])

  useLayoutEffect(() => {
    const entry = entryRef.current
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    openerRef.current = previous
    entry.panel = panelRef.current
    modalStack.push(entry)

    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    panelRef.current?.focus({ preventScroll: true })

    return () => {
      const index = modalStack.indexOf(entry)
      if (index >= 0) modalStack.splice(index, 1)
      document.body.style.overflow = previousOverflow

      const opener = openerRef.current
      if (opener?.isConnected && !opener.hasAttribute('disabled')) {
        opener.focus({ preventScroll: true })
      }
    }
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isTopLayer()) return

      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopImmediatePropagation()
        if (!busyRef.current) closeRef.current()
        return
      }

      if (event.key !== 'Tab') return
      const panel = panelRef.current
      if (!panel) return
      const focusable = getFocusable(panel)
      event.preventDefault()
      event.stopImmediatePropagation()
      if (focusable.length === 0) {
        panel.focus({ preventScroll: true })
        return
      }

      const active = document.activeElement
      const currentIndex = focusable.indexOf(active as HTMLElement)
      const nextIndex = event.shiftKey
        ? currentIndex <= 0
          ? focusable.length - 1
          : currentIndex - 1
        : currentIndex < 0 || currentIndex === focusable.length - 1
          ? 0
          : currentIndex + 1
      focusable[nextIndex].focus({ preventScroll: true })
    }

    const onFocusIn = (event: FocusEvent) => {
      if (!isTopLayer()) return
      const panel = panelRef.current
      const target = event.target
      if (!panel || !(target instanceof Node) || panel.contains(target)) return
      event.stopImmediatePropagation()
      const focusable = getFocusable(panel)
      ;(focusable[0] || panel).focus({ preventScroll: true })
    }

    // window 捕获阶段早于 DialogHost 的 document 捕获监听，保证上层 ModalShell
    // 打开时不会被底层宿主先截走 Escape / Tab。
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('focusin', onFocusIn, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('focusin', onFocusIn, true)
    }
  }, [isTopLayer])

  return createPortal(
    <div
      className="ui-modal-overlay fixed inset-0 z-50 flex w-full items-center justify-center overflow-y-auto p-4"
      role="presentation"
      onMouseDown={event => {
        if (event.target === event.currentTarget) tryClose()
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className="ui-modal-panel reveal paper w-full overflow-y-auto p-6 outline-none"
        style={{
          width: `min(${width}px, calc(100vw - 2rem))`,
          maxWidth: '100%',
          maxHeight: `min(${maxHeight}, calc(100dvh - 2rem))`,
          boxSizing: 'border-box'
        }}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="ui-modal-header flex justify-between gap-4">
          <h2 id={titleId} className="ui-modal-title">
            {title}
          </h2>
          <button
            type="button"
            onClick={tryClose}
            disabled={busy}
            className="ui-modal-close shrink-0 text-[var(--text-dim)] transition-colors hover:text-[var(--text)] disabled:cursor-not-allowed disabled:opacity-40"
            aria-label="关闭对话框"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              aria-hidden="true"
            >
              <path d="m6 6 12 12M18 6 6 18" />
            </svg>
          </button>
        </div>
        <div className="ink-rule--gold my-4" />
        {children}
      </div>
    </div>,
    document.body
  )
}
