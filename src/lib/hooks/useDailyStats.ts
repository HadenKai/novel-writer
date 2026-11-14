import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'

/**
 * 每日码字统计的共享数据源：作品库、侧栏连续天数、写作日历共用一份，只拉一次。
 *
 * 口径由服务端保证：只有手动保存章节的正增量计入（AI 生成 / 导入 / 一键排版不计）。
 * 章节保存后（writer-chapter-saved 事件）延迟刷新，让「今日已写」跟上作者。
 */

export type DailyMap = Record<string, number>

export function dayKey(d: Date) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** 连续写作天数：今天还没写不打断昨天的连续 */
export function streakOf(daily: DailyMap) {
  let s = 0
  const d = new Date()
  if (!daily[dayKey(d)]) d.setDate(d.getDate() - 1)
  while (daily[dayKey(d)]) {
    s += 1
    d.setDate(d.getDate() - 1)
  }
  return s
}

let cache: { at: number; daily: DailyMap } | null = null
let inflight: Promise<void> | null = null
const listeners = new Set<(d: DailyMap) => void>()

function refresh(force = false) {
  if (!force && cache && Date.now() - cache.at < 30000) return Promise.resolve()
  if (inflight) return inflight
  inflight = api
    .getDailyStats({ days: 800 })
    .then(r => {
      cache = { at: Date.now(), daily: r.daily || {} }
      listeners.forEach(l => l(cache!.daily))
    })
    .catch(() => {})
    .finally(() => {
      inflight = null
    })
  return inflight
}

let savedTimer = 0
if (typeof window !== 'undefined') {
  window.addEventListener('writer-chapter-saved', () => {
    window.clearTimeout(savedTimer)
    savedTimer = window.setTimeout(() => void refresh(true), 1500)
  })
}

export function useDailyStats() {
  const [daily, setDaily] = useState<DailyMap>(() => cache?.daily || {})
  const [loaded, setLoaded] = useState(!!cache)
  useEffect(() => {
    const l = (d: DailyMap) => {
      setDaily(d)
      setLoaded(true)
    }
    listeners.add(l)
    void refresh().then(() => {
      if (cache) l(cache.daily)
    })
    return () => {
      listeners.delete(l)
    }
  }, [])
  return useMemo(() => {
    const today = daily[dayKey(new Date())] || 0
    return { daily, today, streak: streakOf(daily), loaded }
  }, [daily, loaded])
}
