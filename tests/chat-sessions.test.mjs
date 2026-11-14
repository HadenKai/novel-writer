// 创作研讨「多会话」存储与 API 回归测试
//
// 覆盖：
//  - v1（纯消息数组）→ v2（多会话）自动迁移，标题由首条用户消息推导
//  - 会话的增 / 查 / 改 / 删，activeId 的回退规则
//  - 消息与会话的绑定（同一本书多条线索互不串扰）
//  - 存储上限与排序（最近更新的会话在前）
//
// 说明：所有断言合并在单个 test 内。多个 top-level test 会共享同一份服务端模块状态与
// 数据目录，并发启动服务会互相覆盖 base 端口，导致断言串测。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-chat-sessions-'))
process.env.NOVEL_DATA_DIR = tmpData
const CHATS_DIR = path.join(tmpData, 'chats')

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

/** 直接写入 chats/<id>.json，用于构造特定初始状态 */
function writeChatFile(id, payload) {
  fs.mkdirSync(CHATS_DIR, { recursive: true })
  fs.writeFileSync(path.join(CHATS_DIR, `${id}.json`), JSON.stringify(payload), 'utf8')
}

function readChatFile(id) {
  return JSON.parse(fs.readFileSync(path.join(CHATS_DIR, `${id}.json`), 'utf8'))
}

test('研讨多会话：迁移 / 增删改查 / 消息隔离 / 上限截断', { timeout: 60000 }, async () => {
  const port = await startServer(0)
  base = `http://127.0.0.1:${port}`

  const created = await j('/api/novels', 'POST', { title: '会话测试书', genre: '玄幻' })
  const novelId = created.data.id
  assert.ok(novelId)

  // ---------- 1. 初始：无会话 ----------
  const empty = await j(`/api/novels/${novelId}/chat`)
  assert.equal(empty.status, 200)
  assert.deepEqual(empty.data.sessions, [])
  assert.equal(empty.data.activeId, '')

  // ---------- 2. v1 迁移：写入纯数组，读取后应变为 v2 且标题取自首条用户消息 ----------
  writeChatFile(novelId, [
    { role: 'user', content: '帮我看看第5章的剧情走向，给几个方案', at: 1_700_000_000_000 },
    { role: 'assistant', content: '给你三个方案……', at: 1_700_000_001_000 }
  ])
  const migrated = await j(`/api/novels/${novelId}/chat`)
  assert.equal(migrated.data.sessions.length, 1)
  assert.equal(migrated.data.sessions[0].title, '帮我看看第5章的剧情走向，给几个方案')
  assert.equal(migrated.data.sessions[0].count, 2)
  // 迁移应已落盘为 v2
  const onDisk = readChatFile(novelId)
  assert.equal(onDisk.version, 2)
  assert.equal(onDisk.sessions.length, 1)
  assert.equal(onDisk.sessions[0].messages.length, 2)
  assert.ok(onDisk.activeId)

  // ---------- 3. 新建会话：置为活跃，标题默认「新对话」 ----------
  const a = await j(`/api/novels/${novelId}/chat`, 'POST', {})
  assert.equal(a.status, 201)
  assert.equal(a.data.session.title, '新对话')
  assert.deepEqual(a.data.session.messages, [])

  const b = await j(`/api/novels/${novelId}/chat`, 'POST', { title: '配角线讨论' })
  assert.equal(b.data.session.title, '配角线讨论')

  // 列表应为 3 个（迁移来的 + 新建 2 个），且新建的置顶、activeId 指向最新
  const listed = await j(`/api/novels/${novelId}/chat`)
  assert.equal(listed.data.sessions.length, 3)
  assert.equal(listed.data.sessions[0].id, b.data.session.id)
  assert.equal(listed.data.activeId, b.data.session.id)

  // ---------- 4. 消息按会话隔离 ----------
  const store = readChatFile(novelId)
  const sessA = store.sessions.find(s => s.id === a.data.session.id)
  sessA.messages = [
    { role: 'user', content: 'A 线索的问题', at: Date.now() },
    { role: 'assistant', content: 'A 线索的回答', at: Date.now() }
  ]
  sessA.updatedAt = Date.now()
  writeChatFile(novelId, store)

  const readA = await j(`/api/novels/${novelId}/chat/${a.data.session.id}`)
  assert.equal(readA.data.session.messages.length, 2)
  assert.equal(readA.data.session.messages[0].content, 'A 线索的问题')

  const readB = await j(`/api/novels/${novelId}/chat/${b.data.session.id}`)
  assert.equal(readB.data.session.messages.length, 0)

  // ---------- 5. 重命名 ----------
  const renamed = await j(`/api/novels/${novelId}/chat/${a.data.session.id}`, 'PATCH', { title: '主线节奏' })
  assert.equal(renamed.status, 200)
  assert.equal(renamed.data.session.title, '主线节奏')
  // 空标题应被拒
  const badRename = await j(`/api/novels/${novelId}/chat/${a.data.session.id}`, 'PATCH', { title: '   ' })
  assert.equal(badRename.status, 400)

  // ---------- 6. 删除：activeId 回退到剩余会话 ----------
  const del = await j(`/api/novels/${novelId}/chat/${b.data.session.id}`, 'DELETE')
  assert.equal(del.status, 200)
  assert.equal(del.data.sessions.length, 2)
  assert.notEqual(del.data.activeId, b.data.session.id)
  assert.ok(del.data.sessions.some(s => s.id === del.data.activeId))
  // 删不存在的会话 → 404
  const delMissing = await j(`/api/novels/${novelId}/chat/${b.data.session.id}`, 'DELETE')
  assert.equal(delMissing.status, 404)

  // ---------- 7. 读取不存在的会话 → 404 ----------
  const readMissing = await j(`/api/novels/${novelId}/chat/does-not-exist`)
  assert.equal(readMissing.status, 404)

  // ---------- 8. 清空全部会话 ----------
  const cleared = await j(`/api/novels/${novelId}/chat`, 'DELETE')
  assert.equal(cleared.status, 200)
  const after = await j(`/api/novels/${novelId}/chat`)
  assert.deepEqual(after.data.sessions, [])
  assert.equal(after.data.activeId, '')

  // ---------- 9. 上限：会话数 60、单会话消息 400 ----------
  const sessions = []
  for (let i = 0; i < 70; i++) {
    sessions.push({
      id: `s${i}`,
      title: `会话${i}`,
      createdAt: 1_700_000_000_000 + i,
      updatedAt: 1_700_000_000_000 + i,
      messages: [{ role: 'user', content: `第${i}条`, at: 1_700_000_000_000 + i }]
    })
  }
  const longMsgs = Array.from({ length: 500 }, (_, k) => ({ role: 'user', content: `m${k}`, at: k + 1 }))
  sessions.push({
    id: 'long',
    title: '长会话',
    createdAt: 9_000_000_000_000,
    updatedAt: 9_000_000_000_000,
    messages: longMsgs
  })
  writeChatFile(novelId, { version: 2, activeId: 'long', sessions })

  const capped = await j(`/api/novels/${novelId}/chat`)
  assert.equal(capped.status, 200)
  assert.ok(capped.data.sessions.length <= 60, `会话数应被截断，实际 ${capped.data.sessions.length}`)
  // 最近更新的「长会话」应保留在最前
  assert.equal(capped.data.sessions[0].id, 'long')

  const longOne = await j(`/api/novels/${novelId}/chat/long`)
  assert.equal(longOne.status, 200)
  assert.ok(longOne.data.session.messages.length <= 400, `消息数应被截断，实际 ${longOne.data.session.messages.length}`)

  await stopServer()
  fs.rmSync(tmpData, { recursive: true, force: true })
})
