// 联网检索：解析与安全边界测试（不访问网络；fetchPage 用假 fetch 驱动）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// fetchPage 失败会 appendLog，先把数据目录引到临时目录再加载模块
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-research-'))
const {
  collectResearch,
  decodeBingUrl,
  fetchPage,
  formatResearchContext,
  htmlToText,
  isSafePublicUrl,
  mergeResearch,
  parseBingResults
} = await import('../server/research.mjs')

const BING_FIXTURE = `
<ol id="b_results">
  <li class="b_algo" data-id="1">
    <h2><a href="https://www.bing.com/ck/a?!&&p=abc&u=a1aHR0cHM6Ly9leGFtcGxlLmNvbS9h&ntb=1" h="ID=SERP,1">示例<strong>标题</strong></a></h2>
    <div class="b_caption"><p class="b_lineclamp2">这是第一条<em>摘要</em>，含 &amp; 实体。</p></div>
  </li>
  <li class="b_algo" data-id="2">
    <h2><a href="https://example.org/b">第二条</a></h2>
    <p class="b_lineclamp4">第二条摘要</p>
  </li>
</ol>`

test('联网检索：Bing 结果解析 / 跳转链接还原 / 内网地址拦截', async () => {
  const results = parseBingResults(BING_FIXTURE, 5)
  assert.equal(results.length, 2)
  assert.equal(results[0].title, '示例标题')
  assert.equal(results[0].url, 'https://example.com/a', 'Bing 跳转链接应还原成真实地址')
  assert.match(results[0].snippet, /第一条摘要/)
  assert.equal(results[1].url, 'https://example.org/b')

  assert.equal(decodeBingUrl('https://example.com/x'), 'https://example.com/x')

  assert.equal(isSafePublicUrl('https://example.com/a').ok, true)
  assert.equal(isSafePublicUrl('http://127.0.0.1:3789/api/novels').ok, false)
  assert.equal(isSafePublicUrl('http://localhost/admin').ok, false)
  assert.equal(isSafePublicUrl('http://192.168.1.2/').ok, false)
  assert.equal(isSafePublicUrl('http://10.0.0.5/').ok, false)
  assert.equal(isSafePublicUrl('file:///C:/Windows/win.ini').ok, false)
  assert.equal(isSafePublicUrl('https://user:pass@example.com/').ok, false)
  assert.equal(isSafePublicUrl('http://[::ffff:127.0.0.1]/').ok, false, 'IPv4 映射的回环地址要拦截')
  assert.equal(isSafePublicUrl('http://[fd00::1]/').ok, false, 'fd00::/8 内网段要拦截')

  const text = htmlToText('<div>标题 &amp; 正文<script>alert(1)</script><p>下一段</p></div>')
  assert.match(text, /标题 & 正文/)
  assert.match(text, /下一段/)
  assert.ok(!text.includes('alert(1)'), '脚本内容不能进入正文')

  const context = formatResearchContext({
    queries: [
      { query: '珠海历史', provider: 'bing' },
      { query: '失败查询', provider: 'bing', error: '超时' }
    ],
    pages: [{ url: 'https://example.com/x', error: '403' }],
    sources: [
      { title: '示例一', url: 'https://example.com/1', snippet: '摘要一' },
      { title: '示例二', url: 'https://example.com/2', excerpt: '正文摘录二' }
    ]
  })
  assert.match(context, /\[1\] 示例一/)
  assert.match(context, /\[2\] 示例二/)
  assert.match(context, /搜索「失败查询」失败：超时/)
  assert.match(context, /读取 https:\/\/example.com\/x 失败：403/)
})

test('联网检索：单轮限流、来源去重与失败记录', async () => {
  const fakeSearch = async query => ({
    query,
    provider: 'fake',
    results: [
      { title: `标题 ${query}`, url: `https://example.com/${query}`, snippet: '摘要' },
      { title: '重复来源', url: 'https://example.com/shared', snippet: '共享摘要' }
    ]
  })
  const fakeFetch = async url => ({ url, title: '网页', text: '正文'.repeat(800) })

  const first = await collectResearch(
    [
      { type: 'webSearch', text: 'a' },
      { type: 'webSearch', text: 'b' },
      { type: 'webSearch', text: 'c' },
      { type: 'webSearch', text: 'd' },
      { type: 'fetchPage', text: 'https://example.com/a' },
      { type: 'fetchPage', text: 'https://example.com/b' },
      { type: 'fetchPage', text: 'https://example.com/c' }
    ],
    { search: fakeSearch, fetch: fakeFetch }
  )
  assert.equal(first.queries.length, 3, '单轮最多执行 3 次搜索')
  assert.equal(first.pages.length, 2, '单轮最多执行 2 次读页')
  assert.ok(first.sources.length <= 8, '来源数量有上限')
  const shared = first.sources.filter(s => s.url === 'https://example.com/shared')
  assert.equal(shared.length, 1, '重复 URL 应合并为一条')
  const page = first.sources.find(s => s.url === 'https://example.com/a')
  assert.ok(page?.excerpt, '读页正文应作为摘录附在同 URL 的来源上')

  const merged = mergeResearch(first, {
    queries: [{ query: 'e', provider: 'fake' }],
    pages: [],
    sources: [{ title: '新来源', url: 'https://example.com/new', snippet: '新' }]
  })
  assert.equal(merged.queries.length, 4)
  assert.ok(merged.sources.some(s => s.url === 'https://example.com/new'))
})

test('fetchPage：重定向逐跳校验，跳内网被拦截且不发起第二跳', async () => {
  const realFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, opts) => {
    calls.push(String(url))
    assert.equal(opts.redirect, 'manual', '必须手动跟随才能逐跳校验')
    return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:3789/api/novels' } })
  }
  try {
    const r = await fetchPage('https://example.com/redirect')
    assert.match(r.error || '', /重定向被拦截/)
    assert.deepEqual(calls, ['https://example.com/redirect'], '内网地址绝不能被请求')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('fetchPage：相对地址重定向正常跟随，返回最终 URL 与正文', async () => {
  const realFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, opts) => {
    calls.push(String(url))
    assert.equal(opts.redirect, 'manual')
    if (calls.length === 1) {
      return new Response(null, { status: 302, headers: { location: '/final' } })
    }
    return new Response('<html><head><title>最终页</title></head><body><p>这是最终正文。</p></body></html>', {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' }
    })
  }
  try {
    const r = await fetchPage('https://example.com/start')
    assert.equal(r.error, undefined)
    assert.equal(r.url, 'https://example.com/final', '相对跳转要按当前地址解析')
    assert.equal(r.title, '最终页')
    assert.match(r.text, /这是最终正文/)
    assert.deepEqual(calls, ['https://example.com/start', 'https://example.com/final'])
  } finally {
    globalThis.fetch = realFetch
  }
})

test('fetchPage：重定向循环有上限，不会无限跟随', async () => {
  const realFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    return new Response(null, { status: 302, headers: { location: `https://example.com/loop-${calls}` } })
  }
  try {
    const r = await fetchPage('https://example.com/loop-0')
    assert.match(r.error || '', /重定向次数过多/)
    assert.equal(calls, 6, '初始 1 次 + 最多跟随 5 次')
  } finally {
    globalThis.fetch = realFetch
  }
})
