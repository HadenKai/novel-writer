// 本轮体检修复的回归锁定（2026-09）：
//  - normalizeOpenAIBase 无协议地址（Ollama 风格 host:port）不再产出非法 URL
//  - SSE 一个事件拆多行 data: 的合并（逐行解析会把这类网关输出整段丢掉）
//  - reasoningOnly 自动重试时下发 reasoning restart，调用方清空上一轮思考避免整段重复
//  - EPUB 导出的 ZIP 本地文件头字段偏移与真实 crc32（严格解析器可读）
//  - 章节任务停笔/截断存草稿前先留版本快照；生成期间手改的章不被半截草稿覆盖
//  - 知识库写操作串行化：并发加文档/写问答不互吞
//  - startServer 幂等（同进程二次调用不再自撞实例锁）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'

const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-audit-fixes-'))
process.env.NOVEL_DATA_DIR = tmpData
const NOVELS_DIR = path.join(tmpData, 'novels')
const HISTORY_DIR = path.join(tmpData, 'history')

const { startServer, stopServer } = await import('../server/app.mjs')
const { normalizeOpenAIBase, streamChat } = await import('../server/ai-transport.mjs')
const { createKb, addDoc, pushQa, listQa, listKb } = await import('../server/kb.mjs')

let base = ''
const port = await startServer(0)
base = `http://127.0.0.1:${port}`

// ---------- normalizeOpenAIBase：无协议地址 ----------
test('normalizeOpenAIBase 无协议 host:port 补 http://（Ollama 风格输入）', () => {
  // 旧实现对 "localhost:11434/v1" 会把 "localhost:" 当协议解析，origin 变成 "null"
  assert.equal(normalizeOpenAIBase('localhost:11434/v1'), 'http://localhost:11434/v1')
  assert.equal(normalizeOpenAIBase('127.0.0.1:11434'), 'http://127.0.0.1:11434/v1')
  assert.equal(normalizeOpenAIBase('relay.example.com'), 'http://relay.example.com/v1')
  // 带协议的既有行为不变
  assert.equal(normalizeOpenAIBase('https://relay.example.com/v1'), 'https://relay.example.com/v1')
})

// ---------- SSE 多行 data: 合并 ----------
function sseResponse(lines) {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    start(c) {
      for (const s of lines) c.enqueue(encoder.encode(s))
      c.close()
    }
  })
  return { ok: true, status: 200, body: stream }
}

async function collectStream(opts) {
  // 按 app.mjs 任务执行器的同一套逻辑累积：restart 标记清空已累计的思考
  let content = ''
  let reasoning = ''
  const parts = []
  try {
    for await (const part of streamChat(opts)) {
      parts.push(part)
      if (part.type === 'reasoning') reasoning = part.restart ? '' : reasoning + part.text
      else if (part.type === 'content') content += part.text
    }
    return { content, reasoning, parts }
  } catch (e) {
    return { content, reasoning, parts, error: e }
  }
}

test('streamChat 合并被网关拆成多行 data: 的同一个 SSE 事件', async () => {
  const orig = globalThis.fetch
  const event = JSON.stringify({ choices: [{ delta: { content: '拆行正文' } }] })
  const half = Math.floor(event.length / 2)
  globalThis.fetch = async () =>
    sseResponse([`data: ${event.slice(0, half)}\n`, `data: ${event.slice(half)}\n\n`, 'data: [DONE]\n\n'])
  try {
    const { content, error } = await collectStream({
      baseUrl: 'https://relay.test',
      apiKey: 'k',
      model: 'm',
      messages: []
    })
    assert.ok(!error, error?.message)
    assert.equal(content, '拆行正文', '拆成两行 data: 的 JSON 必须按 \\n 拼回后解析')
  } finally {
    globalThis.fetch = orig
  }
})

test('streamChat reasoningOnly 自动重试时先下发 reasoning restart', async () => {
  const orig = globalThis.fetch
  let call = 0
  globalThis.fetch = async () => {
    call++
    if (call === 1) {
      // 第一轮：只吐思考、流正常结束 → 判 reasoningOnly 放大输出上限重试
      return sseResponse([
        'data: ' + JSON.stringify({ choices: [{ delta: { reasoning_content: '第一轮思考' } }] }) + '\n\n',
        'data: [DONE]\n\n'
      ])
    }
    return sseResponse([
      'data: ' + JSON.stringify({ choices: [{ delta: { reasoning_content: '第二轮思考' } }] }) + '\n\n',
      'data: ' + JSON.stringify({ choices: [{ delta: { content: '正文' } }] }) + '\n\n',
      'data: [DONE]\n\n'
    ])
  }
  try {
    const { reasoning, content, parts } = await collectStream({
      baseUrl: 'https://relay.test',
      apiKey: 'k',
      model: 'm',
      messages: []
    })
    assert.equal(content, '正文')
    assert.equal(reasoning, '第二轮思考', 'restart 后应清空上一轮思考，不整段重复')
    const restartIdx = parts.findIndex(p => p.type === 'reasoning' && p.restart)
    const secondIdx = parts.findIndex(p => p.type === 'reasoning' && !p.restart && p.text === '第二轮思考')
    assert.ok(restartIdx > 0, '重试前应下发 restart 标记')
    assert.ok(secondIdx > restartIdx, 'restart 标记应先于第二轮思考')
  } finally {
    globalThis.fetch = orig
  }
})

// ---------- EPUB ZIP 结构完整性 ----------
const CRC32_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC32_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** 遍历中央目录逐条目校验本地头：签名 / 尺寸 / 文件名长度 / crc 与实际数据一致 */
function verifyZip(buf) {
  const eocd = buf.lastIndexOf(Buffer.from('PK\x05\x06'))
  assert.ok(eocd > 0, 'EOCD 应存在')
  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  const names = []
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50, '中央目录签名')
    const crc = buf.readUInt32LE(p + 16)
    const comp = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOffset = buf.readUInt32LE(p + 42)
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString()
    assert.equal(buf.readUInt32LE(localOffset), 0x04034b50, `${name} 本地头签名`)
    assert.equal(buf.readUInt16LE(localOffset + 26), nameLen, `${name} 本地头文件名长度应在 26 偏移`)
    assert.equal(buf.readUInt16LE(localOffset + 28), 0, `${name} 本地头扩展字段长度应在 28 偏移且为 0`)
    assert.equal(buf.readUInt32LE(localOffset + 18), comp, `${name} 本地头压缩尺寸`)
    assert.equal(buf.readUInt32LE(localOffset + 22), comp, `${name} 本地头原始尺寸（store 模式两值相同）`)
    assert.equal(buf.readUInt32LE(localOffset + 14), crc, `${name} 本地头 crc32`)
    const dataStart = localOffset + 30 + nameLen
    const data = buf.subarray(dataStart, dataStart + comp)
    assert.equal(crc32(data), crc >>> 0, `${name} 数据 crc32 与头部一致`)
    names.push(name)
    p += 46 + nameLen + extraLen + commentLen
  }
  return names
}

test('EPUB 导出：本地文件头偏移正确、crc32 与内容一致，严格解析器可读', { timeout: 60000 }, async () => {
  const novel = await (
    await fetch(`${base}/api/novels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'EPUB体检书', genre: '测试' })
    })
  ).json()
  const imp = await (
    await fetch(`${base}/api/novels/${novel.id}/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: `第一章 起\n${'风'.repeat(200)}`, replace: true })
    })
  ).json()
  assert.equal(imp.chapters, 1)

  const res = await fetch(`${base}/api/novels/${novel.id}/export/epub`)
  assert.equal(res.status, 200)
  const buf = Buffer.from(await res.arrayBuffer())
  // mimetype 是 EPUB 规范的第一条目，内容固定 20 字节、无压缩
  assert.equal(buf.subarray(30, 38).toString(), 'mimetype')
  assert.equal(buf.readUInt32LE(18), 20, 'mimetype 压缩尺寸应在 18 偏移')
  assert.equal(buf.readUInt32LE(22), 20, 'mimetype 原始尺寸应在 22 偏移')
  const entries = verifyZip(buf)
  assert.ok(entries.includes('mimetype'))
  assert.ok(entries.includes('META-INF/container.xml'))
  assert.ok(entries.some(n => n.startsWith('OEBPS/')))
  await fetch(`${base}/api/novels/${novel.id}`, { method: 'DELETE' })
})

// ---------- 停笔存草稿：先快照、手改不被覆盖 ----------
function readHistorySnapshots(id) {
  const file = path.join(HISTORY_DIR, `${id}.json`)
  if (!fs.existsSync(file)) return []
  const list = JSON.parse(fs.readFileSync(file, 'utf8'))
  return Array.isArray(list) ? list : []
}

function snapshotChapterContent(id, snap, index) {
  const c = (snap?.snapshot?.chapters || []).find(x => x.index === index)
  if (!c) return null
  if (typeof c.content === 'string') return c.content
  if (c.ref) {
    const blob = path.join(HISTORY_DIR, `${id}.blobs`, `${c.ref}.txt`)
    return fs.existsSync(blob) ? fs.readFileSync(blob, 'utf8') : null
  }
  return null
}

async function waitJob(jobId, timeoutMs = 15000) {
  const until = Date.now() + timeoutMs
  let job = null
  while (Date.now() < until) {
    await new Promise(r => setTimeout(r, 100))
    job = await (await fetch(`${base}/api/jobs/${jobId}`)).json()
    if (job.status !== 'running') return job
  }
  return job
}

async function seedChapter(novelId, content) {
  const file = path.join(NOVELS_DIR, `${novelId}.json`)
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  raw.outline = [{ index: 1, title: '第一章', summary: '【开场】测试', customPrompt: '', oid: 'o1' }]
  raw.chapters = [
    {
      index: 1,
      title: '第一章',
      content,
      words: content.replace(/\s/g, '').length,
      status: 'done',
      oid: 'o1'
    }
  ]
  fs.writeFileSync(file, JSON.stringify(raw))
}

const ORIGINAL = '这是作者亲手写完的整章正文，一字都不能被半截草稿顶掉。'.repeat(6)

// 中转站：延迟后吐一段超 50 字的"AI 半成品"，随后粗暴断流 → 任务走 catch 存草稿路径
function brokenRelay({ delayMs = 250, chunkDelayMs = 0 } = {}) {
  const relay = http.createServer((req, res) => {
    if (!req.url.includes('/chat/completions')) {
      res.writeHead(404).end('no')
      return
    }
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(
        'data: ' +
          JSON.stringify({
            choices: [
              {
                delta: {
                  content:
                    '这是润色进行到一半的 AI 半成品内容，长度必须超过五十个字才会被计入草稿，继续补充一些字数确保超过阈值。'
                }
              }
            ]
          }) +
          '\n\n'
      )
      setTimeout(() => res.socket.destroy(), chunkDelayMs)
    }, delayMs)
  })
  return relay
}

async function createModel(relayBase) {
  return (
    await fetch(`${base}/api/models`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '断流模拟', baseUrl: `${relayBase}/v1`, apiKey: 'sk-test', model: 'm' })
    })
  ).json()
}

test('断流存草稿前先留版本快照：半截草稿顶掉整章后可从历史回滚', { timeout: 60000 }, async () => {
  const relay = brokenRelay()
  await new Promise(r => relay.listen(0, '127.0.0.1', r))
  try {
    const model = await createModel(`http://127.0.0.1:${relay.address().port}`)
    const novel = await (
      await fetch(`${base}/api/novels`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: '断流书', genre: '测试' })
      })
    ).json()
    await seedChapter(novel.id, ORIGINAL)

    const started = await (
      await fetch(`${base}/api/generate/chapter`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ novelId: novel.id, chapterIndex: 1, modelId: model.id, kind: 'polish' })
      })
    ).json()
    const job = await waitJob(started.jobId)
    assert.equal(job.savedDraft, true, '断流时应把已生成部分存为草稿')

    const after = await (await fetch(`${base}/api/novels/${novel.id}`)).json()
    assert.equal(after.chapters[0].status, 'draft', '半截内容应标记为草稿')
    assert.ok(after.chapters[0].content.includes('半成品'), '草稿应包含已生成的部分')

    // 关键断言：覆盖前留了快照，快照里是覆盖前的完整正文
    const snaps = readHistorySnapshots(novel.id)
    const cover = snaps.find(s => s.label === '停笔存草稿前（第1章）')
    assert.ok(cover, '存草稿覆盖前应自动留版本快照')
    assert.equal(
      snapshotChapterContent(novel.id, cover, 1),
      ORIGINAL,
      '快照应完整保留覆盖前的正文（内容寻址 blob 或内嵌）'
    )
    await fetch(`${base}/api/novels/${novel.id}`, { method: 'DELETE' })
  } finally {
    relay.close()
  }
})

test('生成期间手改本章：停笔草稿被防覆盖校验拒绝，手改内容保持原样', { timeout: 60000 }, async () => {
  // 中转站延迟 400ms 才吐正文再断流，给测试留出「启动后立刻手改」的窗口
  const relay = brokenRelay({ delayMs: 400, chunkDelayMs: 100 })
  await new Promise(r => relay.listen(0, '127.0.0.1', r))
  try {
    const model = await createModel(`http://127.0.0.1:${relay.address().port}`)
    const novel = await (
      await fetch(`${base}/api/novels`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: '手改书', genre: '测试' })
      })
    ).json()
    await seedChapter(novel.id, ORIGINAL)

    const started = await (
      await fetch(`${base}/api/generate/chapter`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ novelId: novel.id, chapterIndex: 1, modelId: model.id, kind: 'polish' })
      })
    ).json()
    assert.ok(started.jobId)
    // 任务已捕获 beforeHash（runChapterJob 开头同步取），此刻手改正文
    await new Promise(r => setTimeout(r, 120))
    const manual = '作者在生成期间亲手改的内容，绝不能被停笔草稿覆盖。'.repeat(4)
    const put = await (
      await fetch(`${base}/api/novels/${novel.id}/chapters/1`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: manual })
      })
    ).json()
    assert.ok(put.chapter, '手改应成功落库')

    const job = await waitJob(started.jobId)
    assert.notEqual(job.savedDraft, true, '内容已变，防覆盖校验必须拒绝写入半截草稿')

    const after = await (await fetch(`${base}/api/novels/${novel.id}`)).json()
    assert.equal(after.chapters[0].content, manual, '手改内容应原样保留')
    assert.equal(after.chapters[0].status, 'done', '章节不应被降级为草稿')
    await fetch(`${base}/api/novels/${novel.id}`, { method: 'DELETE' })
  } finally {
    relay.close()
  }
})

// ---------- 知识库写串行化 ----------
test('知识库写队列：并发加文档与写问答全部落盘，不互相覆盖', { timeout: 30000 }, async () => {
  const kb = createKb('并发体检库', '')
  const content = '灵力体系分为练气筑基金丹元婴化神五个大境界，每个境界又分初中后三个小阶段。'.repeat(2)
  await Promise.all([
    addDoc(kb.id, { name: '文档A', content }),
    addDoc(kb.id, { name: '文档B', content: content + '补充内容使其与文档A不同。' }),
    pushQa(kb.id, { q: '境界怎么分？', a: '五个大境界。' }),
    addDoc(kb.id, {
      name: '文档C',
      content:
        '丹药体系：一品到九品，品阶越高越稀有。九品丹药传说可活死人肉白骨，整个修真界千年也炼不出一炉，炼制时需要九种离火与地心炎髓为引。'
    }),
    pushQa(kb.id, { q: '灵石汇率？', a: '一百下品兑一中品。' })
  ])
  const meta = listKb().find(k => k.id === kb.id)
  assert.equal(meta.docs.length, 3, '三篇文档都要在（并发写不能整档互吞）')
  assert.equal(
    meta.docs
      .map(d => d.name)
      .sort()
      .join(','),
    '文档A,文档B,文档C'
  )
  assert.equal(listQa(kb.id).length, 2, '两条问答都要在')
})

// ---------- startServer 幂等 ----------
test('startServer 幂等：同进程二次调用返回同一端口，不再抢实例锁', async () => {
  const again = await startServer(3789, { strictPort: true })
  assert.equal(again, port, '二次调用应直接返回现有监听端口（macOS activate 重建窗口路径）')
})

test.after(async () => {
  await stopServer()
  try {
    fs.rmSync(tmpData, { recursive: true, force: true })
  } catch {}
})
