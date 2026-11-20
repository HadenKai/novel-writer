import { useEffect, useId, useRef, useState } from 'react'
import type { CodexDesktopAPI, CodexUsageSnapshot } from '../lib/desktop'

const USAGE_REFRESH_MS = 40_000
const percent = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 })
const resetTime = new Intl.DateTimeFormat('zh-CN', {
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23'
})

function windowLabel(seconds: number) {
  return seconds === 18_000 ? '5 小时' : '7 天'
}

export default function CodexUsage({ codex }: { codex: CodexDesktopAPI }) {
  const [snapshot, setSnapshot] = useState<CodexUsageSnapshot | null>()
  const [refresh, setRefresh] = useState(0)
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelId = useId()

  useEffect(() => {
    let active = true
    function loadUsage(force: boolean) {
      void codex.getUsage(force).then(
        usage => {
          if (active) setSnapshot(usage)
        },
        () => {
          if (active) setSnapshot(null)
        }
      )
    }
    loadUsage(refresh > 0)
    const usageTimer = window.setInterval(() => loadUsage(true), USAGE_REFRESH_MS)
    return () => {
      active = false
      window.clearInterval(usageTimer)
    }
  }, [codex, refresh])

  useEffect(() => {
    if (!open) return
    function dismissOutside(event: PointerEvent) {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false)
    }
    function dismissOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault()
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    document.addEventListener('pointerdown', dismissOutside, true)
    document.addEventListener('keydown', dismissOnEscape)
    return () => {
      document.removeEventListener('pointerdown', dismissOutside, true)
      document.removeEventListener('keydown', dismissOnEscape)
    }
  }, [open])

  const loading = snapshot === undefined
  const windows = snapshot?.windows ?? []
  const status = loading ? '正在读取用量…' : '用量暂不可用'
  const summary = windows.length
    ? windows
        .map(window => `${windowLabel(window.durationSeconds)}剩余 ${percent.format(window.remainingPercent)}%`)
        .join(' · ')
    : status

  return (
    <div className="resources-subscription-usage" ref={rootRef}>
      <button
        type="button"
        ref={triggerRef}
        className="resources-subscription-usage-trigger"
        aria-label={`Codex 用量，${summary}`}
        aria-controls={panelId}
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
      >
        {windows.length ? (
          windows.map(window => (
            <span key={window.durationSeconds} className="resources-subscription-usage-window">
              <span>{windowLabel(window.durationSeconds)}剩余</span>
              <span className="resources-usage-meter" aria-hidden="true">
                <span style={{ width: `${window.remainingPercent}%` }} />
              </span>
              <strong>{percent.format(window.remainingPercent)}%</strong>
            </span>
          ))
        ) : (
          <span role="status">{status}</span>
        )}
      </button>
      <div
        id={panelId}
        hidden={!open}
        className="resources-subscription-usage-panel"
        role="group"
        aria-label="订阅用量详情"
      >
        <div className="resources-subscription-usage-heading">
          <strong>用量详情</strong>
          <button
            type="button"
            className="resources-subscription-usage-close"
            aria-label="关闭用量详情"
            onClick={() => {
              setOpen(false)
              triggerRef.current?.focus()
            }}
          >
            ×
          </button>
        </div>
        {windows.length ? (
          <dl>
            {windows.map(window => (
              <div key={window.durationSeconds}>
                <dt>{windowLabel(window.durationSeconds)}重置</dt>
                <dd>
                  {window.resetsAt ? (
                    <time dateTime={new Date(window.resetsAt).toISOString()}>{resetTime.format(window.resetsAt)}</time>
                  ) : (
                    '时间未知'
                  )}
                </dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="resources-hint">{status}</p>
        )}
        <button
          type="button"
          className="resources-button resources-button--quiet"
          disabled={loading}
          onClick={() => {
            setSnapshot(undefined)
            setRefresh(count => count + 1)
          }}
        >
          刷新用量
        </button>
      </div>
    </div>
  )
}
