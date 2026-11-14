// 人物照片：上传只落盘并回传文件名；文件名写进 character.portrait 后随设定保存、可取回。
// 同时守住：非法输入被拒、路径穿越被拒、整书 PUT 不会丢掉 portrait 字段。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-portrait-test-'))
process.env.NOVEL_DATA_DIR = tmpData

const { startServer, stopServer } = await import('../server/app.mjs')

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
)

const upload = (base, buf, type) =>
  fetch(`${base}/api/portraits`, { method: 'POST', headers: { 'Content-Type': type }, body: buf })
const json = (base, url, method, body) =>
  fetch(`${base}${url}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

test('人物照片：上传 → 写进人物设定 → 保存后可取回；非法输入被拒', { timeout: 30000 }, async () => {
  const port = await startServer(0)
  const base = `http://127.0.0.1:${port}`
  try {
    const up = await upload(base, PNG_1PX, 'image/png')
    assert.equal(up.status, 200)
    const { ok, file } = await up.json()
    assert.equal(ok, true)
    assert.match(file, /^[A-Za-z0-9_-]{1,64}\.png$/, '文件名应由服务端生成')
    assert.ok(fs.existsSync(path.join(tmpData, 'portraits', file)), '照片应落盘到 <data>/portraits/')

    const img = await fetch(`${base}/api/portraits/${file}`)
    assert.equal(img.status, 200)
    assert.equal((await img.arrayBuffer()).byteLength, PNG_1PX.length)

    // 写进主角与配角，整书 PUT 后字段原样保留
    const novel = await (await json(base, '/api/novels', 'POST', { title: '照片测试书', genre: '奇幻' })).json()
    const cast = [
      { id: 'c1', name: '配角甲', role: '', personality: '', appearance: '', background: '', notes: '', portrait: file }
    ]
    const put = await json(base, `/api/novels/${novel.id}`, 'PUT', {
      id: novel.id,
      protagonist: { ...novel.protagonist, name: '沈砚', portrait: file },
      characters: cast
    })
    assert.equal(put.status, 200)
    const saved = await (await fetch(`${base}/api/novels/${novel.id}`)).json()
    assert.equal(saved.protagonist.portrait, file)
    assert.equal(saved.characters[0].portrait, file)

    // 非法输入
    assert.equal((await upload(base, PNG_1PX, 'text/plain')).status, 400)
    assert.equal((await upload(base, Buffer.from('not an image'), 'image/png')).status, 400)
    assert.equal((await fetch(`${base}/api/portraits/..%2F..%2Fnovels%2Fx.json`)).status, 400)
    assert.equal((await fetch(`${base}/api/portraits/no-such-file.png`)).status, 404)
    assert.equal(fs.readdirSync(path.join(tmpData, 'portraits')).length, 1, '被拒的请求不应留下文件')
  } finally {
    await stopServer()
  }
})
