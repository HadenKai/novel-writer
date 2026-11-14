import { STATS_FILE, readJson, updateJson } from './store.mjs'

/**
 * 每日码字统计。
 *
 * 记录口径：章节保存接口里正文的「净增字数」（只记正增量，删字回退不冲减）。
 * AI 批量生成、导入、一键排版不经过该接口，天然不会把机器产出算进码字量。
 * 结构：{ 'YYYY-MM-DD': { [novelId]: 字数 } }，本地时区日期。
 */

function localDateKey(d = new Date()) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function readDailyStats() {
  return readJson(STATS_FILE, {})
}

/** 记一笔：novelId 当日净增 n 字；n<=0 忽略 */
export async function recordWords(novelId, n) {
  if (!(Number(n) > 0) || !novelId) return
  const day = localDateKey()
  await updateJson(
    STATS_FILE,
    data => {
      if (!data[day] || typeof data[day] !== 'object') data[day] = {}
      data[day][novelId] = (data[day][novelId] || 0) + Math.floor(n)
      return data
    },
    {}
  )
}

/** 汇总视图：把 { date: { novelId: words } } 折叠成 { date: total }，可按书过滤；只回最近 days 天 */
export function dailyTotals({ novelId, days = 370 } = {}) {
  const all = readDailyStats()
  const cutoff = Date.now() - days * 86400000
  const out = {}
  for (const [date, perNovel] of Object.entries(all)) {
    const t = Date.parse(`${date}T00:00:00`)
    if (!Number.isFinite(t) || t < cutoff) continue
    let total = 0
    if (novelId) {
      total = Number(perNovel?.[novelId]) || 0
    } else {
      for (const v of Object.values(perNovel || {})) total += Number(v) || 0
    }
    if (total > 0) out[date] = total
  }
  return out
}
