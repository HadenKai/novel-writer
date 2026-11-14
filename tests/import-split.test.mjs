// 导入切章的回归测试
//
// 背景（原实现的真 BUG）：章节标题识别只看「行里有第N章 + 行不长」，
// 于是正文里一句「第二章的第一段。」会被当成新章标题，原章正文落进空块后被丢弃——
// 作者看到的是「导入 3 章只进来 1 章」，内容凭空少了。
//
// 本测试锁定：正文句不会被误判成标题、导入内容不丢、标题不再重复带章号。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-import-split-'))
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

test('导入切章：正文句不误判、内容不丢、标题不重复带章号', { timeout: 60000 }, async () => {
  const port = await app.startServer(0)
  base = `http://127.0.0.1:${port}`
  try {
    const created = await j('/api/novels', 'POST', { title: '导入切章测试', genre: '都市' })
    const id = created.data.id

    // 正文里刻意出现以「第X章」开头的句子：这是旧实现会切错、丢内容的地方
    const text = [
      '第1章 初雪',
      '第二章的第一段。',
      '',
      '第三章里有三个人在等她。',
      '',
      '第2章 夜谈',
      '第二章的内容照旧。',
      '',
      '第3章 归途',
      '归途段。'
    ].join('\n')

    const imported = await j(`/api/novels/${id}/import`, 'POST', { text, replace: true })
    assert.equal(imported.status, 200, `导入应成功：${JSON.stringify(imported.data)}`)
    assert.equal(imported.data.chapters, 3, '应识别为 3 章，正文句不算章节标题')

    const nv = await j(`/api/novels/${id}`)
    const chapters = nv.data.chapters || []
    assert.equal(chapters.length, 3)

    // 正文一句都不能少：旧实现会把「第二章的第一段。」这类行当标题丢掉
    assert.match(chapters[0].content, /第二章的第一段。/, '第 1 章正文不能丢')
    assert.match(chapters[0].content, /第三章里有三个人在等她。/, '以章号开头的正文句不能丢')
    assert.match(chapters[1].content, /第二章的内容照旧。/, '第 2 章正文不能丢')
    assert.match(chapters[2].content, /归途段。/, '第 3 章正文不能丢')

    // 标题不再重复带章号（列表里会显示成「第 1 章 初雪」而不是「第 1 章 第1章 初雪」）
    assert.equal(chapters[0].title, '初雪')
    assert.equal(chapters[1].title, '夜谈')
    assert.equal(chapters[2].title, '归途')
    // 大纲标题同步
    assert.equal(nv.data.outline[0].title, '初雪')

    // 章号自成一行的写法仍然要认（不许把标题识别改得过严）
    const again = await j(`/api/novels/${id}/import`, 'POST', {
      text: ['第一章', '甲段。', '', '第二章', '乙段。'].join('\n'),
      replace: true
    })
    assert.equal(again.data.chapters, 2, '「第一章」独占一行的写法仍应被识别')
    const nv2 = await j(`/api/novels/${id}`)
    assert.equal(nv2.data.chapters[0].title, '第一章', '纯章号标题去掉后会变空，应回落到原标题')
  } finally {
    await app.stopServer()
  }
})
