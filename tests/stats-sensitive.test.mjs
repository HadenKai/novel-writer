// 每日码字统计 + 敏感词检测 + 章节目录轻接口（meta=1）的回归测试
//
// 锁定四件事：
//  1. 章节保存的正增量计入当日统计（负增量 / 删字不冲减）
//  2. GET /api/stats/daily 汇总口径正确，支持 novelId 过滤
//  3. POST /api/analysis/sensitive 能按类目命中词与导流正则
//  4. GET /api/novels/:id?meta=1 不回传章节正文
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-statssensitive-'))
process.env.NOVEL_DATA_DIR = tmpData

const { startServer, stopServer } = await import('../server/app.mjs')

let base = ''

async function j(url, method = 'GET', body) {
  const r = await fetch(`${base}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  let data = null
  try {
    data = await r.json()
  } catch {
    /* 无响应体 */
  }
  return { status: r.status, data }
}

test('码字统计 / 敏感词 / meta 轻接口', { timeout: 60000 }, async () => {
  const port = await startServer(0)
  base = `http://127.0.0.1:${port}`

  const created = await j('/api/novels', 'POST', { title: '统计之书', genre: '都市' })
  assert.equal(created.status, 201)
  const id = created.data.id

  // ---------- 1. meta=1 不带正文 ----------
  await j(`/api/novels/${id}/import`, 'POST', { text: '第一章 起点\n' + '甲'.repeat(30) })
  const meta = await j(`/api/novels/${id}?meta=1`)
  assert.equal(meta.status, 200)
  assert.equal(meta.data.chapters.length, 1)
  assert.ok(
    !('content' in (meta.data.chapters[0] || {})) || meta.data.chapters[0].content === undefined,
    'meta=1 不应回传正文'
  )
  const full = await j(`/api/novels/${id}`)
  assert.equal(typeof full.data.chapters[0].content, 'string', '不带 meta 时正文照常返回')

  // ---------- 2. 码字统计：正增量计入，负增量不冲减 ----------
  const beforeWords = full.data.chapters[0].words
  const grow = await j(`/api/novels/${id}/chapters/1`, 'PUT', {
    title: '起点',
    content: full.data.chapters[0].content + '乙'.repeat(20)
  })
  assert.equal(grow.status, 200)
  const delta1 = grow.data.chapter.words - beforeWords
  assert.ok(delta1 > 0)

  const day = new Date()
  const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`
  const stats1 = await j('/api/stats/daily')
  assert.equal(stats1.data.daily[key], delta1, '当日统计应等于正增量')

  // 删字：负增量不计入也不冲减
  const shrink = await j(`/api/novels/${id}/chapters/1`, 'PUT', {
    title: '起点',
    content: '丙'.repeat(5)
  })
  assert.equal(shrink.status, 200)
  const stats2 = await j('/api/stats/daily')
  assert.equal(stats2.data.daily[key], delta1, '删字不应冲减当日统计')

  // novelId 过滤：别的书不会混进来
  const other = await j('/api/novels', 'POST', { title: '别的书', genre: '玄幻' })
  assert.equal(other.status, 201)
  const stats3 = await j(`/api/stats/daily?novelId=${other.id}`)
  assert.equal(stats3.data.daily[key] || 0, 0, '未写作的书统计应为 0 或不存在')

  // ---------- 3. 敏感词检测 ----------
  const sens = await j('/api/analysis/sensitive', 'POST', {
    items: [
      { key: '1', label: '第一章', text: '他骂了句傻逼，然后加了微信 13812345678，详情见 https://example.com/abc。' },
      { key: '2', label: '第二章', text: '这一章干干净净，没有任何问题。' }
    ]
  })
  assert.equal(sens.status, 200)
  assert.ok(sens.data.total >= 3, `应命中至少 3 处（辱骂词 + 手机号 + 网址），实际 ${sens.data.total}`)
  assert.ok((sens.data.byCategory.abuse || 0) >= 1, '辱骂类应命中')
  assert.ok((sens.data.byCategory.ads || 0) >= 2, '导流类应命中手机号与网址')
  const g1 = sens.data.groups.find(g => g.key === '1')
  const g2 = sens.data.groups.find(g => g.key === '2')
  assert.ok(g1.count > 0, '第一章应有命中')
  assert.equal(g2.count, 0, '第二章应干净')
  for (const h of g1.hits) assert.ok(typeof h.index === 'number' && h.context.length > 0)

  // 请求校验：空 items 拒绝
  const bad = await j('/api/analysis/sensitive', 'POST', { items: [] })
  assert.equal(bad.status, 400)

  await stopServer()
})
