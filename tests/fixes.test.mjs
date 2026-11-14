// 本轮修复的回归测试：锁定四个「曾经会静默出错」的路径
//
//  1. 整书 PUT 重排 / 中间插入大纲行时，章节正文必须跟着自己的 oid 走。
//     旧实现让 normalizeNovel 按 index 回填 oid，重排后「开端」那一行会显示别人的正文。
//  2. 备份恢复支持超过全局 20mb 上限的备份——自己的备份必须能恢复回来。
//  3. 彻底删除回收站条目后，源目录不得留下带完整正文的 .bak。
//  4. 启动维护清掉无主 .bak（主文件已不存在），但保留有主 .bak（崩溃恢复的退路）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-fixes-'))
process.env.NOVEL_DATA_DIR = tmpData
fs.mkdirSync(path.join(tmpData, 'novels'), { recursive: true })

// 必须在 startServer 之前埋好：启动维护 3 秒后扫一次
const ORPHAN_BAK = path.join(tmpData, 'novels', 'orphan-novel.json.bak')
const KEPT_BAK = path.join(tmpData, 'novels', 'kept-novel.json.bak')
fs.writeFileSync(ORPHAN_BAK, '{"id":"orphan-novel","title":"已消失的书"}', 'utf8')
fs.writeFileSync(
  path.join(tmpData, 'novels', 'kept-novel.json'),
  '{"id":"kept-novel","title":"保留的书","chapters":[],"outline":[]}',
  'utf8'
)
fs.writeFileSync(KEPT_BAK, '{"id":"kept-novel","title":"保留的书·旧版"}', 'utf8')

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

const novelFile = id => path.join(tmpData, 'novels', `${id}.json`)
const readNovelFile = id => JSON.parse(fs.readFileSync(novelFile(id), 'utf8'))

async function createNovel(title) {
  const { status, data } = await j('/api/novels', 'POST', { title, genre: '测试' })
  assert.equal(status, 201)
  return data.id
}

/**
 * 落三行大纲 + 三章正文，返回带 oid 的大纲行。
 * 章节正文只能由生成任务或导入产生（PUT /chapters/:index 只改已存在的章），
 * 所以这里直接按存储格式写入作品文件——与真实落库结果一致。
 */
async function seedThreeChapters(id) {
  const bodies = ['正文甲', '正文乙', '正文丙']
  const file = path.join(tmpData, 'novels', `${id}.json`)
  const novel = JSON.parse(fs.readFileSync(file, 'utf8'))
  const outline = [
    { index: 1, title: '开端', oid: `oid-${id}-1` },
    { index: 2, title: '发展', oid: `oid-${id}-2` },
    { index: 3, title: '高潮', oid: `oid-${id}-3` }
  ]
  novel.outline = outline
  novel.chapters = outline.map((o, i) => ({
    index: o.index,
    title: o.title,
    oid: o.oid,
    content: bodies[i],
    words: bodies[i].length,
    status: 'done'
  }))
  fs.writeFileSync(file, JSON.stringify(novel, null, 2), 'utf8')

  const back = (await j(`/api/novels/${id}`)).data
  assert.equal(back.outline.length, 3, '前置条件：三行大纲')
  assert.equal(back.chapters.length, 3, '前置条件：三章正文')
  assert.ok(
    back.outline.every(o => o.oid),
    '前置条件：大纲行带 oid'
  )
  return back.outline
}

test('fixes server', { timeout: 180000 }, async t => {
  const port = await startServer(0)
  base = `http://127.0.0.1:${port}`
  t.after(() => stopServer())

  await t.test('启动维护清无主 .bak，保留有主 .bak', async () => {
    const deadline = Date.now() + 20000
    while (fs.existsSync(ORPHAN_BAK) && Date.now() < deadline) await new Promise(r => setTimeout(r, 200))
    assert.ok(!fs.existsSync(ORPHAN_BAK), '主文件已不存在的 .bak 必须被清理，否则删掉的书正文会长期留在 data/')
    assert.ok(fs.existsSync(KEPT_BAK), '主文件仍在时 .bak 是崩溃恢复的退路，不得删除')
    const isolated = fs.readdirSync(path.join(tmpData, 'recovery-orphans', 'novels'))
    assert.ok(
      isolated.some(name => name.endsWith('orphan-novel.json.bak')),
      '孤立恢复副本必须隔离保留，而不是永久删除'
    )
  })

  await t.test('大纲上下移后正文跟着自己的 oid 走', async () => {
    const id = await createNovel('重排不错配')
    const rows = await seedThreeChapters(id)

    // 上移第二行：开端 ↔ 发展 换位
    const swapped = [rows[1], rows[0], rows[2]].map(o => ({ oid: o.oid, title: o.title }))
    const r = await j(`/api/novels/${id}`, 'PUT', { id, outline: swapped })
    assert.equal(r.status, 200)

    const novel = (await j(`/api/novels/${id}`)).data
    const byIndex = [...novel.chapters].sort((a, b) => a.index - b.index)
    assert.deepEqual(
      byIndex.map(c => c.content),
      ['正文乙', '正文甲', '正文丙'],
      '重排后正文必须跟着 oid 走，不能按 index 错配'
    )
    assert.deepEqual(
      byIndex.map(c => c.title),
      ['发展', '开端', '高潮'],
      '标题也要跟着 oid 走'
    )
    assert.ok(!(novel.warnings || []).length, '正常重排不应产生孤立章告警')
  })

  await t.test('中间插入大纲行不串位', async () => {
    const id = await createNovel('插入不错配')
    const rows = await seedThreeChapters(id)

    // 在第 2 位插入一行新大纲（无 oid），后面两行顺延
    const withNew = [rows[0], { index: 2, title: '新插入章' }, rows[1], rows[2]].map(o => ({
      oid: o.oid,
      title: o.title
    }))
    const r = await j(`/api/novels/${id}`, 'PUT', { id, outline: withNew })
    assert.equal(r.status, 200)

    const novel = (await j(`/api/novels/${id}`)).data
    const byIndex = [...novel.chapters].sort((a, b) => a.index - b.index)
    assert.deepEqual(
      byIndex.map(c => c.content),
      ['正文甲', '正文乙', '正文丙'],
      '插入后三章正文顺序不变'
    )
    assert.deepEqual(
      byIndex.map(c => c.index),
      [1, 3, 4],
      '新行占住 2，原有三章顺延到 1/3/4'
    )
    assert.ok(
      byIndex.every(c => !c.orphan),
      '插入不是删除，不得把原有章节标记为孤立'
    )
    assert.ok(!novel.chapters.some(c => c.index === 2), '新插入的行此时还没有正文')
  })

  await t.test('改大纲标题会同步到正文，但手改过的标题不被覆盖', async () => {
    const id = await createNovel('标题同步')
    const rows = await seedThreeChapters(id)
    const snap = () =>
      readNovelFile(id).chapters.map(c => ({ index: c.index, oid: c.oid, title: c.title, content: c.content }))

    // ① 只改第一行标题 → 第一章正文标题同步
    const renamed = rows.map(o => ({ oid: o.oid, title: o.oid === rows[0].oid ? '开端·改' : o.title }))
    assert.equal((await j(`/api/novels/${id}`, 'PUT', { id, outline: renamed, chapters: snap() })).status, 200)
    let novel = (await j(`/api/novels/${id}`)).data
    let byIndex = [...novel.chapters].sort((a, b) => a.index - b.index)
    assert.equal(byIndex[0].title, '开端·改', '改大纲标题要同步到正文')
    assert.equal(byIndex[1].title, '发展', '没改的行不得被顺手改掉')

    // ② 章节标题一旦与所属大纲行不同（作者自己定的、或历史数据分叉），再改大纲不得冲掉它。
    //    保护条件是「章节标题仍等于该行旧标题」，所以这里先造出分叉状态。
    const file = novelFile(id)
    const raw = readNovelFile(id)
    raw.chapters = raw.chapters.map(c => (c.oid === rows[1].oid ? { ...c, title: '我自己起的标题' } : c))
    fs.writeFileSync(file, JSON.stringify(raw, null, 2), 'utf8')

    const renamed2 = renamed.map(o => ({ oid: o.oid, title: o.oid === rows[1].oid ? '发展·改' : o.title }))
    assert.equal((await j(`/api/novels/${id}`, 'PUT', { id, outline: renamed2 })).status, 200)
    novel = (await j(`/api/novels/${id}`)).data
    byIndex = [...novel.chapters].sort((a, b) => a.index - b.index)
    assert.equal(byIndex[1].title, '我自己起的标题', '作者自己定的标题不得被大纲改名冲掉')
    assert.equal(byIndex[1].content, '正文乙', '正文不受影响')
    assert.equal(byIndex[0].title, '开端·改', '同一批次里该同步的行仍要同步')

    // ③ 整书 PUT 不接受客户端 chapters（chapters 不在可编辑白名单里），
    //    所以陈旧快照永远无法用旧标题盖掉服务端标题——这里显式锁住这个不变量。
    assert.equal(
      (
        await j(`/api/novels/${id}`, 'PUT', {
          id,
          chapters: [{ index: 2, oid: rows[1].oid, title: '陈旧标题', content: '陈旧正文' }]
        })
      ).status,
      200
    )
    novel = (await j(`/api/novels/${id}`)).data
    byIndex = [...novel.chapters].sort((a, b) => a.index - b.index)
    assert.equal(byIndex[1].title, '我自己起的标题', '客户端提交的 chapters 必须被忽略')
    assert.equal(byIndex[1].content, '正文乙', '正文更不能被客户端快照覆盖')
  })

  await t.test('超过 20mb 的备份能恢复回来', async () => {
    const big = 'x'.repeat(21 * 1024 * 1024)
    const payload = {
      version: 2,
      novels: [
        {
          id: 'big-restore-1',
          title: '大备份',
          outline: [{ index: 1, title: '第1章' }],
          chapters: [{ index: 1, title: '第1章', content: big, status: 'done' }]
        }
      ]
    }
    const r = await j('/api/backup/restore', 'POST', payload)
    assert.equal(r.status, 200, '自己导出的备份必须能恢复回来，不能卡在全局 body 上限上')
    assert.equal(r.data.restored, 1)
    const file = path.join(tmpData, 'novels', 'big-restore-1.json')
    assert.ok(fs.existsSync(file))
    assert.ok(fs.statSync(file).size > 20 * 1024 * 1024, '正文必须完整落盘')
  })

  await t.test('常规路由仍受 20mb 上限保护', async () => {
    const id = await createNovel('上限保护')
    const r = await j(`/api/novels/${id}`, 'PUT', { id, pad: 'y'.repeat(21 * 1024 * 1024) })
    assert.equal(r.status, 413, '只有备份恢复放宽，其余路由照旧')
    assert.match(String(r.data?.error || ''), /过大/)
  })

  await t.test('彻底删除后源目录不留带正文的 .bak', async () => {
    const id = await createNovel('删干净')
    await seedThreeChapters(id)
    // 改写正文触发原子写，旧版会留成 .bak
    assert.equal((await j(`/api/novels/${id}/chapters/1`, 'PUT', { content: '第二版正文' })).status, 200)
    assert.equal((await j(`/api/novels/${id}/chapters/1`, 'PUT', { content: '第三版正文' })).status, 200)

    const bak = path.join(tmpData, 'novels', `${id}.json.bak`)
    assert.ok(fs.existsSync(bak), '前置条件：改写章节应留下 .bak')
    assert.ok(fs.readFileSync(bak, 'utf8').includes('第二版正文'), '前置条件：.bak 里带着完整正文')

    assert.equal((await j(`/api/novels/${id}`, 'DELETE')).status, 200)
    assert.equal((await j(`/api/recycle/${id}`, 'DELETE')).status, 200)

    assert.ok(!fs.existsSync(bak), '彻底删除后源目录的 .bak 必须一并清掉，否则删掉的书正文还在 data/ 里')
    assert.ok(!fs.existsSync(path.join(tmpData, 'recycle', id)), '回收站目录也必须清掉')
    for (const d of ['novels', 'history', 'chats']) {
      const dir = path.join(tmpData, d)
      if (!fs.existsSync(dir)) continue
      for (const f of fs.readdirSync(dir)) {
        assert.ok(!f.startsWith(id), `${d}/ 里仍有残留：${f}`)
      }
    }
  })
})
