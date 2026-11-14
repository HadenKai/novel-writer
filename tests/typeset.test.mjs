// 一键排版回归测试
//
// 背景（原实现的真 BUG）：成书页的「一键排版」只在前端对当前章的草稿做了
// 「去行首行尾空格 + 压缩连续空行」，而正常录入或 AI 生成的正文本来就满足这些条件，
// 因此点了几乎没有任何变化；即使有变化，也只留在未保存的草稿里，切章就被覆盖，
// 作者看到的就是「点了没用」。
//
// 本测试锁定：排版必须真正改变正文版式（段落首行缩进、段间空一行、清理多余空白），
// 必须由服务端落库，可只排一章也可排全书，并且是幂等的（重复点击不会重复叠加缩进）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-typeset-'))
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

const INDENT = '\u3000\u3000'

/** 与后端一致：短、以「第N章」开头、且不含句读的行才算章节标题行 */
const isHeadingLine = p =>
  p.length <= 30 && /^第\s*[0-9零一二三四五六七八九十百千两]+\s*[章节回]/.test(p) && !/[。！？，；]/.test(p)

/** 逐段检查版式：每段恰好多两格缩进、无行尾空格、无三行以上连续空行 */
function assertTypeset(content, label) {
  assert.ok(!/[ \t\u3000]$/m.test(content), `${label}：不应有行尾空白`)
  assert.ok(!/\n{3,}/.test(content), `${label}：不应有三行以上连续空行`)
  assert.ok(!content.startsWith('\n') && !content.endsWith('\n'), `${label}：不应以空行开头或结尾`)
  const paras = content.split('\n').filter(line => line.trim())
  assert.ok(paras.length > 0, `${label}：正文不应为空`)
  for (const p of paras) {
    if (isHeadingLine(p)) {
      assert.ok(!p.startsWith('\u3000'), `${label}：章节标题行不应缩进：${p.slice(0, 20)}`)
      continue
    }
    assert.ok(p.startsWith(INDENT), `${label}：段落应有两格首行缩进：${p.slice(0, 20)}`)
    assert.ok(!p.startsWith(INDENT + '\u3000'), `${label}：缩进不应重复叠加：${p.slice(0, 20)}`)
    assert.ok(!/^[ \t]/.test(p.slice(2)), `${label}：缩进后不应残留半角空格：${p.slice(0, 20)}`)
  }
}

test('一键排版：真正改变版式、落库、可指定范围且幂等', { timeout: 60000 }, async () => {
  const port = await app.startServer(0)
  base = `http://127.0.0.1:${port}`
  try {
    const created = await j('/api/novels', 'POST', { title: '排版测试书', genre: '都市' })
    assert.equal(created.status, 201)
    const id = created.data.id

    // 刻意做成不合版式的正文：行首半角空格、行尾空白、三行以上连续空行、只有空白字符的行
    const rawText = [
      '第1章 初雪',
      '　　　　',
      '  这是开头段，行首有半角空格。   ',
      '',
      '',
      '',
      '这是第二段。',
      '',
      '第2章 夜谈',
      '夜谈的第一段。',
      '',
      '第3章 归途',
      '归途段。'
    ].join('\n')

    const imported = await j(`/api/novels/${id}/import`, 'POST', { text: rawText, replace: false })
    assert.equal(imported.status, 200, `导入应成功：${JSON.stringify(imported.data)}`)

    const before = await j(`/api/novels/${id}`)
    assert.equal((before.data.chapters || []).length, 3)
    const firstBefore = before.data.chapters[0].content
    assert.ok(firstBefore.includes('  '), '导入的正文应当带着待清理的多余空白')

    // ---------- 1. 全书排版：每一章都要真的被改动并落库 ----------
    const all = await j(`/api/novels/${id}/typeset`, 'POST', { indent: 2 })
    assert.equal(all.status, 200)
    assert.equal(all.data.changed, 3, '全书排版应改动 3 章')
    assert.equal(all.data.indent, 2)

    const after = await j(`/api/novels/${id}`)
    for (const c of after.data.chapters) {
      assert.notEqual(
        c.content,
        before.data.chapters.find(x => x.index === c.index).content,
        `第${c.index}章应真的变了`
      )
      assertTypeset(c.content, `第${c.index}章`)
      // 字数统计忽略空白，缩进不应改变字数
      assert.equal(
        c.words,
        before.data.chapters.find(x => x.index === c.index).words,
        `第${c.index}章字数不应因缩进变化`
      )
    }
    // 排版前必须留档，作者可回滚
    const history = await j(`/api/novels/${id}/history`)
    assert.ok(
      (history.data || []).some(h => String(h.label).includes('一键排版')),
      '排版前应写入版本历史'
    )

    // ---------- 2. 幂等：已经排过版的书再点一次不应有任何变化 ----------
    const again = await j(`/api/novels/${id}/typeset`, 'POST', { indent: 2 })
    assert.equal(again.status, 200)
    assert.equal(again.data.changed, 0, '已排版的正文不应被重复改动')
    assert.equal(again.data.unchanged, true)

    // ---------- 3. 只排一章：其他章必须原样不动 ----------
    const second = after.data.chapters.find(c => c.index === 2)
    const dirty = '第2章 夜谈\n\n   这段是后来粘进来的，格式是乱的。   \n\n\n\n第二段。'
    const saved = await j(`/api/novels/${id}/chapters/2`, 'PUT', { title: second.title, content: dirty })
    assert.equal(saved.status, 200)

    const one = await j(`/api/novels/${id}/typeset`, 'POST', { chapterIndex: 2, indent: 2 })
    assert.equal(one.status, 200)
    assert.equal(one.data.changed, 1, '只指定第 2 章时不应改动其他章')

    const afterOne = await j(`/api/novels/${id}`)
    assertTypeset(afterOne.data.chapters.find(c => c.index === 2).content, '第2章')
    assert.equal(
      afterOne.data.chapters.find(c => c.index === 1).content,
      after.data.chapters.find(c => c.index === 1).content,
      '未指定的第 1 章不应被改动'
    )

    // ---------- 4. 正文里的章节标题行不缩进 ----------
    assert.ok(
      afterOne.data.chapters.find(c => c.index === 2).content.startsWith('第2章 夜谈'),
      '正文里的章节标题行不应被加上缩进'
    )

    // ---------- 5. 不存在的章号给出明确错误 ----------
    const missing = await j(`/api/novels/${id}/typeset`, 'POST', { chapterIndex: 99 })
    assert.equal(missing.status, 404)
    assert.match(String(missing.data?.error || ''), /第 99 章|不存在/)
  } finally {
    await app.stopServer()
  }
})

test('一键排版：indent=0 时只规范空白，不加缩进', { timeout: 60000 }, async () => {
  // 上个用例已 stopServer；这里复用同一数据目录重新启动（实例锁已释放）
  const port = await app.startServer(0)
  base = `http://127.0.0.1:${port}`
  try {
    const created = await j('/api/novels', 'POST', { title: '无缩进排版', genre: '都市' })
    const id = created.data.id
    await j(`/api/novels/${id}/import`, 'POST', {
      text: '第1章 起\n\n  开头段。   \n\n\n\n第二段。',
      replace: false
    })

    const r = await j(`/api/novels/${id}/typeset`, 'POST', { indent: 0 })
    assert.equal(r.status, 200)
    assert.equal(r.data.changed, 1)
    const after = await j(`/api/novels/${id}`)
    const content = after.data.chapters[0].content
    assert.equal(content, '开头段。\n\n第二段。', 'indent=0 只应清理空白')
    assert.ok(!content.includes('\u3000'), '不应插入全角缩进')
  } finally {
    await app.stopServer()
  }
})
