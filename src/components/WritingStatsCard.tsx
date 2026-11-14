import { useMemo, useState } from 'react'
import { dayKey, useDailyStats } from '../lib/hooks/useDailyStats'
import { MountainLine } from './InkArt'

/**
 * 写作日历（每日码字统计）：作品库右栏的两张卡。
 *
 * 数据口径由服务端保证：只有「章节保存」里的正增量会计入（AI 批量生成 /
 * 导入 / 一键排版不经过那条路由），所以这里展示的是作者真的手敲的字。
 * 上卡是月历：今天是鎏金圆，写过字的日子下面有一个金点（字数越多越亮）；
 * 下卡是所看月份的统计：总字数 / 日均 / 本周 / 创作天数。
 */

/** 档位：0 未写 / 1 <200 / 2 <1000 / 3 <3000 / 4 ≥3000（网文日更 3k 算高产） */
function levelOf(w: number) {
  return w <= 0 ? 0 : w < 200 ? 1 : w < 1000 ? 2 : w < 3000 ? 3 : 4
}

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日']

function Chevron({ dir }: { dir: 'left' | 'right' }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      aria-hidden="true"
    >
      <path d={dir === 'left' ? 'M14.5 6l-6 6 6 6' : 'M9.5 6l6 6-6 6'} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export default function WritingStatsCard() {
  const { daily } = useDailyStats()
  const [cursor, setCursor] = useState(() => {
    const d = new Date()
    return { y: d.getFullYear(), m: d.getMonth() }
  })
  const now = new Date()
  const isCurrentMonth = cursor.y === now.getFullYear() && cursor.m === now.getMonth()
  const todayKey = dayKey(now)

  const week = useMemo(() => {
    let s = 0
    for (let i = 0; i < 7; i++) {
      const d = new Date()
      d.setDate(d.getDate() - i)
      s += daily[dayKey(d)] || 0
    }
    return s
  }, [daily])

  const month = useMemo(() => {
    let total = 0
    let days = 0
    for (const [k, v] of Object.entries(daily)) {
      const [y, m] = k.split('-').map(Number)
      if (y === cursor.y && m - 1 === cursor.m && v > 0) {
        total += v
        days += 1
      }
    }
    return { total, days, avg: days ? Math.round(total / days) : 0 }
  }, [daily, cursor])

  // 月历格子：永远铺满 6 行 7 列，非本月日期淡化
  const cells = useMemo(() => {
    const first = new Date(cursor.y, cursor.m, 1)
    const start = new Date(first)
    start.setDate(first.getDate() - ((first.getDay() + 6) % 7))
    const out: { key: string; day: number; inMonth: boolean; future: boolean }[] = []
    for (let i = 0; i < 42; i++) {
      const d = new Date(start)
      d.setDate(start.getDate() + i)
      out.push({ key: dayKey(d), day: d.getDate(), inMonth: d.getMonth() === cursor.m, future: d > new Date() })
    }
    return out
  }, [cursor])

  const shiftMonth = (delta: number) =>
    setCursor(c => {
      const d = new Date(c.y, c.m + delta, 1)
      return { y: d.getFullYear(), m: d.getMonth() }
    })

  const num = (n: number) => n.toLocaleString('zh-CN')

  return (
    <>
      <section className="stats-card" aria-label="写作日历">
        <header className="stats-head">
          <h2 className="stats-title">写作日历</h2>
          <div className="stats-month">
            <button type="button" onClick={() => shiftMonth(-1)} aria-label="上个月">
              <Chevron dir="left" />
            </button>
            <span>
              {cursor.y === now.getFullYear() ? '' : `${cursor.y} 年 `}
              {cursor.m + 1} 月
            </span>
            <button type="button" onClick={() => shiftMonth(1)} aria-label="下个月" disabled={isCurrentMonth}>
              <Chevron dir="right" />
            </button>
          </div>
        </header>
        <div className="stats-grid" aria-label={`${cursor.y} 年 ${cursor.m + 1} 月码字记录`}>
          {WEEKDAYS.map(w => (
            <span key={w} className="stats-weekday" aria-hidden="true">
              {w}
            </span>
          ))}
          {cells.map(c => {
            const w = daily[c.key] || 0
            const level = c.future ? 0 : levelOf(w)
            return (
              <span
                key={c.key}
                title={`${c.key} · ${w ? `${num(w)} 字` : '未记录'}`}
                className={`stats-day${c.inMonth ? '' : ' is-outside'}${c.future ? ' is-future' : ''}${
                  c.key === todayKey ? ' is-today' : ''
                }`}
                data-level={level}
              >
                {c.day}
              </span>
            )
          })}
        </div>
      </section>

      <section className="stats-card stats-summary" aria-label="本月统计">
        <header className="stats-head">
          <h2 className="stats-title">{isCurrentMonth ? '本月统计' : `${cursor.m + 1} 月统计`}</h2>
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            aria-hidden="true"
          >
            <path d="M5 19V11M10 19V6M15 19v-5M20 19V9" strokeLinecap="round" />
          </svg>
        </header>
        <dl className="stats-rows">
          <div>
            <dt>总字数</dt>
            <dd className="ink-num">{num(month.total)}</dd>
          </div>
          <div>
            <dt>日均字数</dt>
            <dd className="ink-num">{num(month.avg)}</dd>
          </div>
          {isCurrentMonth && (
            <div>
              <dt>近 7 天</dt>
              <dd className="ink-num">{num(week)}</dd>
            </div>
          )}
          <div>
            <dt>创作天数</dt>
            <dd>
              <span className="ink-num">{month.days}</span> 天
            </dd>
          </div>
        </dl>
        <p className="stats-note">只统计手动保存的正文字数；AI 生成、导入与一键排版不计入。</p>
        <MountainLine className="stats-art" />
      </section>
    </>
  )
}
