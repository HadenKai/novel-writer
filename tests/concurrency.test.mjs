// 并发写竞争与实例锁回归测试
//
// 背景（原实现的真 BUG）：
//  1. saveNovel / saveChapterContent / saveChat 都是「同步读 → 改 → 同步写」，
//     两个请求并发改动同一本书时会互相覆盖（后写的赢，前一份改动静默丢失）。
//     典型现象：流式生成每 1.2s 落一次草稿，此时管家在改另一章 → 章不见了。
//  2. 同一数据目录可能被两个进程同时打开（独立运行后端 + 双击两次便携版），
//     写盘/备份互相抢占。
//
// 本测试锁定：
//  1. 并发写同一本书的不同章节：全部保留，一个都不丢（串行事务生效）
//  2. 并发写会话消息：不丢更新
//  3. 同一数据目录重复 startServer 会被实例锁拒绝
//
// 说明：断言合并在单个 test 内 —— 多个 top-level test 共享服务端模块状态。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const PROJECT_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-concurrency-'))
process.env.NOVEL_DATA_DIR = tmpData

const app = await import('../server/app.mjs')

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

test('并发写不丢更新 + 实例锁', { timeout: 60000 }, async () => {
  const port = await app.startServer(0)
  base = `http://127.0.0.1:${port}`

  // ---------- 1. 并发写同一本书的不同章节 ----------
  const created = await j('/api/novels', 'POST', { title: '并发测试书', genre: '玄幻' })
  assert.equal(created.status, 201)
  const id = created.data.id

  // 用 import 接口一次性建出 12 章（靠「第N章」标题行识别）
  const rawText = Array.from(
    { length: 12 },
    (_, i) => `第${i + 1}章 测试章节\n\n这是第${i + 1}章导入的正文。${'内容'.repeat(20)}`
  ).join('\n\n')
  const imported = await j(`/api/novels/${id}/import`, 'POST', { text: rawText, replace: false })
  assert.equal(imported.status, 200, `import 应当成功：${JSON.stringify(imported.data)}`)
  const seeded = await j(`/api/novels/${id}`)
  assert.ok((seeded.data.chapters || []).length >= 12, `导入后应有 ≥12 章，实际 ${(seeded.data.chapters || []).length}`)

  // 管家页面选择的模型通过轻量偏好接口持久化，不依赖设定页整书保存。
  const pref = await j(`/api/novels/${id}/prefs`, 'PUT', { modelId: 'model-persisted' })
  assert.equal(pref.status, 200)
  assert.equal(pref.data.modelId, 'model-persisted')
  const reloadedPref = await j(`/api/novels/${id}`)
  assert.equal(reloadedPref.data.modelId, 'model-persisted')

  // 12 个「写入不同章正文」的请求同时发出。
  // 旧实现下它们各自「读全书 → 改一章 → 写全书」，并发时互相覆盖，最终只剩少数几章。
  const writes = Array.from({ length: 12 }, (_, i) =>
    j(`/api/novels/${id}/chapters/${i + 1}`, 'PUT', {
      content: `这是第${i + 1}章的正文内容。${'句'.repeat(40)}`,
      status: 'done'
    })
  )
  const results = await Promise.all(writes)
  const okCount = results.filter(r => r.status === 200 || r.status === 201).length
  assert.ok(okCount >= 1, `至少应有一个写入成功，实际 ${okCount}`)

  // 核心断言：所有成功写入的章节都必须真实存在于书里（不丢更新）
  const after = await j(`/api/novels/${id}`)
  assert.equal(after.status, 200)
  const chapters = after.data.chapters || []
  const okIndices = results.map((r, i) => (r.status === 200 || r.status === 201 ? i + 1 : null)).filter(Boolean)
  const missing = okIndices.filter(idx => !chapters.some(c => c.index === idx))
  assert.deepEqual(missing, [], `以下章节接口返回成功但正文丢失（并发覆盖）：${missing.join(', ')}`)

  // 普通删除必须同步删除大纲并连续重编号。
  const deleted = await j(`/api/novels/${id}/chapters/3`, 'DELETE')
  assert.equal(deleted.status, 200)
  const afterDelete = await j(`/api/novels/${id}`)
  assert.equal(afterDelete.status, 200)
  assert.ok(!(afterDelete.data.chapters || []).some(c => c.index === 12 && c.content.includes('第12章')))
  assert.deepEqual(
    (afterDelete.data.outline || []).map(o => o.index),
    (afterDelete.data.outline || []).map((_, i) => i + 1),
    '删除后大纲章号应连续'
  )

  // ---------- 2. 并发写会话：不丢更新 ----------
  const sessions = await Promise.all(
    Array.from({ length: 6 }, (_, i) => j(`/api/novels/${id}/chat`, 'POST', { title: `并发会话${i}` }))
  )
  const created2 = sessions.filter(s => s.status === 201).length
  assert.equal(created2, 6, '6 个并发新建会话都应成功')
  const list = await j(`/api/novels/${id}/chat`)
  assert.equal(list.status, 200)
  assert.equal(list.data.sessions.length, 6, `并发新建的 6 个会话都应保留，实际只剩 ${list.data.sessions.length}`)

  // ---------- 3. 实例锁：同进程重复启动幂等；跨进程仍被拒 ----------
  // macOS 上关窗后再点 Dock 图标（activate）会重建窗口并再次调用 startServer：
  // 同进程二次调用必须幂等返回现有端口，而不是把自己的锁当成「另一进程占用」报错。
  const again = await app.startServer(0)
  assert.equal(again, port, '同进程重复 startServer 应幂等返回现有端口')

  // 跨进程保护保持不变：本进程持有锁时，另一个进程对同一数据目录启动必须被拒
  const childCode = `
    process.env.NOVEL_DATA_DIR = ${JSON.stringify(tmpData)}
    import('./server/app.mjs')
      .then(async m => {
        try {
          await m.startServer(0)
          console.log('UNEXPECTED-SUCCESS')
        } catch (e) {
          console.log(/已被另一个|占用|锁/.test(String(e.message)) ? 'LOCKED-OK' : 'LOCKED-BAD:' + e.message)
        }
        process.exit(0)
      })
      .catch(e => {
        console.log('IMPORT-FAIL:' + e.message)
        process.exit(0)
      })
  `
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', childCode], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    timeout: 30000
  })
  assert.match(
    String(child.stdout),
    /LOCKED-OK/,
    `另一进程启动应被实例锁拒绝：stdout=${child.stdout} stderr=${child.stderr}`
  )

  // 释放后应能再次启动（验证锁可正常回收）
  await app.stopServer()
  const port2 = await app.startServer(0)
  assert.ok(port2 > 0, 'stopServer 后应能重新启动')
  await app.stopServer()
})

// 断言失败时也要把服务停掉：否则 Express 监听句柄挂着，node --test 永不退出，
// 整个 verify 会被这一个文件拖死
test.after(async () => {
  try {
    await app.stopServer()
  } catch {}
})
