import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

// 独立数据目录，避免污染项目 data/
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-kb-test-'))
process.env.NOVEL_DATA_DIR = tmpData

const { startServer, stopServer } = await import('../server/app.mjs')

const json = { 'Content-Type': 'application/json' }

test('知识库 API：建库 → base64(GBK) 入库 → 库内检索隔离 → 问答守卫 → 删除', { timeout: 30000 }, async () => {
  const port = await startServer(0)
  const base = `http://127.0.0.1:${port}/api`

  const created = await (
    await fetch(`${base}/kb`, { method: 'POST', headers: json, body: JSON.stringify({ name: '实测库' }) })
  ).json()
  const id = created.kb.id
  assert.ok(id)

  // 浏览器选文件走 base64；GBK 字节（「你好」×40）必须被回退解码成正确中文
  const gbk = Buffer.concat(Array.from({ length: 40 }, () => Buffer.from([0xc4, 0xe3, 0xba, 0xc3])))
  const up = await (
    await fetch(`${base}/kb/${id}/docs`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ name: '设定.txt', base64: gbk.toString('base64') })
    })
  ).json()
  assert.equal(up.ok, true)
  assert.equal(up.doc.chars, 80)

  const list = await (await fetch(`${base}/kb`)).json()
  assert.equal(list.find(k => k.id === id).docs.length, 1)

  // 库内检索命中；限定到不存在的库则隔离为空
  const hit = await (await fetch(`${base}/kb/search?q=${encodeURIComponent('你好')}&kb=${id}`)).json()
  assert.equal(hit.hits.length, 1)
  assert.match(hit.hits[0].text, /你好/)
  const isolated = await (await fetch(`${base}/kb/search?q=${encodeURIComponent('你好')}&kb=nope`)).json()
  assert.equal(isolated.hits.length, 0)

  // 问答历史初始为空；无模型配置时提问被守卫拦下；未知库 404
  assert.deepEqual(await (await fetch(`${base}/kb/${id}/qa`)).json(), [])
  const noModel = await fetch(`${base}/kb/ask`, {
    method: 'POST',
    headers: json,
    body: JSON.stringify({ kbId: id, question: '你好是什么意思' })
  })
  assert.equal(noModel.status, 400)
  const unknown = await fetch(`${base}/kb/ask`, {
    method: 'POST',
    headers: json,
    body: JSON.stringify({ kbId: 'nope', question: 'x' })
  })
  assert.equal(unknown.status, 404)
  assert.equal((await (await fetch(`${base}/kb/${id}/qa`, { method: 'DELETE' })).json()).ok, true)

  assert.equal((await fetch(`${base}/kb/${id}`, { method: 'DELETE' })).ok, true)
  const after = await (await fetch(`${base}/kb`)).json()
  assert.equal(
    after.some(k => k.id === id),
    false
  )

  await stopServer()
})
