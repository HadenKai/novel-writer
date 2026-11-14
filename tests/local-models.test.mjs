// 本地模型探测：只探私有地址、容忍两种返回形态、没有密钥也不发 Authorization。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { isLoopbackHost, probeLocalEndpoint, scanLocalEndpoints } from '../server/local-models.mjs'

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
}

test('本地模型探测：地址白名单、模型解析、鉴权服务如实标注', { timeout: 20000 }, async () => {
  // 1) 标准 OpenAI 形态，不鉴权
  const open = http.createServer((req, res) => {
    if (req.headers.authorization) {
      res.writeHead(400).end('local server should not receive authorization')
      return
    }
    if (!req.url.startsWith('/v1/models')) return res.writeHead(404).end('no')
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'qwen2.5:7b' }, { id: 'llama3.1:8b' }] }))
  })
  const openPort = await listen(open)

  // 2) Ollama 原生形态（models[].name），且只提供 /api/tags
  const native = http.createServer((req, res) => {
    if (!req.url.startsWith('/api/tags')) return res.writeHead(404).end('no')
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ models: [{ name: 'deepseek-r1:14b' }] }))
  })
  const nativePort = await listen(native)

  // 3) 要求鉴权的服务
  const guarded = http.createServer((_req, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'missing api key' } }))
  })
  const guardedPort = await listen(guarded)

  try {
    assert.equal(isLoopbackHost('127.0.0.1'), true)
    assert.equal(isLoopbackHost('localhost'), true)
    assert.equal(isLoopbackHost('192.168.1.8'), true)
    assert.equal(isLoopbackHost('example.com'), false)

    const a = await probeLocalEndpoint(`http://127.0.0.1:${openPort}/v1`)
    assert.equal(a.online, true)
    assert.deepEqual(a.models, ['qwen2.5:7b', 'llama3.1:8b'])
    assert.equal(a.baseUrl, `http://127.0.0.1:${openPort}/v1`)

    const b = await probeLocalEndpoint(`http://127.0.0.1:${nativePort}`)
    assert.equal(b.online, true, '只有 /api/tags 的老版 Ollama 也应被识别')
    assert.deepEqual(b.models, ['deepseek-r1:14b'])
    assert.equal(b.native, 'ollama')

    const c = await probeLocalEndpoint(`http://127.0.0.1:${guardedPort}/v1`)
    assert.equal(c.online, false)
    assert.match(c.error, /鉴权/)

    const outside = await probeLocalEndpoint('https://api.example.com/v1')
    assert.equal(outside.online, false)
    assert.match(outside.error, /本机|局域网/)

    const found = await scanLocalEndpoints({
      extra: [`http://127.0.0.1:${openPort}/v1`, `http://127.0.0.1:${guardedPort}/v1`],
      timeoutMs: 800
    })
    const urls = found.map(f => f.baseUrl)
    assert.ok(urls.includes(`http://127.0.0.1:${openPort}/v1`))
    assert.ok(!urls.includes(`http://127.0.0.1:${guardedPort}/v1`))
    assert.ok(
      found.every(f => f.models.length > 0),
      '扫描结果必须带模型列表'
    )
  } finally {
    open.close()
    native.close()
    guarded.close()
  }
})
