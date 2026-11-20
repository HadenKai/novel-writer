import { useEffect, useState } from 'react'
import type { CodexDesktopAPI, CodexUsageSnapshot } from '../lib/desktop'

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

  useEffect(() => {
    let active = true
    void codex.getUsage(refresh > 0).then(
      usage => {
        if (active) setSnapshot(usage)
      },
      () => {
        if (active) setSnapshot(null)
      }
    )
    return () => {
      active = false
    }
  }, [codex, refresh])

  const loading = snapshot === undefined
  const windows = snapshot?.windows ?? []
  const status = loading ? '正在读取用量…' : '用量暂不可用'
  const summary = windows.length
    ? windows
        .map(window => `${windowLabel(window.durationSeconds)}剩余 ${percent.format(window.remainingPercent)}%`)
        .join(' · ')
    : status

  return (
    <details className="resources-subscription-usage">
      <summary aria-label={`Codex 用量，${summary}`}>
        <span role="status">{summary}</span>
      </summary>
      <div className="resources-subscription-usage-panel">
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
    </details>
  )
}
