import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

/**
 * 全局轻提示：替代各页面自带的 notice/flash 条。
 *
 * 用法与 DialogHost 一致——App 根部挂一个 <ToastHost />，任意位置直接：
 *   import { toast } from '../components/Toast'
 *   toast('已保存。')              // info，默认
 *   toast.success('已入库。')      // 绿色勾
 *   toast.error('上传失败。')      // 红色，停留更久
 *
 * 点击任意一条可立即关闭；同类提示最多同时展示 4 条，超出淘汰最旧的。
 */

export type ToastTone = 'info' | 'success' | 'error'

interface ToastItem {
  id: number
  tone: ToastTone
  text: string
  leaving?: boolean
}

const DURATION: Record<ToastTone, number> = { success: 2400, info: 3200, error: 5000 }
const MAX_VISIBLE = 4
const EXIT_MS = 200

const items: ToastItem[] = []
const listeners = new Set<() => void>()
let seq = 0

function emit() {
  listeners.forEach(l => l())
}

function remove(item: ToastItem) {
  // 先播退场动画再真正移除：直接 splice 会让提示「啪」地消失，缺一个收尾
  if (item.leaving) return
  item.leaving = true
  emit()
  window.setTimeout(() => {
    const i = items.indexOf(item)
    if (i >= 0) {
      items.splice(i, 1)
      emit()
    }
  }, EXIT_MS)
}

function push(text: string, tone: ToastTone) {
  const item: ToastItem = { id: ++seq, tone, text }
  items.push(item)
  if (items.length > MAX_VISIBLE) items.shift()
  emit()
  window.setTimeout(() => remove(item), DURATION[tone])
}

export function toast(text: string, tone: ToastTone = 'info') {
  push(text, tone)
}
toast.success = (text: string) => push(text, 'success')
toast.error = (text: string) => push(text, 'error')

const TONE_COLOR: Record<ToastTone, string> = {
  info: 'var(--gold)',
  success: 'var(--jade)',
  error: 'var(--seal)'
}

function ToneDot({ tone }: { tone: ToastTone }) {
  const common = {
    width: 15,
    height: 15,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const
  }
  if (tone === 'success') {
    return (
      <svg {...common}>
        <path d="M20 6 9 17l-5-5" />
      </svg>
    )
  }
  if (tone === 'error') {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 16v-4" />
        <path d="M12 8h.01" />
      </svg>
    )
  }
  return (
    <svg {...common}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 16v-4" />
      <path d="M12 8h.01" />
    </svg>
  )
}

/** 轻提示宿主：在 App 根部挂一次即可 */
export function ToastHost() {
  const [, setVersion] = useState(0)
  useEffect(() => {
    const l = () => setVersion(v => v + 1)
    listeners.add(l)
    return () => {
      listeners.delete(l)
    }
  }, [])
  if (!items.length) return null
  return createPortal(
    <div className="ink-toast-host" role="status" aria-live="polite">
      {items.map(t => (
        <button
          key={t.id}
          type="button"
          title="点击关闭"
          onClick={() => remove(t)}
          className={`ink-toast ${t.leaving ? 'toast-out' : 'toast-in'}`}
          style={{ ['--toast-tone' as string]: TONE_COLOR[t.tone] }}
        >
          <span className="ink-toast__icon">
            <ToneDot tone={t.tone} />
          </span>
          <span className="ink-toast__text">{t.text}</span>
          <svg className="ink-toast__close" width="12" height="12" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 6l12 12M18 6 6 18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>
      ))}
    </div>,
    document.body
  )
}
