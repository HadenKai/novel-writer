import assert from 'node:assert/strict'
import test from 'node:test'
import { createCodexClient, configureCodexClient } from '../server/codex-responses.mjs'
import { streamChat } from '../server/ai-transport.mjs'

const opts = {
  model: 'test-codex',
  connectionRef: 'tenant',
  messages: [
    { role: 'system', content: 'book rules' },
    { role: 'assistant', content: 'history' },
    {
      role: 'user',
      content: [
        { type: 'text', text: '描述图片' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,aA==' } }
      ]
    }
  ],
  temperature: 0.8,
  maxTokens: 100,
  reasoningEffort: 'default'
}
const event = (type, fields = {}) => ({ type, ...fields })
function sse(...events) {
  const data = Buffer.from(events.map(e => 'event: ' + e.type + '\r\ndata: ' + JSON.stringify(e) + '\r\n\r\n').join(''))
  return new Response(
    new ReadableStream({
      start(controller) {
        for (let i = 0; i < data.length; i += 2) controller.enqueue(data.subarray(i, i + 2))
        controller.close()
      }
    })
  )
}
const complete = event('response.completed', { response: { status: 'completed' } })
async function read(stream) {
  const events = []
  for await (const item of stream) events.push(item)
  return events
}

function fixture(fetchImpl) {
  const tokens = []
  const client = createCodexClient({
    appVersion: '0.1.0',
    auth: {
      status: () => ({ state: 'connected', connectionRef: 'tenant' }),
      async getCredential(ref, { rejectedAccessToken, signal } = {}) {
        assert.equal(ref, 'tenant')
        signal?.throwIfAborted()
        tokens.push(rejectedAccessToken)
        return { accessToken: rejectedAccessToken ? 'rotated' : 'initial', accountId: 'account-A', residency: 'us' }
      }
    },
    fetchImpl
  })
  return { client, tokens }
}

test('codex requests preserve instructions, history and images through streamChat', async t => {
  const { client } = fixture(async (url, options) => {
    assert.equal(url, 'https://chatgpt.com/backend-api/codex/responses')
    assert.equal(options.redirect, 'error')
    assert.equal(options.headers.Authorization, 'Bearer initial')
    assert.equal(options.headers['ChatGPT-Account-ID'], 'account-A')
    assert.equal(options.headers.originator, 'novel-writer')
    const body = JSON.parse(options.body)
    assert.equal(body.instructions, 'book rules')
    assert.deepEqual(
      body.input.map(item => item.role),
      ['assistant', 'user']
    )
    assert.deepEqual(body.input[1].content[1], {
      type: 'input_image',
      image_url: 'data:image/png;base64,aA==',
      detail: 'auto'
    })
    assert.equal(body.stream, true)
    assert.equal(body.store, false)
    assert.equal('max_output_tokens' in body, false)
    assert.equal('temperature' in body, false)
    return sse(
      event('response.reasoning_summary_text.delta', { delta: '规划' }),
      event('response.output_text.delta', { delta: '中文' }),
      complete
    )
  })
  configureCodexClient(client)
  t.after(() => configureCodexClient(null))
  assert.deepEqual(await read(streamChat({ ...opts, provider: 'chatgpt-subscription' })), [
    { type: 'reasoning', text: '规划' },
    { type: 'content', text: '中文' },
    { type: 'meta', truncated: false, finishReason: 'stop' }
  ])
})

test('codex stream distinguishes explicit truncation from missing terminal event with no replay', async () => {
  let calls = 0
  const { client } = fixture(async () => {
    calls++
    return calls === 1
      ? sse(event('response.incomplete', { response: { incomplete_details: { reason: 'max_output_tokens' } } }))
      : sse(event('response.output_text.delta', { delta: 'partial' }))
  })
  assert.deepEqual(await read(client.stream(opts)), [{ type: 'meta', finishReason: 'length', truncated: true }])
  const stream = client.stream(opts)
  assert.deepEqual((await stream.next()).value, { type: 'content', text: 'partial' })
  await assert.rejects(stream.next(), { code: 'CODEX_STREAM_INTERRUPTED' })
  assert.equal(calls, 2)
})

test('codex refreshes a pre-stream 401 once, reports quotas or permissions, and forwards cancellation', async () => {
  const refresh = fixture(async (_url, { headers }) =>
    headers.Authorization === 'Bearer initial' ? Response.json({}, { status: 401 }) : sse(complete)
  )
  await read(refresh.client.stream(opts))
  assert.deepEqual(refresh.tokens, [undefined, 'initial'])
  for (const [status, code, body = {}] of [
    [401, 'CODEX_RECONNECT'],
    [403, 'CODEX_MODEL_FORBIDDEN'],
    [403, 'CODEX_REGION_UNAVAILABLE', { error: { code: 'unsupported_country_region_territory' } }],
    [429, 'CODEX_RATE_LIMIT'],
    [401, 'CODEX_MODEL_FORBIDDEN', { error: { code: 'workspace_not_authorized' } }],
    [401, 'CODEX_MODEL_FORBIDDEN', { error: { code: 'insufficient_scope' } }],
    [401, 'CODEX_MODEL_FORBIDDEN', { detail: 'workspace is not authorized for this model' }],
    [401, 'CODEX_RATE_LIMIT', { error: { code: 'usage_limit_reached' } }]
  ]) {
    const f = fixture(async () => Response.json(body, { status }))
    await assert.rejects(read(f.client.stream(opts)), { code })
    assert.equal(f.tokens.length, status === 401 && code === 'CODEX_RECONNECT' ? 2 : 1)
  }
  const abort = new AbortController()
  const f = fixture(async (_url, { signal }) => {
    signal.addEventListener('abort', () => abortSeen.resolve())
    return sse(event('response.output_text.delta', { delta: 'first' }), complete)
  })
  const abortSeen = Promise.withResolvers()
  const iter = f.client.stream({ ...opts, signal: abort.signal })
  assert.equal((await iter.next()).value.text, 'first')
  abort.abort()
  await abortSeen.promise
  await assert.rejects(iter.next(), { name: 'AbortError' })
})

test('reasoning options follow the account catalog and unknown models use upstream defaults', async () => {
  const bodies = []
  let catalogCalls = 0
  const { client } = fixture(async (url, options) => {
    if (url.includes('/models?')) {
      catalogCalls++
      return Response.json({
        models: [
          {
            slug: 'with-summary',
            supported_reasoning_levels: [{ effort: 'low' }, { effort: 'xhigh' }, { effort: 'max' }],
            supports_reasoning_summary_parameter: true
          },
          {
            slug: 'without-summary',
            supported_reasoning_levels: [{ effort: 'medium' }],
            supports_reasoning_summary_parameter: false
          },
          { slug: 'no-effort', supported_reasoning_levels: [] }
        ]
      })
    }
    bodies.push(JSON.parse(options.body))
    return sse(complete)
  })
  for (const [model, reasoningEffort] of [
    ['with-summary', 'low'],
    ['with-summary', 'xhigh'],
    ['with-summary', 'max'],
    ['without-summary', 'medium'],
    ['without-summary', 'max'],
    ['no-effort', 'high'],
    ['manual-id', 'high'],
    ['with-summary', 'high']
  ]) {
    await read(client.stream({ ...opts, model, reasoningEffort }))
  }
  assert.equal(catalogCalls, 1)
  assert.deepEqual(
    bodies.map(body => body.reasoning),
    [
      { effort: 'low', summary: 'auto' },
      { effort: 'xhigh', summary: 'auto' },
      { effort: 'max', summary: 'auto' },
      { effort: 'medium' },
      undefined,
      undefined,
      undefined,
      undefined
    ]
  )
})

test('account catalog presents only unique visible slugs in account order', async () => {
  const { client } = fixture(async (url, { headers }) => {
    const upstream = new URL(url)
    assert.equal(upstream.origin + upstream.pathname, 'https://chatgpt.com/backend-api/codex/models')
    assert.equal(headers['ChatGPT-Account-ID'], 'account-A')
    if (upstream.searchParams.get('client_version') === '0.1.0') return Response.json({ models: [] })
    assert.equal(headers['User-Agent'], 'NovelWriter/0.1.0')
    return Response.json({
      models: [
        { slug: 'late', display_name: 'Late', priority: 10 },
        { slug: 'hide-me', visibility: 'hide' },
        {
          slug: 'first',
          display_name: 'First',
          priority: 1,
          supported_in_api: false,
          supported_reasoning_levels: [{ effort: 'high' }, { effort: 'xhigh' }, { effort: 'max' }, { effort: 'ultra' }]
        },
        { slug: 'first', display_name: 'Duplicate', priority: 2 }
      ]
    })
  })
  assert.deepEqual(await client.listModels('tenant'), [
    { id: 'first', label: 'First', reasoningEfforts: ['high', 'xhigh', 'max'] },
    { id: 'late', label: 'Late', reasoningEfforts: [] }
  ])
})
