// 第二轮工业级加固的回归测试：锁定「曾经会静默丢数据」的路径
//
//  1. 导入不再丢弃第一个章节标题之前的无题正文（序言/前言）
//  2. 整书 PUT：客户端带全 oid 的过期快照不得抹掉服务端新追加的大纲行
//  3. syncChapterIndices 章号冲突顺延标记孤立，绝不静默删章
//  4. 敏感词纯 ASCII 词整词匹配（"small" 不误报，独立 "SM" 要报）
//  5. 备份恢复先落一份 pre_restore.json 快照（恢复不再是不可逆操作）
//  6. 删除模型后，引用它的作品回落默认模型（且走文件队列不盖别的在途事务）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-hardening-'))
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

async function createNovel(title) {
  const { status, data } = await j('/api/novels', 'POST', { title, genre: '测试' })
  assert.equal(status, 201)
  return data.id
}

test('hardening server', { timeout: 120000 }, async t => {
  const port = await startServer(0)
  base = `http://127.0.0.1:${port}`
  t.after(() => stopServer())

  await t.test('导入保留第一个标题之前的无题正文', async () => {
    const id = await createNovel('序言不丢')
    const preamble = '这是没有任何章节标题的楔子正文，讲的是世界观引子。'
    const text = `${preamble}\n\n第一章 起风了\n\n${'山风吹过山谷。'.repeat(10)}\n\n第二章 落雪时\n\n${'少年抬头望天。'.repeat(10)}`
    const r = await j(`/api/novels/${id}/import`, 'POST', { text, replace: true })
    assert.equal(r.status, 200)
    assert.equal(r.data.chapters, 3, '无题块也要成章，不能被 filter 丢掉')
    const novel = await j(`/api/novels/${id}`)
    const all = novel.data.chapters.map(c => c.content).join('\n')
    assert.ok(all.includes('楔子正文'), '序言内容必须入库')
  })

  await t.test('整书 PUT 不过期覆盖服务端新追加大纲 + 章号冲突不删章', async () => {
    const id = await createNovel('大纲守护')
    const n0 = await j(`/api/novels/${id}`)
    const novel = n0.data
    novel.outline = [
      { index: 1, title: '第一章', summary: '', oid: 'aaaaaaaa-0000-0000-0000-000000000001' },
      { index: 2, title: '第二章', summary: '', oid: 'aaaaaaaa-0000-0000-0000-000000000002' }
    ]
    await j(`/api/novels/${id}`, 'PUT', novel)
    // 模拟：后台任务追加了第三章大纲行（新 oid），客户端仍拿着只有两行的旧快照（且行行带 oid）
    const n1 = await j(`/api/novels/${id}`)
    const serverSide = JSON.parse(JSON.stringify(n1.data))
    serverSide.outline.push({ index: 3, title: '第三章', summary: '', oid: 'bbbbbbbb-0000-0000-0000-000000000003' })
    await j(`/api/novels/${id}`, 'PUT', serverSide)
    const staleClient = JSON.parse(JSON.stringify(n1.data))
    const r = await j(`/api/novels/${id}`, 'PUT', staleClient)
    assert.equal(r.status, 200)
    assert.equal(r.data.outline.length, 3, '任务刚追加的行不能被带全 oid 的过期快照抹掉')

    // 章号冲突：两条大纲行指向同一个 index（AI 追加/重排都可能造出这种数据），
    // 绑定其下的两章正文必须都活着——后来者顺延为新章号并标记孤立，绝不静默删除
    const imp = await j(`/api/novels/${id}/import`, 'POST', {
      text: `第1章 甲\n\n正文甲正文甲\n\n第2章 乙\n\n正文乙正文乙`,
      replace: true
    })
    assert.equal(imp.status, 200)
    const n2 = (await j(`/api/novels/${id}`)).data
    assert.equal(n2.chapters.length, 2)
    n2.outline = n2.outline.map(o => ({ ...o, index: 1 }))
    const r2 = await j(`/api/novels/${id}`, 'PUT', n2)
    assert.equal(r2.status, 200)
    const kept = r2.data.chapters.filter(c => c.content && c.content.includes('正文'))
    assert.equal(kept.length, 2, '章号撞车时两章正文都必须保留')
    assert.ok(
      kept.some(c => c.orphan),
      '后来者应被标记孤立'
    )
  })

  await t.test('敏感词 ASCII 整词匹配', async () => {
    const r = await j('/api/analysis/sensitive', 'POST', {
      items: [
        { key: '1', label: '第一章', text: 'He spoke in a small voice, then played SM all night.' },
        { key: '2', label: '第二章', text: '这个办法很smart，也符合some原则' }
      ]
    })
    assert.equal(r.status, 200)
    const g1 = r.data.groups.find(g => g.key === '1')
    const g2 = r.data.groups.find(g => g.key === '2')
    assert.ok(g1.count >= 1, '独立出现的 SM 必须命中')
    assert.equal(g2.count, 0, 'small/smart/some 不得误报')
  })

  await t.test('备份恢复前先落 pre_restore 快照', async () => {
    const id = await createNovel('恢复有退路')
    const cur = await j('/api/backup')
    const payload = cur.data
    payload.novels.push({
      id,
      title: '被旧备份覆盖的书',
      genre: 'x',
      chapters: [{ index: 1, title: '旧', content: '旧内容旧内容', words: 6, status: 'done' }],
      outline: []
    })
    const r = await j('/api/backup/restore', 'POST', payload)
    assert.equal(r.status, 200)
    const guard = path.join(tmpData, 'backups', 'pre_restore.json')
    assert.ok(fs.existsSync(guard), '恢复必须留下恢复前快照')
    const saved = JSON.parse(fs.readFileSync(guard, 'utf8'))
    assert.ok(Array.isArray(saved.novels))
  })

  await t.test('删除模型后作品回落默认模型', async () => {
    const id = await createNovel('模型绑定')
    const m = await j('/api/models', 'POST', {
      name: '待删模型',
      baseUrl: 'https://api.example.com',
      apiKey: 'sk-test-123456',
      model: 'gpt-test'
    })
    assert.equal(m.status, 201)
    const modelId = m.data.id
    await j(`/api/novels/${id}/prefs`, 'PUT', { modelId })
    const d = await j(`/api/models/${modelId}`, 'DELETE')
    assert.equal(d.status, 200)
    const novel = await j(`/api/novels/${id}`)
    assert.equal(novel.data.modelId, '', '引用已删模型的作品必须被回落')
  })
})
