// 联网检索端到端：模型发 webSearch → 服务端执行检索 → 来源回喂 → 模型带引用重写。
//
// 不访问公网：用一个本地假 SearXNG 提供搜索结果，用假中转站模拟模型两次回答。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-chat-research-'))

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
}

test('联网检索：动作触发检索、来源回喂、最终回答带引用', { timeout: 40000 }, async () => {
  // 假 SearXNG：返回一条固定来源
  const searchServer = http.createServer((req, res) => {
    if (!req.url.startsWith('/search')) return res.writeHead(404).end('no')
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        results: [
          {
            title: '珠海历史沿革',
            url: 'https://example.com/zhuhai-history',
            content: '珠海在 1980 年设立经济特区，此前隶属佛山地区。'
          }
        ]
      })
    )
  })
  const searchPort = await listen(searchServer)
  process.env.NOVEL_SEARCH_PROVIDER = 'searxng'
  process.env.SEARXNG_URL = `http://127.0.0.1:${searchPort}`
  process.env.NOVEL_DATA_DIR = tmpData

  const received = []
  // 假模型：第一次要求检索；收到检索结果后给出带 [1] 的回答并落一条素材
  const relay = http.createServer((req, res) => {
    if (!req.url.includes('/chat/completions')) return res.writeHead(404).end('no')
    let raw = ''
    req.on('data', c => (raw += c))
    req.on('end', () => {
      received.push(raw)
      const payload = JSON.parse(raw)
      const last = payload.messages?.[payload.messages.length - 1]
      const isFollowUp = String(last?.content || '').includes('【联网检索结果】')
      const content = isFollowUp
        ? '根据资料，珠海在 1980 年设立经济特区[1]。\n\n```json\n{"actions":[{"type":"addMaterial","text":"珠海：1980 年设立经济特区"}]}\n```'
        : '我先查一下资料。\n\n```json\n{"actions":[{"type":"webSearch","text":"珠海 历史沿革"}]}\n```'
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] }) + '\n\n')
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  const relayPort = await listen(relay)

  const { startServer, stopServer } = await import('../server/app.mjs')
  const port = await startServer(0)
  const base = `http://127.0.0.1:${port}`
  const post = (url, body) =>
    fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

  try {
    const model = await (
      await post('/api/models', {
        name: '检索模拟',
        baseUrl: `http://127.0.0.1:${relayPort}/v1`,
        apiKey: 'sk-test',
        model: 'm',
        isDefault: false
      })
    ).json()
    const novel = await (await post('/api/novels', { title: '检索测试书', genre: '测试' })).json()

    const chat = await (
      await post('/api/chat', {
        novelId: novel.id,
        message: '查一下珠海的历史沿革',
        modelId: model.id,
        applyActions: true
      })
    ).json()
    assert.ok(chat.jobId)

    let job = null
    for (let i = 0; i < 80; i++) {
      await new Promise(r => setTimeout(r, 100))
      job = await (await fetch(`${base}/api/jobs/${chat.jobId}`)).json()
      if (job.status !== 'running') break
    }
    assert.equal(job.status, 'done', `检索对话应正常结束：${job.status} ${job.error || ''}`)

    assert.equal(received.length, 2, '应触发一次「检索结果回喂」')
    assert.match(received[1], /【联网检索结果】/)
    assert.match(received[1], /example\.com\/zhuhai-history/, '回喂内容里应带来源 URL')

    const session = await (await fetch(`${base}/api/novels/${novel.id}/chat/${chat.sessionId}`)).json()
    const assistant = [...(session.session?.messages || [])].reverse().find(m => m.role === 'assistant')
    assert.ok(assistant, '应有助手消息')
    assert.match(assistant.content, /\[1\]/, '最终回答应保留来源引用')
    assert.ok(assistant.research?.sources?.length >= 1, '消息上应带检索来源')
    assert.equal(assistant.research.sources[0].url, 'https://example.com/zhuhai-history')

    // 检索动作只用于触发检索，不进入已应用动作；真正的落库动作仍然生效
    assert.ok(!job.actions.some(a => a.type === 'webSearch'), 'webSearch 不应作为已应用动作返回')
    assert.ok(
      job.actions.some(a => a.type === 'addMaterial' && a.status === 'applied'),
      '后续落库动作应生效'
    )
  } finally {
    await stopServer()
    searchServer.close()
    relay.close()
  }
})
