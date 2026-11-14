// 版本快照「正文块去重」回归测试
//
// 背景：早期实现把 总纲 + 大纲 + 全部章节正文 整份深拷进每一份快照，
// 一本 80 万字的书会写出 30 × 80 万字 ≈ 60MB 的 history.json，
// 且每次 push 都是全量序列化 + 同步写盘（阻塞事件循环）。
//
// 现在改为两级结构：
//   <历史目录>/<bookId>.blobs/<hash>.txt  —— 正文按内容哈希去重
//   <历史目录>/<bookId>.json              —— 快照只存结构 + { title, words, ref }
//
// 本测试锁定：
//  1. 快照 JSON 里不再内嵌正文，只留 ref
//  2. 同一章内容未变时，重复快照不新增正文块（真正的去重）
//  3. 内容变化时新增块，旧块在仍被引用时保留
//  4. 回滚能按 ref 取回正文；未改动章节的正文不在回滚中丢失
//  5. 旧格式快照（内嵌 content）仍可回滚
//
// 说明：所有断言合并在单个 test 内 —— 多个 top-level test 会共享服务端模块状态，
// 并发 startServer 会互相覆盖 base 端口。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-history-'))
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

const HISTORY_DIR = path.join(tmpData, 'history')

const snapshotFile = id => path.join(HISTORY_DIR, `${id}.json`)
// 正文块目录：historyFile 走 HISTORY_DIR（传 id 字符串时），所以块也落在 history/<id>.blobs
const blobDir = id => path.join(HISTORY_DIR, `${id}.blobs`)
const readSnapshots = id => JSON.parse(fs.readFileSync(snapshotFile(id), 'utf8'))
const blobCount = id => {
  try {
    return fs.readdirSync(blobDir(id)).filter(f => f.endsWith('.txt')).length
  } catch {
    return 0
  }
}

test('版本快照：正文按内容去重、回滚按 ref 取回、旧格式兼容', { timeout: 60000 }, async () => {
  const port = await startServer(0)
  base = `http://127.0.0.1:${port}`

  const created = await j('/api/novels', 'POST', { title: '快照测试书', genre: '玄幻' })
  assert.equal(created.status, 201)
  const id = created.data.id

  // 造 3 章正文，每章内容各不相同；走导入接口建立章节（新建的书没有章节，
  // PUT /chapters/:index 只更新已存在的章）
  const body = i => `第${i}章开头。${'文'.repeat(600)}第${i}章结尾钩子。`
  const importText = [1, 2, 3].map(i => `第${i}章\n\n${body(i)}`).join('\n\n')
  const imported = await j(`/api/novels/${id}/import`, 'POST', { text: importText, replace: true })
  assert.equal(imported.status, 200)
  assert.equal(imported.data.chapters, 3, '应导入 3 章')

  const beforeEdit = await j(`/api/novels/${id}`)
  assert.equal(beforeEdit.data.chapters.length, 3)
  assert.equal(beforeEdit.data.chapters[0].content, body(1))

  // ---------- 1. 触发一次快照（手动编辑第 1 章正文）----------
  const edit1 = await j(`/api/novels/${id}/chapters/1`, 'PUT', {
    content: `第1章开头。${'文'.repeat(600)}第1章结尾钩子。（改）`
  })
  assert.equal(edit1.status, 200)

  const snaps1 = readSnapshots(id)
  assert.equal(snaps1.length, 1, '应产生 1 份快照')
  assert.equal(snaps1[0].label, '手动编辑第1章前')

  // 快照里不允许内嵌正文
  for (const c of snaps1[0].snapshot.chapters) {
    assert.ok(!('content' in c), `快照第${c.index}章不应内嵌 content`)
    assert.equal(typeof c.ref, 'string', `快照第${c.index}章应带 ref`)
    assert.ok(c.ref.length > 0)
  }
  assert.equal(blobCount(id), 3, '3 章不同正文应产出 3 个正文块')

  // 快照文件应不含正文：这份快照的 JSON 体积必须明显小于「同样这几章正文的总字节」。
  // 小样本（3 章）下大纲/元信息占比高，绝对量对比不敏感，这里用「单章正文字节」作参照，
  // 快照整体（含 3 章元信息 + 大纲）不应超过一章正文的量级。
  const snapBytes = fs.statSync(snapshotFile(id)).size
  const oneChapterBytes = Buffer.byteLength(body(1), 'utf8')
  assert.ok(snapBytes < oneChapterBytes * 3, `快照不应内嵌正文（快照 ${snapBytes}B，单章正文 ${oneChapterBytes}B）`)
  // 而正文块总量应约等于 3 章正文之和 —— 说明正文确实被搬到了独立文件里
  const blobBytes = fs
    .readdirSync(blobDir(id))
    .filter(f => f.endsWith('.txt'))
    .reduce((s, f) => s + fs.statSync(path.join(blobDir(id), f)).size, 0)
  assert.ok(blobBytes >= oneChapterBytes * 3 * 0.95, '3 章正文都应落进正文块')

  // ---------- 2. 只有真正变化的章新增正文块，未变的章复用（去重生效）----------
  const edit2 = await j(`/api/novels/${id}/chapters/2`, 'PUT', {
    content: `第2章开头。${'文'.repeat(600)}第2章结尾钩子。（改）`
  })
  assert.equal(edit2.status, 200)
  const snaps2 = readSnapshots(id)
  assert.equal(snaps2.length, 2, '应累计 2 份快照')
  // 两份快照之间只有第 2 章正文变了（第 1 章在上一份快照之后才改，第 3 章一直没动）：
  // 初始 3 章 + 第 2 章改后 = 4 个块。若不做去重，第 1、3 章会被重复存一遍。
  assert.equal(blobCount(id), 4, '只有第2章正文变化，应只新增 1 个正文块（共 4 个）')

  // ---------- 3. 回滚到「手动编辑第2章前」----------
  const target = snaps2.find(s => s.label === '手动编辑第2章前')
  assert.ok(target, '应能找到目标快照')
  const restore = await j(`/api/novels/${id}/history/${target.id}/restore`, 'POST')
  assert.equal(restore.status, 200)

  const after = await j(`/api/novels/${id}`)
  assert.equal(after.status, 200)
  assert.equal(after.data.chapters.length, 3, '章节数应保持 3')
  // 回滚到「编辑第 2 章前」：第 1 章保持已改的正文，第 2、3 章回到初始正文
  const edit1Text = `第1章开头。${'文'.repeat(600)}第1章结尾钩子。（改）`
  assert.equal(after.data.chapters[0].content, edit1Text, '第1章的改动应保留')
  assert.equal(after.data.chapters[1].content, body(2), '第2章正文应回到改动前')
  assert.equal(after.data.chapters[2].content, body(3), '第3章正文应保持初始内容')
  // 逐章确认正文按 ref 完整取回（这是 ref 机制最容易出错的地方）
  assert.ok(
    after.data.chapters.every(c => typeof c.content === 'string' && c.content.length > 0),
    '每章正文都应取回非空文本'
  )

  // 回滚本身也会留一份「回滚前自动快照」
  const snaps3 = readSnapshots(id)
  assert.ok(
    snaps3.some(s => s.label === '回滚前自动快照'),
    '回滚前应自动留档'
  )

  // ---------- 4. 正文变化时新增块，旧块仍被引用时保留 ----------
  const edit3 = await j(`/api/novels/${id}/chapters/3`, 'PUT', { content: '第3章被彻底重写了。' })
  assert.equal(edit3.status, 200)
  const snaps4 = readSnapshots(id)
  // 这次编辑产生的最新快照（label = 手动编辑第3章前）里，第 3 章应指向初始正文块
  const beforeEdit3 = snaps4.find(s => s.label === '手动编辑第3章前')
  assert.ok(beforeEdit3, '应产生「手动编辑第3章前」快照')
  const prevC3 = beforeEdit3.snapshot.chapters.find(c => c.index === 3)
  assert.equal(prevC3.ref, snaps1[0].snapshot.chapters.find(c => c.index === 3).ref, '改前快照应复用初始正文块')

  // 再改一次第 3 章，触发第二份「改前」快照，此时它应指向上一版正文（新块）
  const edit4 = await j(`/api/novels/${id}/chapters/3`, 'PUT', { content: '第3章第二版。' })
  assert.equal(edit4.status, 200)
  const snaps5 = readSnapshots(id)
  const beforeEdit4 = snaps5.find(s => s.label === '手动编辑第3章前')
  const c3v2 = beforeEdit4.snapshot.chapters.find(c => c.index === 3)
  assert.notEqual(c3v2.ref, prevC3.ref, '第3章改写后的快照应指向新的正文块')
  // 两个块都在，各自内容可读
  assert.equal(fs.readFileSync(path.join(blobDir(id), `${prevC3.ref}.txt`), 'utf8'), body(3), '旧块内容应为初始正文')
  assert.equal(
    fs.readFileSync(path.join(blobDir(id), `${c3v2.ref}.txt`), 'utf8'),
    '第3章被彻底重写了。',
    '新块内容应为第一版改写'
  )
  // 仍被快照引用的旧块不能被回收
  assert.ok(fs.existsSync(path.join(blobDir(id), `${prevC3.ref}.txt`)), '仍被旧快照引用的正文块不应被回收')

  // ---------- 5. 旧格式快照（内嵌 content）仍可回滚 ----------
  const legacySnap = {
    id: 'legacy-1',
    at: Date.now(),
    label: '旧格式快照',
    snapshot: {
      masterOutline: '旧总纲',
      outline: [{ index: 1, title: '第1章', summary: '', customPrompt: '' }],
      chapters: [{ index: 1, title: '第1章', content: '旧格式正文', words: 5, status: 'done' }]
    }
  }
  fs.writeFileSync(snapshotFile(id), JSON.stringify([legacySnap, ...readSnapshots(id)]), 'utf8')
  const legacyRestore = await j(`/api/novels/${id}/history/legacy-1/restore`, 'POST')
  assert.equal(legacyRestore.status, 200)
  const afterLegacy = await j(`/api/novels/${id}`)
  assert.equal(afterLegacy.data.masterOutline, '旧总纲')
  assert.equal(afterLegacy.data.chapters.length, 1)
  assert.equal(afterLegacy.data.chapters[0].content, '旧格式正文', '旧格式快照的正文应能直接读出')

  // ---------- 6. 大书场景：多次快照的总占用应接近「一份正文」而非「N 份正文」----------
  // 这是本次改造的核心收益：早期实现下 20 份快照 ≈ 20 × 全书正文。
  const big = await j('/api/novels', 'POST', { title: '大部头', genre: '玄幻' })
  const bigId = big.data.id
  const bigBody = i => `第${i}章开头。${'字'.repeat(3000)}第${i}章结尾。`
  const bigText = Array.from({ length: 10 }, (_, i) => `第${i + 1}章\n\n${bigBody(i + 1)}`).join('\n\n')
  const bigImport = await j(`/api/novels/${bigId}/import`, 'POST', { text: bigText, replace: true })
  assert.equal(bigImport.data.chapters, 10)

  const oneChapter = Buffer.byteLength(bigBody(1), 'utf8')
  // 连续改同一章 5 次，每次改动前留一份快照：
  //   第 k 次编辑前的快照，记录的是第 (k-1) 版正文（第 1 次记录初始版）。
  // 因此快照里出现过的第 1 章正文版本 = 初始版 + v0..v3 = 5 个；最后写入的 v4 不再有快照。
  for (let k = 0; k < 5; k++) {
    await j(`/api/novels/${bigId}/chapters/1`, 'PUT', {
      content: `第1章开头。${'字'.repeat(3000)}第1章结尾（v${k}）。`
    })
  }
  const bigSnaps = readSnapshots(bigId)
  assert.equal(bigSnaps.length, 5, '应累计 5 份快照')
  const bigBlobs = fs.readdirSync(blobDir(bigId)).filter(f => f.endsWith('.txt')).length
  // 其余 9 章各一份（9）+ 第 1 章的 5 个版本（初始 + v0..v3）= 14
  assert.equal(bigBlobs, 14, `正文块应去重为 14 个（9 章未动 + 第1章5个版本），实际 ${bigBlobs}`)
  const bigSnapBytes = fs.statSync(snapshotFile(bigId)).size
  // 若内嵌正文，5 份 × 10 章 × 一章节 ≈ 50 章正文；这里快照 JSON 应远小于 3 章正文
  assert.ok(
    bigSnapBytes < oneChapter * 3,
    `10 章 × 5 份快照的 JSON 应仍很小（实际 ${bigSnapBytes}B，一章正文 ${oneChapter}B）`
  )
  // 对照：正文块总量约 14 章正文，但快照 JSON 始终是「元信息」量级 —— 这就是去重的收益
  const bigBlobBytes = fs
    .readdirSync(blobDir(bigId))
    .filter(f => f.endsWith('.txt'))
    .reduce((s, f) => s + fs.statSync(path.join(blobDir(bigId), f)).size, 0)
  assert.ok(bigBlobBytes >= oneChapter * 14 * 0.95, '正文块应承载全部 14 个版本')

  await stopServer()
  fs.rmSync(tmpData, { recursive: true, force: true })
})
