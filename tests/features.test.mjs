import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'

const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-features-test-'))
process.env.NOVEL_DATA_DIR = tmpData
const NOVELS_DIR = path.join(tmpData, 'novels')

const refDir = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-ref-diff-'))
fs.writeFileSync(
  path.join(refDir, 'alpha.txt'),
  '第一章 开篇\n这里是对开封照样文，重复的正文内容足够长以便超过字数阈值。'.repeat(8),
  'utf8'
)

const { startServer, stopServer, applyChatActions, undoChatAction } = await import('../server/app.mjs')

let novelId = ''
let base = ''

function chaptersPayload(words1, words2) {
  return [
    { index: 1, title: '第一章 短章', content: '短'.repeat(words1), words: words1, status: 'done' },
    { index: 2, title: '第二章 长章', content: '长'.repeat(words2), words: words2, status: 'done' }
  ]
}

test('新增功能 API 冒烟：字数告警 / 导出 / 回收站 / 素材库 / 参考差异', { timeout: 60000 }, async () => {
  const port = await startServer(0)
  base = `http://127.0.0.1:${port}`

  // ---------- 建一本有章节的书（字数明显偏离目标） ----------
  const novel = await (
    await fetch(`${base}/api/novels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '告警书', genre: '测试' })
    })
  ).json()
  novelId = novel.id
  // PUT 接口不回写 chapters（防 AI 生成期间被覆盖），测试直接落盘章节数据
  const seeded = JSON.parse(fs.readFileSync(path.join(NOVELS_DIR, `${novelId}.json`), 'utf8'))
  seeded.targetWords = 2000
  seeded.outline = [
    { index: 1, title: '第一章 短章' },
    { index: 2, title: '第二章 长章' }
  ]
  seeded.chapters = chaptersPayload(300, 4000).map(c => ({ ...c, oid: `ch${c.index}` }))
  fs.writeFileSync(path.join(NOVELS_DIR, `${novelId}.json`), JSON.stringify(seeded))

  // ---------- 字数波动告警 ----------
  const stats = await (await fetch(`${base}/api/novels/${novelId}/stats`)).json()
  assert.equal(stats.targetWords, 2000)
  assert.equal(stats.chapters, 2)
  // 300 字 vs 2000 → -85%；4000 字 vs 2000 → +100%，都应进入告警
  const devs = stats.deviations
  assert.equal(devs.length, 2)
  const short = devs.find(d => d.index === 1)
  const long = devs.find(d => d.index === 2)
  assert.ok(short.deviation < -30)
  assert.ok(long.deviation > 30)

  // ---------- 导出 HTML ----------
  const htmlRes = await fetch(`${base}/api/novels/${novelId}/export/html`)
  assert.equal(htmlRes.status, 200)
  assert.ok(htmlRes.headers.get('content-type').includes('text/html'))
  const htmlBody = await htmlRes.text()
  assert.ok(htmlBody.includes('<title>告警书</title>'))
  assert.ok(htmlBody.includes('第一章 短章'))

  // ---------- 导出 EPUB（极小 zip 结构可读） ----------
  const epubRes = await fetch(`${base}/api/novels/${novelId}/export/epub`)
  assert.equal(epubRes.status, 200)
  assert.ok(epubRes.headers.get('content-type').includes('epub'))
  const epubBuf = Buffer.from(await epubRes.arrayBuffer())
  // 本地文件头 + 中央目录都存在；mimetype 是第一条目且无压缩
  assert.equal(epubBuf.subarray(0, 4).toString(), 'PK\x03\x04')
  assert.ok(epubBuf.includes(Buffer.from('application/epub+zip')))
  const central = epubBuf.indexOf('PK\x01\x02')
  assert.ok(central > 0, '中央目录应存在')
  for (const p of [
    'mimetype',
    'META-INF/container.xml',
    'OEBPS/content.opf',
    'OEBPS/toc.ncx',
    'OEBPS/style.css',
    'OEBPS/front.xhtml',
    'OEBPS/c0.xhtml'
  ]) {
    assert.ok(epubBuf.includes(Buffer.from(p)), `epub 应包含条目 ${p}`)
  }

  // ---------- 回收站：软删 → 列表 → 恢复 → 彻底删除 ----------
  const del = await (await fetch(`${base}/api/novels/${novelId}`, { method: 'DELETE' })).json()
  assert.equal(del.ok, true)
  assert.equal(
    (await (await fetch(`${base}/api/novels`)).json()).some(n => n.id === novelId),
    false,
    '删除后不应出现在列表'
  )

  const recycle = await (await fetch(`${base}/api/recycle`)).json()
  const inBin = recycle.find(e => e.id === novelId)
  assert.ok(inBin, '回收站应包含该书')
  assert.equal(inBin.title, '告警书')
  assert.ok(inBin.deletedAt)

  const restored = await (await fetch(`${base}/api/recycle/${novelId}/restore`, { method: 'POST' })).json()
  assert.equal(restored.ok, true)
  assert.equal(
    (await (await fetch(`${base}/api/novels`)).json()).some(n => n.id === novelId),
    true,
    '恢复后应回到列表'
  )
  const backNovel = await (await fetch(`${base}/api/novels/${novelId}`)).json()
  assert.equal(backNovel.targetWords, 2000)

  // 彻底删除
  await fetch(`${base}/api/novels/${novelId}`, { method: 'DELETE' })
  const purge = await (await fetch(`${base}/api/recycle/${novelId}`, { method: 'DELETE' })).json()
  assert.equal(purge.ok, true)
  const recycle2 = await (await fetch(`${base}/api/recycle`)).json()
  assert.equal(
    recycle2.some(e => e.id === novelId),
    false,
    '彻底删除后回收站应为空'
  )

  // ---------- 素材与草稿库 CRUD ----------
  const mat = await (
    await fetch(`${base}/api/shelf`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: '寒夜宅邸',
        kind: 'material',
        content: '冷雨敲窗。'.repeat(300),
        tags: ['氛围', '场景']
      })
    })
  ).json()
  assert.ok(mat.id)
  const draftItem = await (
    await fetch(`${base}/api/shelf`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '未成形开篇', kind: 'draft', content: '电梯门打开的瞬间……' })
    })
  ).json()

  const materials = await (await fetch(`${base}/api/shelf?kind=material`)).json()
  assert.equal(materials.length, 1)
  assert.equal(materials[0].content.length, 200, '列表应截断到 200 字')
  const drafts = await (await fetch(`${base}/api/shelf?kind=draft`)).json()
  assert.equal(drafts.length, 1)

  const full = await (await fetch(`${base}/api/shelf/${mat.id}`)).json()
  assert.ok(full.content.length > 200, '详情应返回全文')

  const updated = await (
    await fetch(`${base}/api/shelf/${mat.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '雨夜宅邸', tags: ['氛围'] })
    })
  ).json()
  assert.equal(updated.title, '雨夜宅邸')
  assert.deepEqual(updated.tags, ['氛围'])

  await fetch(`${base}/api/shelf/${draftItem.id}`, { method: 'DELETE' })
  const drafts2 = await (await fetch(`${base}/api/shelf?kind=draft`)).json()
  assert.equal(drafts2.length, 0)
})

test('参考作品差异跟踪：指纹变化后扫描标注 new / changed', { timeout: 30000 }, async () => {
  const novel = await (
    await fetch(`${base}/api/novels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '差异书', genre: '测试', folderPath: refDir })
    })
  ).json()

  // 首次扫描：refAnalyzed 为空 → 全为 new
  const first = await (
    await fetch(`${base}/api/novels/${novel.id}/scan-folder`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderPath: refDir })
    })
  ).json()
  assert.equal(first.count, 1)
  assert.equal(first.files[0].status, 'new')
  assert.equal(first.newCount, 1)

  // 第二本参考文件加入，并改动第一本的正文 → 模拟“上次分析后的变化”
  fs.writeFileSync(
    path.join(refDir, 'beta.txt'),
    '第二章 新文件\n这里是新加入的对照正文内容，同样足够长以超过阈值。'.repeat(8),
    'utf8'
  )
  fs.appendFileSync(path.join(refDir, 'alpha.txt'), '\n补充若干字。')
  const n2 = await (await fetch(`${base}/api/novels/${novel.id}`)).json()
  // 直接落盘指纹：alpha 为旧长度，beta 不在指纹中
  const alphaWords = fs.readFileSync(path.join(refDir, 'alpha.txt'), 'utf8').replace(/\s/g, '').length
  n2.refAnalyzed = { at: Date.now(), files: { 'alpha.txt': String(alphaWords - 5) } }
  fs.writeFileSync(path.join(NOVELS_DIR, `${novel.id}.json`), JSON.stringify(n2))

  const second = await (
    await fetch(`${base}/api/novels/${novel.id}/scan-folder`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderPath: refDir })
    })
  ).json()
  assert.equal(second.count, 2)
  const alpha = second.files.find(f => f.name === 'alpha.txt')
  assert.equal(alpha.status, 'changed', '指纹字数不符应标注 changed')
  const beta = second.files.find(f => f.name === 'beta.txt')
  assert.equal(beta.status, 'new', '指纹中不存在应标注 new')
  assert.equal(second.newCount, 2)
})

test('管家动作调度器：兼容真实模型输出的各种形态并全部落库', () => {
  const novel = {
    id: 't-apply',
    title: '测试',
    genre: '都市',
    masterOutline: '',
    synopsis: '',
    worldview: '',
    elements: '',
    extraRequirements: '',
    protagonist: { name: '', role: '', personality: '', appearance: '', background: '', notes: '' },
    characters: [{ name: '林晚', role: '主角', personality: '冷静', appearance: '', background: '法医', notes: '' }],
    plotlines: [{ name: '主线', type: '主线', goal: '', description: '', status: 'active', beats: [] }],
    outline: [
      { index: 1, title: '初现', summary: '', customPrompt: '', oid: 'o1' },
      { index: 2, title: '旧案', summary: '', customPrompt: '', oid: 'o2' }
    ],
    chapters: [],
    skillIds: [],
    chapterCount: 12,
    targetWords: 2000
  }
  const actions = [
    { type: 'addCharacter', chapter: 0, text: '{"name":"王五","role":"配角","personality":"沉稳"}' },
    { type: 'updateCharacter', name: '林晚', text: '{"personality":"冷静理性，爱猫"}' },
    { type: 'chapterCount', text: '30' },
    { type: 'targetWords', text: '2500' },
    { type: 'outlineTitle', chapter: 2, text: '雨夜追凶' },
    { type: 'outlineSummary', chapter: 2, text: '连夜查案锁定真凶' },
    { type: 'addPlotline', text: '{"name":"身世谜团","type":"暗线","status":"active"}' },
    { type: 'plotlineStatus', text: '{"name":"主线","status":"paused"}' }
  ]
  const applied = applyChatActions(novel, actions)
  assert.equal(applied.length, 8)
  assert.ok(
    novel.characters.some(c => c.name === '王五' && c.role === '配角'),
    '王五应写入人物'
  )
  const lin = novel.characters.find(c => c.name === '林晚')
  assert.equal(lin.personality, '冷静理性，爱猫', 'updateCharacter 顶层 name 应命中并更新')
  assert.equal(novel.chapterCount, 30)
  assert.equal(novel.targetWords, 2500)
  assert.equal(novel.outline.find(o => o.index === 2).title, '雨夜追凶', '大纲标题应写入')
  assert.equal(novel.outline.find(o => o.index === 2).summary, '连夜查案锁定真凶', '大纲摘要应写入')
  assert.ok(novel.plotlines.some(p => p.name === '身世谜团'))
  assert.equal(novel.plotlines.find(p => p.name === '主线').status, 'paused')

  // 撤销一致性：每条 applied 快照都携带恢复所需的 before（数值类为数字，其余为字符串）
  for (const a of applied) {
    assert.ok(a.before !== undefined && a.before !== null, `${a.type} 应携带撤销快照`)
    assert.ok(a.label)
  }

  // 顶层扁平字段 / 数值扁平字段在调度器里也兜底可用
  const n2 = {
    ...JSON.parse(JSON.stringify(novel)),
    characters: [{ name: '林晚', role: '主角', personality: '冷静', appearance: '', background: '', notes: '' }]
  }
  const applied2 = applyChatActions(n2, [
    { type: 'addCharacter', name: '赵六', role: '暗线', background: '孤儿' },
    { type: 'chapterCount', count: 40 }
  ])
  assert.equal(applied2.length, 2)
  assert.ok(n2.characters.some(c => c.name === '赵六' && c.role === '暗线'))
  assert.equal(n2.chapterCount, 40)
})

test('管家动作：危险操作未授权被拒、授权后执行，未知动作被拒', () => {
  const mk = () => ({
    id: 'd',
    title: 'd',
    skillIds: [],
    plotlines: [],
    outline: [],
    characters: [],
    chapters: [{ index: 1, title: 'a', content: '正文', words: 2, status: 'done' }]
  })
  const denied = applyChatActions(mk(), [{ type: 'deleteChapter', chapter: 1, text: '' }], {})
  assert.equal(denied[0].status, 'rejected')
  assert.match(denied[0].reason, /危险操作/)

  const n = mk()
  const allowed = applyChatActions(n, [{ type: 'deleteChapter', chapter: 1, text: '' }], { allowDangerous: true })
  assert.equal(allowed[0].status, 'applied')
  assert.equal(n.chapters.length, 0, '授权后应删除章节')

  const unknown = applyChatActions(mk(), [{ type: 'nonsense', text: 'x' }], {})
  assert.equal(unknown[0].status, 'rejected')
  assert.match(unknown[0].reason, /不支持/)
})

test('管家动作：生成类动作调用 spawnJob 并返回已启动状态', () => {
  const novel = {
    id: 'g',
    title: 'g',
    skillIds: [],
    characters: [],
    plotlines: [],
    outline: [{ index: 1, title: 'a', summary: '', customPrompt: '', oid: 'o1' }],
    chapters: []
  }
  const calls = []
  const spawnJob = spec => {
    calls.push(spec)
    return { id: `job-${calls.length}` }
  }
  const applied = applyChatActions(
    novel,
    [
      { type: 'continueChapter', chapter: 1, text: '' },
      { type: 'reviseChapter', chapter: 1, text: '节奏太拖' },
      { type: 'polishChapter', chapter: 1, text: '更利落' },
      { type: 'detectAI', text: '1,2' },
      { type: 'consistencyCheck', text: '' }
    ],
    { spawnJob }
  )
  assert.equal(applied.length, 5)
  assert.ok(
    applied.every(a => a.status === 'started' && a.jobId),
    '生成动作应返回 started + jobId'
  )
  assert.equal(calls[0].type, 'chapter')
  assert.equal(calls[0].kind, 'continue')
  assert.equal(calls[0].chapterIndex, 1)
  assert.equal(calls[1].kind, 'revise')
  assert.equal(calls[1].extraPrompt, '节奏太拖')
  assert.equal(calls[2].kind, 'polish')
  assert.equal(calls[2].extraPrompt, '更利落')
  assert.deepEqual(calls[3].chapterIndices, [1, 2])
  assert.equal(calls[4].type, 'consistency')
})

test('管家动作：生成动作遇到同类任务冲突时被拒并给出原因', () => {
  const novel = { id: 'g2', title: 'g2', skillIds: [], characters: [], plotlines: [], outline: [], chapters: [] }
  const spawnJob = () => {
    const e = new Error('已有同类任务在本作品后台运行')
    e.status = 409
    throw e
  }
  const applied = applyChatActions(novel, [{ type: 'continueChapter', chapter: 1, text: '' }], { spawnJob })
  assert.equal(applied[0].status, 'rejected')
  assert.match(applied[0].reason, /同类任务/)
})

test('管家动作：新增编辑类动作（人物/剧情线/大纲/偏好/模型/正文）', () => {
  const novel = {
    id: 'e2',
    title: '书',
    pov: 'third',
    modelId: 'm1',
    skillIds: [],
    characters: [{ name: '林晚', role: '主角' }],
    plotlines: [{ name: '主线', type: '主线', goal: '', description: '', status: 'active', beats: [] }],
    outline: [{ index: 1, title: '初现', summary: '', customPrompt: '', oid: 'o1' }],
    chapters: [{ index: 1, title: '初现', content: '旧正文', words: 3, status: 'done', oid: 'o1' }]
  }
  const applied = applyChatActions(
    novel,
    [
      { type: 'removeCharacter', text: '林晚' },
      { type: 'addPlotBeat', text: '{"plotline":"主线","title":"觉醒","summary":"主角觉醒","chapter":2}' },
      { type: 'addOutline', text: '{"title":"新章","summary":"概要"}' },
      { type: 'deleteOutline', chapter: 1, text: '' },
      { type: 'pov', text: '第一人称' },
      { type: 'linkContext', text: '开' },
      { type: 'model', text: '新模型' },
      { type: 'chapterContent', chapter: 1, text: '新正文内容' },
      { type: 'appendChapter', chapter: 1, text: '追加结尾' }
    ],
    { models: [{ id: 'm2', name: '新模型' }] }
  )
  assert.equal(applied.filter(a => a.status === 'applied').length, 9)
  assert.equal(novel.characters.length, 0)
  assert.equal(novel.plotlines[0].beats.length, 1)
  assert.equal(novel.plotlines[0].beats[0].title, '觉醒')
  assert.equal(novel.outline.length, 1)
  assert.equal(novel.outline[0].title, '新章')
  assert.equal(novel.pov, 'first')
  assert.equal(novel.linkContext, true)
  assert.equal(novel.modelId, 'm2')
  assert.match(novel.chapters[0].content, /新正文内容/)
  assert.match(novel.chapters[0].content, /追加结尾/)
})

test('管家删除章节：正文大纲同步删除、重编号并可撤销', () => {
  const novel = {
    id: 'delete-sync',
    skillIds: [],
    characters: [],
    plotlines: [],
    outline: [1, 2, 3].map(i => ({ index: i, title: `章${i}`, summary: `摘要${i}`, customPrompt: '', oid: `o${i}` })),
    chapters: [1, 2, 3].map(i => ({
      index: i,
      title: `章${i}`,
      content: `正文${i}`,
      words: 3,
      status: 'done',
      oid: `o${i}`
    }))
  }
  const applied = applyChatActions(novel, [{ type: 'deleteChapter', chapter: 2, text: '' }], { allowDangerous: true })
  assert.equal(applied[0].status, 'applied')
  assert.deepEqual(
    novel.chapters.map(c => c.index),
    [1, 2]
  )
  assert.deepEqual(
    novel.chapters.map(c => c.content),
    ['正文1', '正文3']
  )
  assert.deepEqual(
    novel.outline.map(o => o.index),
    [1, 2]
  )
  assert.deepEqual(
    novel.outline.map(o => o.title),
    ['章1', '章3']
  )
  assert.equal(undoChatAction(novel, applied[0]).ok, true)
  assert.deepEqual(
    novel.chapters.map(c => c.index),
    [1, 2, 3]
  )
  assert.deepEqual(
    novel.chapters.map(c => c.content),
    ['正文1', '正文2', '正文3']
  )
  assert.deepEqual(
    novel.outline.map(o => o.index),
    [1, 2, 3]
  )
  assert.deepEqual(
    novel.outline.map(o => o.title),
    ['章1', '章2', '章3']
  )
})

test('管家动作：撤销可恢复新动作的旧值', () => {
  const novel = {
    id: 'u',
    pov: 'third',
    modelId: 'm1',
    skillIds: [],
    characters: [{ name: '林晚' }],
    plotlines: [{ name: '主线', beats: [] }],
    outline: [],
    chapters: [{ index: 1, title: 'a', content: '原文', words: 2, status: 'done' }]
  }
  const applied = applyChatActions(
    novel,
    [
      { type: 'removeCharacter', text: '林晚' },
      { type: 'pov', text: '第一人称' },
      { type: 'model', text: '新模型' },
      { type: 'chapterContent', chapter: 1, text: '改后正文' }
    ],
    { models: [{ id: 'm2', name: '新模型' }] }
  )
  assert.equal(novel.characters.length, 0)
  assert.equal(novel.chapters[0].content, '改后正文')
  for (const a of applied) assert.equal(undoChatAction(novel, a).ok, true)
  assert.equal(novel.characters.length, 1)
  assert.equal(novel.pov, 'third')
  assert.equal(novel.modelId, 'm1')
  assert.equal(novel.chapters[0].content, '原文')
})

test('管家动作：正文段落级编辑（改/插/删）与撤销', () => {
  const novel = {
    id: 'p',
    title: '书',
    pov: 'third',
    modelId: '',
    skillIds: [],
    plotlines: [],
    outline: [],
    characters: [],
    chapters: [
      { index: 1, title: '初', content: '第一段。\n\n第二段。\n\n第三段。\n\n第四段。', words: 10, status: 'done' }
    ]
  }
  const applied = applyChatActions(
    novel,
    [
      { type: 'editParagraph', chapter: 1, text: '{"start":2,"replacement":"第二段·已改写。"}' },
      { type: 'insertParagraph', chapter: 1, text: '{"start":2,"replacement":"插进来的新段。"}' },
      { type: 'deleteParagraph', chapter: 1, text: '{"start":4,"count":2}' }
    ],
    {}
  )
  assert.equal(applied.filter(a => a.status === 'applied').length, 3)
  const paras = novel.chapters[0].content
    .split(/\n+/)
    .map(s => s.trim())
    .filter(Boolean)
  // 原 4 段 → 改第2段 → 在第2段前插入新段 → 删此时的第4、5段（即原第3、4段），剩 3 段
  assert.deepEqual(paras, ['第一段。', '插进来的新段。', '第二段·已改写。'])
  // 撤销按「后应用的先撤」（与编辑器撤销栈一致），每步都回到该动作前的整章快照
  for (const a of [...applied].reverse()) assert.equal(undoChatAction(novel, a).ok, true)
  const after = novel.chapters[0].content
    .split(/\n+/)
    .map(s => s.trim())
    .filter(Boolean)
  assert.deepEqual(after, ['第一段。', '第二段。', '第三段。', '第四段。'], '全部撤销后应恢复原文')
})

test('管家动作：段落编辑越界/空内容被拒并给出原因', () => {
  const novel = {
    id: 'p2',
    title: '书',
    pov: 'third',
    modelId: '',
    skillIds: [],
    plotlines: [],
    outline: [],
    characters: [],
    chapters: [{ index: 1, title: '初', content: '只有一段。', words: 4, status: 'done' }]
  }
  const outOfRange = applyChatActions(
    novel,
    [{ type: 'editParagraph', chapter: 1, text: '{"start":5,"replacement":"改"}' }],
    {}
  )
  assert.equal(outOfRange[0].status, 'rejected')
  assert.match(outOfRange[0].reason, /段落范围/)

  const noChapter = applyChatActions(novel, [{ type: 'deleteParagraph', chapter: 9, text: '{"start":1}' }], {})
  assert.equal(noChapter[0].status, 'rejected')
  assert.match(noChapter[0].reason, /没有第 9 章正文/)

  const empty = applyChatActions(
    novel,
    [{ type: 'insertParagraph', chapter: 1, text: '{"start":1,"replacement":""}' }],
    {}
  )
  assert.equal(empty[0].status, 'rejected')
  assert.match(empty[0].reason, /插入内容为空/)
})

test('模型分组：一键导入「此站新模型」复用已有密钥，只新增未收录的，重复跳过', async () => {
  // 模拟一个中转站，/v1/models 返回两个模型
  const relay = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ data: [{ id: 'relay-a' }, { id: 'relay-b' }] }))
  })
  await new Promise(r => relay.listen(0, '127.0.0.1', r))
  const relayBase = `http://127.0.0.1:${relay.address().port}`
  try {
    // 库中已有该站一个模型（持有真实密钥）
    const add = await (
      await fetch(`${base}/api/models`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: '已有模型',
          baseUrl: `${relayBase}/v1`,
          apiKey: 'sk-secret-key',
          model: 'relay-a'
        })
      })
    ).json()
    assert.equal(add.hasKey, true, '保存应持有真实密钥')

    // 分组「导入此站新模型」：复用该站密钥，只补齐 relay-b
    const imp = await (
      await fetch(`${base}/api/models/import-group`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl: `${relayBase}/v1` })
      })
    ).json()
    assert.equal(imp.ok, true)
    assert.equal(imp.added, 1, '应新增 relay-b')
    assert.equal(imp.skipped, 1, 'relay-a 已在库应跳过')

    const list = await (await fetch(`${base}/api/models`)).json()
    assert.ok(
      list.some(m => m.model === 'relay-b'),
      'relay-b 应已入库'
    )

    // 地址不匹配任何已有站 → 拒绝并给出提示
    const miss = await (
      await fetch(`${base}/api/models/import-group`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl: 'http://127.0.0.1:9/v1' })
      })
    ).json()
    assert.notEqual(miss.ok, true)
    assert.match(miss.error || '', /还没有模型/)
  } finally {
    relay.close()
  }
})

test('模型分组：中转站可自定义名字，随模型列表返回，清空即回落显示域名', async () => {
  const add = await (
    await fetch(`${base}/api/models`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: '临时模型',
        baseUrl: 'https://tmp.example.com/v1',
        apiKey: 'sk-tmp',
        model: 'tmp-1'
      })
    })
  ).json()
  assert.equal(add.id, add.id)

  // 给该中转站改名
  const ren = await (
    await fetch(`${base}/api/models/stations/name`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl: 'https://tmp.example.com/v1', name: '我的常用中转' })
    })
  ).json()
  assert.equal(ren.ok, true)
  assert.equal(ren.stationName, '我的常用中转')

  const list = await (await fetch(`${base}/api/models`)).json()
  const named = list.filter(m => m.baseUrl === 'https://tmp.example.com/v1')
  assert.ok(named.length >= 1)
  assert.equal(named[0].stationName, '我的常用中转', '自定义名应随列表返回')

  // 清空名字 → 回落显示域名（stationName 为空串）
  const clear = await (
    await fetch(`${base}/api/models/stations/name`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl: 'https://tmp.example.com/v1', name: '' })
    })
  ).json()
  assert.equal(clear.ok, true)
  assert.equal(clear.stationName, '')
  const list2 = await (await fetch(`${base}/api/models`)).json()
  assert.equal(list2.find(m => m.baseUrl === 'https://tmp.example.com/v1').stationName, '')
})

test('内置 Skill 包：随应用发布、可在 API 中查看并启用，重名导入被跳过', async () => {
  const skills = await (await fetch(`${base}/api/skills`)).json()
  const snow = skills.find(s => s.id === 'snowflake-foundation')
  assert.ok(snow, '应包含雪花写作法 Skill')
  assert.equal(snow.builtIn, true)
  assert.ok(snow.content && snow.content.length > 50, '内置 Skill 应带正文内容')
  assert.ok(
    skills.some(s => s.id === 'continuity-journal'),
    '应包含连续性日志 Skill'
  )
  assert.ok(
    skills.some(s => s.id === 'anti-ai-natural-chinese'),
    '应包含反模板质检 Skill'
  )

  // 同名内置技能再导入应被视为重复
  const dup = await fetch(`${base}/api/skills/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: [{ text: '---\nname: 雪花式故事基础\ndescription: 重复\n---\n\n内容' }] })
  })
  assert.equal(dup.status, 409)

  // 新导入的自定义技能标记 builtIn=false，并可与内置技能一起被作品选中
  const novel = await (
    await fetch(`${base}/api/novels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '技能书', genre: '测试' })
    })
  ).json()
  const nv = await (await fetch(`${base}/api/novels/${novel.id}`)).json()
  nv.skillIds = ['snowflake-foundation', 'continuity-journal']
  await fetch(`${base}/api/novels/${novel.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(nv)
  })
  const back = await (await fetch(`${base}/api/novels/${novel.id}`)).json()
  assert.deepEqual(back.skillIds, ['snowflake-foundation', 'continuity-journal'])
  await fetch(`${base}/api/novels/${novel.id}`, { method: 'DELETE' })
})

test('正文长度与上下文：导入 4000 字按实际字数统计，并生成连续性快照', async () => {
  const novel = await (
    await fetch(`${base}/api/novels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '长章书', genre: '测试' })
    })
  ).json()

  const ch1 = `第一章 起风\n${'风'.repeat(4000)}`
  const ch2 = `第二章 落雨\n${'雨'.repeat(2000)}`
  const imp = await (
    await fetch(`${base}/api/novels/${novel.id}/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: `${ch1}\n${ch2}`, replace: true })
    })
  ).json()
  assert.equal(imp.chapters, 2)
  assert.equal(imp.words, 6000, '导入统计应为 4000 + 2000')

  const nv = await (await fetch(`${base}/api/novels/${novel.id}`)).json()
  assert.equal(nv.chapters[0].words, 4000, '4000 字正文不能被记成 2000')
  assert.equal(nv.chapters[0].context.source, 'imported-estimate', '导入章节应有可追踪的估算上下文')
  assert.ok(nv.chapters[0].context.summary.includes('4000'))
  assert.ok(nv.chapters[0].context.endingHook, '应记录章末钩子')

  // 旧数据里 words 元数据过期时，读取应按正文重算
  const file = path.join(NOVELS_DIR, `${novel.id}.json`)
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  raw.chapters[0].words = 2000
  fs.writeFileSync(file, JSON.stringify(raw))
  const fixed = await (await fetch(`${base}/api/novels/${novel.id}`)).json()
  assert.equal(fixed.chapters[0].words, 4000, 'words 元数据过期时应以正文为准重算')

  const stats = await (await fetch(`${base}/api/novels/${novel.id}/stats`)).json()
  assert.equal(stats.words, 6000)
  assert.equal(stats.chapters, 2)

  // 手工编辑正文后字数与上下文同步更新
  const put = await (
    await fetch(`${base}/api/novels/${novel.id}/chapters/1`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '短' })
    })
  ).json()
  assert.equal(put.chapter.words, 1)
  const nv2 = await (await fetch(`${base}/api/novels/${novel.id}`)).json()
  assert.equal(nv2.chapters[0].words, 1)
  // PUT /chapters/:index 是作者在「成书」页手工编辑的入口，source 必须标 manual ——
  // 这是 AI 识别「作者亲笔」并以此为文风样本的依据（此前误标 generated）
  assert.equal(nv2.chapters[0].context.source, 'manual')
  assert.ok(nv2.chapters[0].context.manualEdits >= 1, '应记录手改次数')

  await fetch(`${base}/api/novels/${novel.id}`, { method: 'DELETE' })
})

test('正文生成端到端：finish_reason=length 时保存草稿并报错，不把半章标成完成', { timeout: 60000 }, async () => {
  // 本地假中转站：返回一段正文 + finish_reason=length，模拟输出被 max_tokens 截断
  const relay = http.createServer((req, res) => {
    if (!req.url.includes('/chat/completions')) {
      res.writeHead(404).end('no')
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write(
      'data: ' +
        JSON.stringify({ choices: [{ delta: { content: '这是一段被截断的正文。' }, finish_reason: 'length' }] }) +
        '\n\n'
    )
    res.write('data: [DONE]\n\n')
    res.end()
  })
  await new Promise(r => relay.listen(0, '127.0.0.1', r))
  const relayBase = `http://127.0.0.1:${relay.address().port}`
  try {
    const model = await (
      await fetch(`${base}/api/models`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: '截断模拟',
          baseUrl: `${relayBase}/v1`,
          apiKey: 'sk-test',
          model: 'm',
          isDefault: false
        })
      })
    ).json()

    const novel = await (
      await fetch(`${base}/api/novels`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: '截断书', genre: '测试' })
      })
    ).json()
    const nv = await (await fetch(`${base}/api/novels/${novel.id}`)).json()
    nv.targetWords = 2000
    nv.outline = [{ index: 1, title: '第一章', summary: '【开场】测试', customPrompt: '', oid: 'o1' }]
    await fetch(`${base}/api/novels/${novel.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(nv)
    })

    const started = await (
      await fetch(`${base}/api/generate/chapter`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ novelId: novel.id, chapterIndex: 1, modelId: model.id })
      })
    ).json()
    assert.ok(started.jobId)

    let job = null
    for (let i = 0; i < 50; i++) {
      await new Promise(r => setTimeout(r, 100))
      job = await (await fetch(`${base}/api/jobs/${started.jobId}`)).json()
      if (job.status !== 'running') break
    }
    assert.equal(job.status, 'error', '截断应判为失败而不是完成')
    assert.match(job.error, /截断/)
    assert.equal(job.truncated, true)
    assert.equal(job.savedDraft, true)

    const after = await (await fetch(`${base}/api/novels/${novel.id}`)).json()
    assert.equal(after.chapters.length, 1)
    assert.equal(after.chapters[0].status, 'draft', '截断内容应保存为草稿')
    assert.ok(after.chapters[0].content.includes('被截断的正文'))
    await fetch(`${base}/api/novels/${novel.id}`, { method: 'DELETE' })
  } finally {
    relay.close()
  }
})

test.after(async () => {
  await stopServer()
  try {
    fs.rmSync(tmpData, { recursive: true, force: true })
  } catch {}
  try {
    fs.rmSync(refDir, { recursive: true, force: true })
  } catch {}
})
