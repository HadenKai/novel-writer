// 「计划章节数 / 每章目标字数」语义回归测试
//
// 这两个字段是作者设定的「全书规模参考」，用于让 AI 把握篇幅，
// 既不是生成配额，也不该被系统悄悄改写。本测试锁定三件事：
//  1. 不设 300 章上限（创建、更新、管家动作三处入口）
//  2. 导入既有文稿后不按大纲条数回写
//  3. 删除章节后不按大纲条数回写
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-chaptercount-'))
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

test('计划章节数：无上限、不被大纲条数改写', { timeout: 60000 }, async () => {
  const port = await startServer(0)
  base = `http://127.0.0.1:${port}`

  // ---------- 1. 创建时即可超过 300 ----------
  const created = await j('/api/novels', 'POST', { title: '长篇计划', genre: '玄幻', chapterCount: 800 })
  assert.equal(created.status, 201)
  const id = created.data.id
  assert.equal(created.data.chapterCount, 800, '创建时应接受 800 章（不再被 300 截断）')

  // ---------- 2. PUT 更新同样不设上限 ----------
  const put = await j(`/api/novels/${id}`, 'PUT', { id, chapterCount: 1234 })
  assert.equal(put.status, 200)
  assert.equal(put.data.chapterCount, 1234, '更新时应接受 1234 章')

  // 下限保护：0 / 负数 / 非法值都会回落到合法的正数（沿用既有 normalize 行为，0 视为「未设置」→ 默认 12）
  const putLow = await j(`/api/novels/${id}`, 'PUT', { id, chapterCount: 0 })
  assert.equal(putLow.status, 200)
  assert.ok(putLow.data.chapterCount >= 1, `非法值应回落到 ≥1，实际 ${putLow.data.chapterCount}`)

  // 复位为 800 继续后续断言
  await j(`/api/novels/${id}`, 'PUT', { id, chapterCount: 800 })

  // ---------- 3. 导入文稿后不被大纲条数回写 ----------
  const imported = await j(`/api/novels/${id}/import`, 'POST', {
    replace: true,
    text: [
      '第1章 开端',
      '正文一。'.repeat(20),
      '第2章 承接',
      '正文二。'.repeat(20),
      '第3章 转折',
      '正文三。'.repeat(20)
    ].join('\n')
  })
  assert.equal(imported.status, 200)
  assert.ok(imported.data.chapters >= 3, `应识别出章节，实际 ${imported.data.chapters}`)

  const afterImport = await j(`/api/novels/${id}`)
  assert.equal(afterImport.data.chapters.length, 3, '导入应有 3 章')
  assert.equal(afterImport.data.chapterCount, 800, '导入 3 章后，计划章节数仍应为 800（不被改成 3）')

  // ---------- 4. 删除章节后不被大纲条数回写 ----------
  const del = await j(`/api/novels/${id}/chapters/3`, 'DELETE')
  assert.equal(del.status, 200)

  const afterDelete = await j(`/api/novels/${id}`)
  assert.equal(afterDelete.data.chapters.length, 2, '删除后应剩 2 章')
  assert.equal(afterDelete.data.chapterCount, 800, '删章后，计划章节数仍应为 800（不被改成 2）')

  // ---------- 5. 管家动作 chapterCount 同样无上限 ----------
  const { applyChatActions } = await import('../server/app.mjs')
  const novel = afterDelete.data
  const applied = applyChatActions(novel, { actions: [{ type: 'chapterCount', text: '900' }] }, {})
  assert.equal(applied.length, 1)
  assert.equal(applied[0].status, 'applied', '管家动作应生效')
  assert.equal(novel.chapterCount, 900, '管家动作应接受 900 章（不再被 300 截断）')

  await stopServer()
  fs.rmSync(tmpData, { recursive: true, force: true })
})
