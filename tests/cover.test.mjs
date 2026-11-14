// 作品封面：上传 / 读取 / 移除，以及各类非法输入的拒绝路径。
//
// 封面走**原始二进制**（Content-Type: image/*）而不是 JSON + data:URL：
// 全局 express.json() 的默认上限只有 100KB，用 data:URL 传 5MB 封面会在进路由前
// 就被 413 拦掉（这是实现时踩到的真问题，用这个测试把它钉住）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

// 独立数据目录，避免污染项目 data/
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-cover-test-'))
process.env.NOVEL_DATA_DIR = tmpData

const { startServer, stopServer } = await import('../server/app.mjs')

// 1x1 透明 PNG：最小合法图片，足够验证「落盘 + 取回 + 魔数校验放行」
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
)

const jsonPost = (base, url, body) =>
  fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

const uploadCover = (base, id, buf, type) =>
  fetch(`${base}/api/novels/${id}/cover`, { method: 'POST', headers: { 'Content-Type': type }, body: buf })

test('作品封面：上传落盘 → 列表可读 → 可取回 → 移除后清理', { timeout: 30000 }, async () => {
  const port = await startServer(0)
  const base = `http://127.0.0.1:${port}`
  try {
    const novel = await (await jsonPost(base, '/api/novels', { title: '封面测试书', genre: '奇幻' })).json()

    // 初始没有封面
    let list = await (await fetch(`${base}/api/novels`)).json()
    assert.equal(list[0].coverFile, '')
    assert.equal(list[0].coverAt, 0)

    const up = await uploadCover(base, novel.id, PNG_1PX, 'image/png')
    assert.equal(up.status, 200)
    const upBody = await up.json()
    assert.equal(upBody.novel.coverFile, `${novel.id}.png`)
    assert.ok(upBody.novel.coverAt > 0, '应记录上传时间戳供前端做缓存失效')

    // 确实落在 <data>/covers/ 下，且字节一致
    const stored = path.join(tmpData, 'covers', `${novel.id}.png`)
    assert.ok(fs.existsSync(stored), '封面文件应落盘到 <data>/covers/')
    assert.equal(fs.readFileSync(stored).length, PNG_1PX.length)

    // 书架列表带上封面信息（首页据此渲染封面卡片）
    list = await (await fetch(`${base}/api/novels`)).json()
    assert.equal(list[0].coverFile, `${novel.id}.png`)

    // 能取回图片本身
    const img = await fetch(`${base}/api/covers/${novel.id}.png`)
    assert.equal(img.status, 200)
    assert.equal((await img.arrayBuffer()).byteLength, PNG_1PX.length)

    // 文件名白名单：目录穿越被拒
    assert.equal((await fetch(`${base}/api/covers/..%2F..%2Fnovels%2Fx.json`)).status, 400)

    // 移除：字段与文件一起清理
    assert.equal((await fetch(`${base}/api/novels/${novel.id}/cover`, { method: 'DELETE' })).status, 200)
    assert.equal(fs.existsSync(stored), false, '移除后封面文件应被删掉')
    list = await (await fetch(`${base}/api/novels`)).json()
    assert.equal(list[0].coverFile, '')
  } finally {
    await stopServer()
  }
})

test('作品封面：非图片 / 伪装图片 / 超限 / 作品不存在都被拒', { timeout: 30000 }, async () => {
  const port = await startServer(0)
  const base = `http://127.0.0.1:${port}`
  try {
    const novel = await (await jsonPost(base, '/api/novels', { title: '校验书', genre: '都市' })).json()

    // 不支持的 Content-Type
    assert.equal((await uploadCover(base, novel.id, PNG_1PX, 'text/plain')).status, 400)
    // 声称是 PNG、内容却不是图片 → 魔数校验拦下
    assert.equal((await uploadCover(base, novel.id, Buffer.from('definitely not an image'), 'image/png')).status, 400)
    // 作品不存在
    assert.equal((await uploadCover(base, 'no-such-book', PNG_1PX, 'image/png')).status, 404)
    // 超过 5MB → express.raw 直接返回 413
    const oversize = Buffer.concat([PNG_1PX, Buffer.alloc(5 * 1024 * 1024)])
    assert.equal((await uploadCover(base, novel.id, oversize, 'image/png')).status, 413)

    // 被拒的请求不应留下任何文件
    assert.equal(fs.existsSync(path.join(tmpData, 'covers', `${novel.id}.png`)), false)
  } finally {
    await stopServer()
  }
})
