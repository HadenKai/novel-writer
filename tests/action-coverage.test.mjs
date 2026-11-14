// 动作覆盖与自愈回环。
//
// 两个需求：
//  1. 「漏改一处即静默失败」的正面防线 —— 注册表里声明的每种动作，都必须被
//     applyChatActions 真正处理。以前往 types.ts 加动作却忘了在巨型 if 里加分支，
//     表现只是模型收到一句「动作暂未实现」，作者完全看不出来。
//  2. 参考 coding agent 的「工具结果回喂」：动作被拒时把拒因回喂一次让模型自修。
//     这里用本地假中转站，让模型第一次给坏动作、第二次给好动作，验证回环真的生效。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-action-coverage-'))
process.env.NOVEL_DATA_DIR = tmpData

const { startServer, stopServer, applyChatActions, undoChatAction } = await import('../server/app.mjs')
const { TOOLS, TEXT_KIND } = await import('../server/agent/tools.mjs')
const { chatMessages, extractChatActions } = await import('../server/ai.mjs')
const { snapshotChapters } = await import('../server/store.mjs')

/** 按 text 形态给一个能走进实现分支的样本（只求走到分支，不追求语义正确） */
const SAMPLE = {
  [TEXT_KIND.text]: '示例内容',
  [TEXT_KIND.json]:
    '{"name":"测试","role":"配角","title":"示例","summary":"示例","goal":"示例","start":1,"replacement":"示例","plotline":"主线"}',
  [TEXT_KIND.number]: '30',
  [TEXT_KIND.enum]: 'first',
  [TEXT_KIND.name]: '测试',
  [TEXT_KIND.none]: ''
}

const baseNovel = () => ({
  id: 'cov',
  title: '覆盖测试',
  genre: '测试',
  authorStyleId: '',
  templateId: '',
  skillIds: [],
  characters: [{ id: 'c1', name: '测试', role: '配角', personality: '', appearance: '', background: '', notes: '' }],
  plotlines: [
    { id: 'p1', name: '主线', type: '主线', goal: '', description: '', status: 'active', beats: [], characters: [] }
  ],
  outline: [{ index: 1, title: '第一章', summary: '摘要', customPrompt: '', oid: 'o1' }],
  chapters: [
    { index: 1, title: '第一章', content: '第一段。\n\n第二段。\n\n第三段。', words: 13, status: 'done', oid: 'o1' }
  ],
  modelId: '',
  chapterCount: 12,
  targetWords: 2000,
  pov: 'third',
  linkContext: true,
  mobileReading: false
})

// 已下线的 execute 动作：提示词禁止输出，后端也必须拒绝（防模型不守规矩触发整书连写）
const RETIRED_ACTIONS = ['generateMaster', 'generateOutline', 'rewriteOutline', 'writeChapter', 'generateAll']

test('动作覆盖：注册表里的每种动作都能走到 applyChatActions 的实现分支', () => {
  const misses = []
  for (const tool of TOOLS) {
    if (RETIRED_ACTIONS.includes(tool.name)) continue
    const applied = applyChatActions(baseNovel(), [{ type: tool.name, chapter: 1, text: SAMPLE[tool.kind] }], {
      spawnJob: () => ({ id: 'job-x' }),
      models: [],
      allowDangerous: true
    })
    assert.equal(applied.length, 1, `${tool.name} 未产出结果`)
    if (/暂未实现/.test(applied[0].reason || '')) misses.push(tool.name)
  }
  assert.deepEqual(misses, [], `以下动作在 applyChatActions 里没有实现分支，会被静默拒绝：${misses.join(', ')}`)
})

test('已下线动作一律拒绝，且不会触发任何后台任务', () => {
  let spawned = 0
  for (const name of RETIRED_ACTIONS) {
    const applied = applyChatActions(baseNovel(), [{ type: name, chapter: 1, text: '' }], {
      spawnJob: () => {
        spawned++
        return { id: 'job-x' }
      },
      models: [],
      allowDangerous: true
    })
    assert.equal(applied.length, 1, `${name} 应产出结果`)
    assert.equal(applied[0].status, 'rejected', `${name} 已下线，必须被拒`)
    assert.match(applied[0].reason || '', /已下线/)
  }
  assert.equal(spawned, 0, '已下线动作不应 spawn 任何任务')
})

test('deleteParagraph 接受承诺的纯文本格式："2" / "2,3" / 非连续 "1,3,5"', () => {
  const five = () => {
    const n = baseNovel()
    n.chapters[0].content = '第一段。\n\n第二段。\n\n第三段。\n\n第四段。\n\n第五段。'
    return n
  }
  const single = applyChatActions(five(), [{ type: 'deleteParagraph', chapter: 1, text: '2' }], { models: [] })
  assert.equal(single[0].status, 'applied', `纯数字应被接受：${single[0].reason || ''}`)

  const n2 = five()
  const range = applyChatActions(n2, [{ type: 'deleteParagraph', chapter: 1, text: '2,3' }], { models: [] })
  assert.equal(range[0].status, 'applied', `逗号连续段号应被接受：${range[0].reason || ''}`)
  assert.equal(n2.chapters[0].content, '第一段。\n\n第四段。\n\n第五段。')

  const n3 = five()
  const scattered = applyChatActions(n3, [{ type: 'deleteParagraph', chapter: 1, text: '1,3,5' }], { models: [] })
  assert.equal(scattered[0].status, 'applied', `非连续段号应被接受：${scattered[0].reason || ''}`)
  assert.equal(n3.chapters[0].content, '第二段。\n\n第四段。')
  assert.equal(undoChatAction(n3, scattered[0]).ok, true)
  assert.equal(n3.chapters[0].content, '第一段。\n\n第二段。\n\n第三段。\n\n第四段。\n\n第五段。')
})

test('扁平字段输出不再被误拒：removeCharacter 顶层 name 经 extractChatActions 保留', () => {
  const { actions } = extractChatActions('```json\n{"actions":[{"type":"removeCharacter","name":"测试"}]}\n```')
  const novel = baseNovel()
  const applied = applyChatActions(novel, actions, { models: [] })
  assert.equal(applied[0].status, 'applied', `扁平 name 应被保留并生效：${applied[0].reason || ''}`)
  assert.equal(novel.characters.length, 0)
})

test('追加类动作语义：写复数字段、提示词可读、撤销恢复原值', () => {
  const novel = baseNovel()
  novel.elements = '已有元素'
  novel.extraRequirements = '已有要求'
  const applied = applyChatActions(
    novel,
    [
      { type: 'element', text: '新增剧情元素' },
      { type: 'extraRequirement', text: '新增额外要求' }
    ],
    { models: [] }
  )
  assert.deepEqual(
    applied.map(a => a.status),
    ['applied', 'applied']
  )
  // 落库到真实字段：此前 bug 写单数幻影字段，所有提示词读复数，追加静默无效
  assert.equal(novel.elements, '已有元素\n新增剧情元素')
  assert.equal(novel.extraRequirements, '已有要求\n新增额外要求')
  assert.equal(novel.element, undefined, '不应产生单数幻影字段')
  assert.equal(novel.extraRequirement, undefined)
  const prompt = JSON.stringify(chatMessages(novel, []))
  assert.match(prompt, /新增剧情元素/)
  assert.match(prompt, /新增额外要求/)
  // 撤销恢复原值，而不是把从幻影字段读出的空串盖回真实字段
  assert.equal(undoChatAction(novel, applied[0]).ok, true)
  assert.equal(undoChatAction(novel, applied[1]).ok, true)
  assert.equal(novel.elements, '已有元素')
  assert.equal(novel.extraRequirements, '已有要求')
})

test('追加类动作：空内容被拒并给出原因', () => {
  const applied = applyChatActions(baseNovel(), [{ type: 'element', text: '' }], { models: [] })
  assert.equal(applied[0].status, 'rejected')
  assert.match(applied[0].reason, /为空/)
})

test('旧数据迁移：单数幻影字段合并回复数字段后清除', { timeout: 20000 }, async () => {
  const port = await startServer(0)
  const base = `http://127.0.0.1:${port}`
  try {
    const created = await (
      await fetch(base + '/api/novels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: '迁移测试', genre: '测试' })
      })
    ).json()
    // 直接往盘上文件里塞旧版 bug 写出的幻影字段
    const file = path.join(tmpData, 'novels', `${created.id}.json`)
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    raw.elements = '正常元素'
    raw.element = '误写的元素'
    raw.extraRequirement = '误写的要求'
    fs.writeFileSync(file, JSON.stringify(raw))
    const got = await (await fetch(`${base}/api/novels/${created.id}`)).json()
    assert.match(got.elements, /正常元素/)
    assert.match(got.elements, /误写的元素/)
    assert.match(got.extraRequirements, /误写的要求/)
    assert.equal(got.element, undefined)
    assert.equal(got.extraRequirement, undefined)
  } finally {
    await stopServer()
  }
})

test('删整章留历史快照：deleteParagraph 删光全章时 pushHistory', () => {
  const novel = baseNovel()
  const applied = applyChatActions(novel, [{ type: 'deleteParagraph', chapter: 1, text: '{"start":1,"count":0}' }], {
    models: []
  })
  assert.equal(applied[0].status, 'applied')
  assert.equal(novel.chapters[0].content, '')
  const file = path.join(tmpData, 'history', 'cov.json')
  assert.ok(fs.existsSync(file), '整章删空应留历史快照')
  const list = JSON.parse(fs.readFileSync(file, 'utf8'))
  const entry = list.find(h => /删空第1章前/.test(h.label))
  assert.ok(entry, '快照标签应标明删空')
  const restored = snapshotChapters(novel, entry.snapshot)
  assert.match(restored[0].content, /第一段/)
})

test('删除部分段落不触发历史快照（动作快照已够撤销）', () => {
  const novel = baseNovel()
  novel.id = 'cov-partial'
  const applied = applyChatActions(novel, [{ type: 'deleteParagraph', chapter: 1, text: '{"start":2,"count":1}' }], {
    models: []
  })
  assert.equal(applied[0].status, 'applied')
  assert.match(novel.chapters[0].content, /第一段/)
  assert.equal(fs.existsSync(path.join(tmpData, 'history', 'cov-partial.json')), false)
})

test('管家自愈回环：动作被拒后把拒因回喂，模型改对并成功落库', { timeout: 40000 }, async () => {
  const received = []
  // 假中转站：第 1 次给一个必然被拒的动作（insertParagraph 的 replacement 为空），
  // 第 2 次给修正后的合法动作。同时记录请求体，用来断言回执确实发出去了。
  const relay = http.createServer((req, res) => {
    if (!req.url.includes('/chat/completions')) {
      res.writeHead(404).end('no')
      return
    }
    let raw = ''
    req.on('data', c => (raw += c))
    req.on('end', () => {
      received.push(raw)
      const first = received.length === 1
      const action = first
        ? { type: 'insertParagraph', chapter: 1, text: '{"start":1,"replacement":""}' }
        : { type: 'insertParagraph', chapter: 1, text: '{"start":1,"replacement":"修正后插入的段落。"}' }
      const content = `好的。\n\n\`\`\`json\n${JSON.stringify({ actions: [action] })}\n\`\`\``
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] }) + '\n\n')
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  await new Promise(r => relay.listen(0, '127.0.0.1', r))
  const relayBase = `http://127.0.0.1:${relay.address().port}`

  const port = await startServer(0)
  const base = `http://127.0.0.1:${port}`
  const post = (url, body) =>
    fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

  try {
    const model = await (
      await post('/api/models', {
        name: '回环模拟',
        baseUrl: `${relayBase}/v1`,
        apiKey: 'sk-test',
        model: 'm',
        isDefault: false
      })
    ).json()

    const novel = await (await post('/api/novels', { title: '回环测试书', genre: '测试' })).json()
    // 正文必须走导入接口写入：PUT /api/novels/:id 刻意不接受 chapters（章节有专用接口）
    const imported = await (
      await post(`/api/novels/${novel.id}/import`, {
        text: '第一章 开端\n第一段。\n\n第二段。\n\n第三段。',
        replace: true
      })
    ).json()
    assert.ok(imported.chapters >= 1, '导入应至少生成一章正文')

    const chat = await (
      await post('/api/chat', {
        novelId: novel.id,
        message: '在第 1 章开头插一段',
        modelId: model.id,
        applyActions: true
      })
    ).json()
    assert.ok(chat.jobId)

    let job = null
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 100))
      job = await (await fetch(`${base}/api/jobs/${chat.jobId}`)).json()
      if (job.status !== 'running') break
    }
    assert.equal(job.status, 'done', `对话任务应正常结束，实际：${job.status} ${job.error || ''}`)

    // 回环确实发生了：模型被调用了两次
    assert.equal(received.length, 2, `应触发一次自愈重试，实际请求 ${received.length} 次`)
    // 第二次请求里带上了系统回执与拒因
    assert.match(received[1], /系统回执/)
    assert.match(received[1], /插入内容为空/)
    // 并且附上了该动作对 text 形态的要求（注册表提供的纠正建议）
    assert.match(received[1], /JSON/)

    // 修正后的动作真的落库了
    const after = await (await fetch(`${base}/api/novels/${novel.id}`)).json()
    assert.match(after.chapters[0].content, /修正后插入的段落。/)

    // 同一条消息的动作快照里同时能看到「被拒的原动作」与「修正后的动作」
    assert.equal(job.actions.length, 2)
    assert.equal(job.actions[0].status, 'rejected')
    assert.equal(job.actions[1].status, 'applied')
  } finally {
    relay.close()
    await stopServer()
  }
})

test('停笔：半截回复剥离动作块后落库，聊天记录不留裸 JSON', { timeout: 40000 }, async () => {
  // 假中转站：流式吐出正文 + 一段完整的 ```json 动作块，随后挂住连接（回合未结束），
  // 模拟推理模型刚写完动作块、用户就点了停止
  let hits = 0
  const relay = http.createServer((req, res) => {
    if (!req.url.includes('/chat/completions')) {
      res.writeHead(404).end('no')
      return
    }
    req.resume()
    let raw = ''
    req.on('data', c => (raw += c))
    req.on('end', () => {
      hits++
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const parts = [
        '可以，先把方向定清楚。\n\n',
        '我建议先搜一下同类题材。\n\n',
        '```json\n{"actions":[{"type":"webSearch","text":"明朝 历史小说"}]}\n```'
      ]
      let i = 0
      const timer = setInterval(() => {
        if (i >= parts.length) {
          clearInterval(timer)
          return
        }
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: parts[i++] } }] }) + '\n\n')
      }, 100)
      res.on('close', () => clearInterval(timer))
    })
  })
  await new Promise(r => relay.listen(0, '127.0.0.1', r))
  const relayBase = `http://127.0.0.1:${relay.address().port}`

  const port = await startServer(0)
  const base = `http://127.0.0.1:${port}`
  const post = (url, body) =>
    fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const sleep = ms => new Promise(r => setTimeout(r, ms))

  try {
    const model = await (
      await post('/api/models', {
        name: '停笔模拟',
        baseUrl: `${relayBase}/v1`,
        apiKey: 'sk-test',
        model: 'm',
        isDefault: false
      })
    ).json()
    const novel = await (await post('/api/novels', { title: '停笔测试书', genre: '测试' })).json()
    const chat = await (
      await post('/api/chat', { novelId: novel.id, message: '搜一下同类题材', modelId: model.id })
    ).json()
    assert.ok(chat.jobId && chat.sessionId)

    // 等流把动作块也吐出来，再点停止（此时回合尚未结束，动作没有执行过）
    let job = null
    for (let i = 0; i < 100; i++) {
      await sleep(100)
      job = await (await fetch(`${base}/api/jobs/${chat.jobId}`)).json()
      if ((job.stream || '').includes('```json')) break
    }
    assert.match(
      job.stream || '',
      /```json/,
      `假模型应已输出动作块（status=${job.status} err=${job.error || ''} hits=${hits} len=${(job.stream || '').length}）`
    )
    await post(`/api/jobs/${chat.jobId}/stop`, {})
    for (let i = 0; i < 100; i++) {
      await sleep(100)
      job = await (await fetch(`${base}/api/jobs/${chat.jobId}`)).json()
      if (job.status !== 'running') break
    }
    assert.equal(job.status, 'stopped')

    const session = await (await fetch(`${base}/api/novels/${novel.id}/chat/${chat.sessionId}`)).json()
    const last = (session.session?.messages || []).filter(m => m.role === 'assistant').slice(-1)[0]
    assert.ok(last, '停止后应保存已生成的部分')
    assert.match(last.content, /先把方向定清楚/)
    assert.ok(!last.content.includes('```'), '停止后的消息不应保存裸 JSON 动作块')
    assert.ok(!last.content.includes('webSearch'), '动作块内容不应残留')
    assert.equal((last.actions || []).length, 0, '未完成回合的动作不应被应用')
  } finally {
    relay.close()
    await stopServer()
  }
})

test('停笔于自愈轮：已应用动作的快照必须随消息落库（否则无从撤销）', { timeout: 40000 }, async () => {
  // 第 1 回合：一个能落库的动作（改主角）+ 一个必被拒的动作（空 replacement）→ 触发自愈轮；
  // 第 2 回合（自愈）挂住连接，模拟作者在自愈期间点停止
  const received = []
  const relay = http.createServer((req, res) => {
    if (!req.url.includes('/chat/completions')) {
      res.writeHead(404).end('no')
      return
    }
    let raw = ''
    req.on('data', c => (raw += c))
    req.on('end', () => {
      received.push(raw)
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      if (received.length === 1) {
        const actions = [
          { type: 'protagonist', text: JSON.stringify({ name: '新主角', role: '主角' }) },
          { type: 'insertParagraph', chapter: 1, text: '{"start":1,"replacement":""}' }
        ]
        const content = `先把主角定下来。\n\n\`\`\`json\n${JSON.stringify({ actions })}\n\`\`\``
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] }) + '\n\n')
        res.write('data: [DONE]\n\n')
        res.end()
      } else {
        const timer = setInterval(() => {
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: '修正中……' } }] }) + '\n\n')
        }, 150)
        res.on('close', () => clearInterval(timer))
      }
    })
  })
  await new Promise(r => relay.listen(0, '127.0.0.1', r))
  const relayBase = `http://127.0.0.1:${relay.address().port}`

  const port = await startServer(0)
  const base = `http://127.0.0.1:${port}`
  const post = (url, body) =>
    fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const sleep = ms => new Promise(r => setTimeout(r, ms))

  try {
    const model = await (
      await post('/api/models', {
        name: '自愈停笔模拟',
        baseUrl: `${relayBase}/v1`,
        apiKey: 'sk-test',
        model: 'm',
        isDefault: false
      })
    ).json()
    const novel = await (await post('/api/novels', { title: '自愈停笔书', genre: '测试' })).json()
    await post(`/api/novels/${novel.id}/import`, { text: '第一章 开端\n第一段。\n\n第二段。', replace: true })
    const chat = await (
      await post('/api/chat', {
        novelId: novel.id,
        message: '改主角并插段',
        modelId: model.id,
        applyActions: true
      })
    ).json()
    assert.ok(chat.jobId && chat.sessionId)

    // 等自愈轮真的发起（第 2 次请求到达假中转站），再停笔
    for (let i = 0; i < 200 && received.length < 2; i++) await sleep(50)
    assert.ok(received.length >= 2, '应已进入自愈轮')
    await post(`/api/jobs/${chat.jobId}/stop`, {})
    let job = null
    for (let i = 0; i < 100; i++) {
      await sleep(100)
      job = await (await fetch(`${base}/api/jobs/${chat.jobId}`)).json()
      if (job.status !== 'running') break
    }
    assert.equal(job.status, 'stopped')

    // 主角真的被改过 → 消息里必须带快照，前端才有撤销入口
    const after = await (await fetch(`${base}/api/novels/${novel.id}`)).json()
    assert.equal(after.protagonist?.name, '新主角')
    const session = await (await fetch(`${base}/api/novels/${novel.id}/chat/${chat.sessionId}`)).json()
    const last = (session.session?.messages || []).filter(m => m.role === 'assistant').slice(-1)[0]
    assert.ok(last, '停笔后应保存消息')
    assert.match(last.content, /先把主角定下来/)
    assert.ok(!last.content.includes('```'), '动作围栏不应残留')
    assert.equal((last.actions || []).length, 2, '已应用 + 被拒动作都应进快照')
    assert.ok(
      last.actions.some(a => a.type === 'protagonist' && a.status === 'applied'),
      '改主角的快照必须可撤销'
    )
  } finally {
    relay.close()
    await stopServer()
  }
})

test('停笔于检索轮：保存的是作者最后看到的第二轮正文，而非首轮', { timeout: 40000 }, async () => {
  // 第 1 回合：正文 + fetchPage 动作（指向内网地址，离线即可得到「失败记录」，不触发真实外网）；
  // 第 2 回合（检索整理）慢速吐字并挂住，模拟作者在整理期间停笔
  let hits = 0
  const relay = http.createServer((req, res) => {
    if (!req.url.includes('/chat/completions')) {
      res.writeHead(404).end('no')
      return
    }
    let raw = ''
    req.on('data', c => (raw += c))
    req.on('end', () => {
      hits++
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      if (hits === 1) {
        const actions = [{ type: 'fetchPage', text: 'http://127.0.0.1:9/page' }]
        const content = `第一轮回答。\n\n\`\`\`json\n${JSON.stringify({ actions })}\n\`\`\``
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] }) + '\n\n')
        res.write('data: [DONE]\n\n')
        res.end()
      } else {
        const parts = ['第二轮：', '根据检索结果', '整理后的回答……']
        let i = 0
        const timer = setInterval(() => {
          if (i >= parts.length) {
            clearInterval(timer)
            return
          }
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: parts[i++] } }] }) + '\n\n')
        }, 120)
        res.on('close', () => clearInterval(timer))
      }
    })
  })
  await new Promise(r => relay.listen(0, '127.0.0.1', r))
  const relayBase = `http://127.0.0.1:${relay.address().port}`

  const port = await startServer(0)
  const base = `http://127.0.0.1:${port}`
  const post = (url, body) =>
    fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const sleep = ms => new Promise(r => setTimeout(r, ms))

  try {
    const model = await (
      await post('/api/models', {
        name: '检索停笔模拟',
        baseUrl: `${relayBase}/v1`,
        apiKey: 'sk-test',
        model: 'm',
        isDefault: false
      })
    ).json()
    const novel = await (await post('/api/novels', { title: '检索停笔书', genre: '测试' })).json()
    const chat = await (
      await post('/api/chat', {
        novelId: novel.id,
        message: '查一下资料再回答',
        modelId: model.id,
        applyActions: true
      })
    ).json()
    assert.ok(chat.jobId && chat.sessionId)

    // 等第二轮正文开始流式展示（job.stream 已被重置为第二轮内容）再停笔
    let job = null
    for (let i = 0; i < 200; i++) {
      await sleep(100)
      job = await (await fetch(`${base}/api/jobs/${chat.jobId}`)).json()
      if ((job.stream || '').includes('第二轮')) break
    }
    assert.match(job.stream || '', /第二轮/, `应已进入检索整理轮（hits=${hits} status=${job.status}）`)
    await post(`/api/jobs/${chat.jobId}/stop`, {})
    for (let i = 0; i < 100; i++) {
      await sleep(100)
      job = await (await fetch(`${base}/api/jobs/${chat.jobId}`)).json()
      if (job.status !== 'running') break
    }
    assert.equal(job.status, 'stopped')

    const session = await (await fetch(`${base}/api/novels/${novel.id}/chat/${chat.sessionId}`)).json()
    const last = (session.session?.messages || []).filter(m => m.role === 'assistant').slice(-1)[0]
    assert.ok(last, '停笔后应保存消息')
    assert.match(last.content, /第二轮/, '应保存作者最后看到的检索轮正文')
    assert.ok(!last.content.includes('第一轮回答'), '不应回退保存首轮正文')
    assert.ok(!last.content.includes('```'), '动作围栏不应残留')
  } finally {
    relay.close()
    await stopServer()
  }
})

test('任务 SSE：增量分批推送正文，结束时下发终态', { timeout: 40000 }, async () => {
  // 假中转站：每 150ms 吐一段，共三段后正常收尾
  const relay = http.createServer((req, res) => {
    if (!req.url.includes('/chat/completions')) {
      res.writeHead(404).end('no')
      return
    }
    req.resume()
    let raw = ''
    req.on('data', c => (raw += c))
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const parts = ['第一段。\n\n', '第二段。\n\n', '第三段。']
      let i = 0
      const timer = setInterval(() => {
        if (i >= parts.length) {
          clearInterval(timer)
          res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\n')
          res.write('data: [DONE]\n\n')
          res.end()
          return
        }
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: parts[i++] } }] }) + '\n\n')
      }, 150)
      res.on('close', () => clearInterval(timer))
    })
  })
  await new Promise(r => relay.listen(0, '127.0.0.1', r))
  const relayBase = `http://127.0.0.1:${relay.address().port}`

  const port = await startServer(0)
  const base = `http://127.0.0.1:${port}`
  const post = (url, body) =>
    fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

  try {
    const model = await (
      await post('/api/models', {
        name: 'SSE 模拟',
        baseUrl: `${relayBase}/v1`,
        apiKey: 'sk-test',
        model: 'm',
        isDefault: false
      })
    ).json()
    const novel = await (await post('/api/novels', { title: 'SSE 测试书', genre: '测试' })).json()
    const chat = await (await post('/api/chat', { novelId: novel.id, message: '测试流式', modelId: model.id })).json()
    assert.ok(chat.jobId)

    const res = await fetch(`${base}/api/jobs/${chat.jobId}/events`)
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type') || '', /text\/event-stream/)
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    const events = []
    const t0 = Date.now()
    let buf = ''
    while (Date.now() - t0 < 20000) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let idx
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        if (!line.startsWith('data:')) continue
        events.push(JSON.parse(line.slice(5).trim()))
      }
      if (events.some(e => e.done)) break
    }
    await reader.cancel().catch(() => {})

    const meta = events.find(e => e.meta)
    assert.ok(meta, '连接应先下发任务元信息')
    assert.equal(meta.meta.status, 'running')
    assert.equal(meta.meta.stream, undefined, '元信息不应携带整段正文')
    const streams = events.filter(e => typeof e.stream === 'string')
    assert.ok(streams.length >= 2, `正文应分批推送（实际 ${streams.length} 批）`)
    const text = streams.map(e => e.stream).join('')
    assert.match(text, /第一段/)
    assert.match(text, /第三段/)
    const doneEvt = events.find(e => e.done)
    assert.ok(doneEvt, '应收到结束帧')
    assert.equal(doneEvt.job.status, 'done')
    assert.equal((doneEvt.job.stream || '').trim(), text.trim(), '结束帧正文应与增量拼接结果一致')
  } finally {
    relay.close()
    await stopServer()
  }
})
