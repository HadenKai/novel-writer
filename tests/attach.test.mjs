// 管家对话附件：图片上传 / 读取，以及非法输入的拒绝路径。
// 与封面同一套传输约束（原始二进制，理由见 cover.test.mjs 的头部注释）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-attach-test-'))
process.env.NOVEL_DATA_DIR = tmpData

const { startServer, stopServer } = await import('../server/app.mjs')

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
)

const upload = (base, buf, type) =>
  fetch(`${base}/api/attachments`, { method: 'POST', headers: { 'Content-Type': type }, body: buf })

test('对话附件：上传落盘 → 可取回；非法输入被拒', { timeout: 30000 }, async () => {
  const port = await startServer(0)
  const base = `http://127.0.0.1:${port}`
  try {
    const up = await upload(base, PNG_1PX, 'image/png')
    assert.equal(up.status, 200)
    const body = await up.json()
    assert.equal(body.ok, true)
    assert.match(body.file, /^[A-Za-z0-9_-]{1,64}\.png$/, '文件名应由服务端生成（随机 id + 扩展名）')
    assert.equal(body.url, `/api/attachments/${body.file}`)

    // 文件确实落在 <data>/attachments/ 下
    const stored = path.join(tmpData, 'attachments', body.file)
    assert.ok(fs.existsSync(stored), '附件应落盘到 <data>/attachments/')
    assert.equal(fs.readFileSync(stored).length, PNG_1PX.length)

    // 能取回图片本身
    const img = await fetch(`${base}${body.url}`)
    assert.equal(img.status, 200)
    assert.equal((await img.arrayBuffer()).byteLength, PNG_1PX.length)

    // 非法输入
    assert.equal((await upload(base, PNG_1PX, 'text/plain')).status, 400)
    assert.equal((await upload(base, Buffer.from('not an image'), 'image/png')).status, 400)
    assert.equal((await fetch(`${base}/api/attachments/..%2F..%2Fchats%2Fx.json`)).status, 400)
    assert.equal((await fetch(`${base}/api/attachments/no-such-file.png`)).status, 404)

    // 被拒的请求不应留下任何文件
    const leftovers = fs.existsSync(path.join(tmpData, 'attachments'))
      ? fs.readdirSync(path.join(tmpData, 'attachments')).length
      : 0
    assert.equal(leftovers, 1, '只应有成功上传的那一份')
  } finally {
    await stopServer()
  }
})
