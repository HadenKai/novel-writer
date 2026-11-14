import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

// 用独立数据目录跑 API 冒烟测试，避免污染项目 data/
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-api-test-'))
process.env.NOVEL_DATA_DIR = tmpData

const sampleFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-ref-files-'))
fs.writeFileSync(
  path.join(sampleFolder, 'sample.txt'),
  '第一章 开局\n林晚站在雨夜的巷口，雨水顺着她苍白的脸颊滑落。她是一名刑警队法医，冷静而敏锐。\n第二章 交锋\n刑警队长沈修言推门而入，眼神冷峻。两人对视，空气中仿佛有火花。\n沈修言问道："你为什么要隐瞒那具尸体的死因？"\n林晚没有回答，只是低头看着自己沾满血迹的手套。',
  'utf8'
)
// GBK 编码文件（"你好" 重复 70 次，超过 100 字阈值），验证扫描能正确解码
fs.writeFileSync(
  path.join(sampleFolder, 'gbk-novel.txt'),
  Buffer.concat(Array.from({ length: 70 }, () => Buffer.from([0xc4, 0xe3, 0xba, 0xc3])))
)

const { startServer, stopServer, decodeRefText } = await import('../server/app.mjs')

const analysis = {
  characters: [
    {
      name: '林晚',
      role: '主角',
      personality: '冷静理智',
      appearance: '苍白脸颊',
      background: '刑警队法医',
      notes: ''
    },
    { name: '沈修言', role: '配角', personality: '冷峻', appearance: '', background: '刑警队长', notes: '' }
  ],
  plotEvents: '核心事件：雨夜法医鉴定、针锋相对的对峙',
  plotSummary: '法医与刑警队长联手侦破连环案件',
  worldBuilding: '现代都市刑侦世界',
  writingStyle: '短句、冷峻氛围',
  keyRelationships: '林晚与沈修言亦敌亦友',
  themes: '真相与救赎'
}

test('decodeRefText：UTF-8 直接解码，GBK 字节回退 gb18030，纯 ASCII 兼容', () => {
  // UTF-8 正常文本原样输出
  assert.equal(decodeRefText(Buffer.from('第一章 开局', 'utf8')), '第一章 开局')
  // GBK 编码的「你好」（0xC4E3 0xBAC3）不是合法 UTF-8 => 回退 GB18030，得到「你好」
  assert.equal(decodeRefText(Buffer.from([0xc4, 0xe3, 0xba, 0xc3])), '你好')
  // 纯 ASCII 两种编码结果一致
  assert.equal(decodeRefText(Buffer.from('Chapter One', 'ascii')), 'Chapter One')
})

test('参考作品 API：建书带文件夹 → 扫描 → 分析合并 → 去重', { timeout: 30000 }, async () => {
  const port = await startServer(0)
  const base = `http://127.0.0.1:${port}`
  const novel = await (
    await fetch(`${base}/api/novels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '测试同人文', genre: '同人', folderPath: sampleFolder })
    })
  ).json()
  assert.equal(novel.folderPath, sampleFolder)

  const scan = await (
    await fetch(`${base}/api/novels/${novel.id}/scan-folder`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderPath: sampleFolder })
    })
  ).json()
  assert.equal(scan.ok, true)
  assert.equal(scan.count, 2) // sample.txt + gbk-novel.txt
  assert.ok(scan.files.some(f => f.name.endsWith('.txt')))
  const gbkFile = scan.files.find(f => f.name === 'gbk-novel.txt')
  assert.ok(gbkFile)
  assert.equal(gbkFile.preview.includes('\uFFFD'), false) // GBK 未被当作 UTF-8 乱码
  assert.ok(gbkFile.preview.includes('你好'))

  const bad = await fetch(`${base}/api/novels/${novel.id}/scan-folder`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folderPath: 'Z:/does/not/exist' })
  })
  assert.equal(bad.status, 400)

  const applied = await (
    await fetch(`${base}/api/novels/${novel.id}/apply-analysis`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ analysis })
    })
  ).json()
  assert.equal(applied.novel.protagonist.name, '林晚')
  assert.ok(applied.novel.characters.some(c => c.name === '沈修言'))
  assert.ok(applied.novel.worldview.includes('现代都市刑侦'))
  assert.ok(applied.novel.elements.includes('核心事件'))
  assert.ok(applied.novel.extraRequirements.includes('真相与救赎'))

  const applied2 = await (
    await fetch(`${base}/api/novels/${novel.id}/apply-analysis`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ analysis })
    })
  ).json()
  assert.equal(1 + applied2.novel.characters.length, 2) // 主角 + 唯一配角，不重复

  const list = await (await fetch(`${base}/api/novels`)).json()
  assert.equal(list.find(n => n.id === novel.id)?.folderPath, sampleFolder)

  await fetch(`${base}/api/novels/${novel.id}`, { method: 'DELETE' })
})

test.after(async () => {
  await stopServer()
  try {
    fs.rmSync(tmpData, { recursive: true, force: true })
  } catch {}
  try {
    fs.rmSync(sampleFolder, { recursive: true, force: true })
  } catch {}
})
