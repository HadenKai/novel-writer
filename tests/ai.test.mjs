import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  extractJsonArray,
  extractJsonObject,
  cleanChapter,
  chapterMessages,
  chatMessages,
  extractChatActions,
  dehumanizeMessages,
  getSkill,
  referenceNovelMessages,
  extractReferenceAnalysis,
  normalizeOpenAIBase,
  countTextUnits,
  fitContextText,
  writingContract,
  continueMessages,
  polishMessages,
  reviseMessages,
  detectAIMessages,
  streamChat
} from '../server/ai.mjs'

// ---------- normalizeOpenAIBase（中转站裸域名自动补 /v1） ----------
test('normalizeOpenAIBase 裸域名自动补 /v1', () => {
  assert.equal(normalizeOpenAIBase('https://relay.example.com'), 'https://relay.example.com/v1')
  assert.equal(normalizeOpenAIBase('https://relay.example.com/'), 'https://relay.example.com/v1')
})

test('normalizeOpenAIBase 已带 /v1 保持不变', () => {
  assert.equal(normalizeOpenAIBase('https://relay.example.com/v1'), 'https://relay.example.com/v1')
  assert.equal(normalizeOpenAIBase('https://relay.example.com/v1/'), 'https://relay.example.com/v1')
})

test('normalizeOpenAIBase 保留自定义路径', () => {
  assert.equal(normalizeOpenAIBase('https://open.bigmodel.cn/api/paas/v4'), 'https://open.bigmodel.cn/api/paas/v4')
  assert.equal(
    normalizeOpenAIBase('https://dashscope.aliyuncs.com/compatible-mode/v1'),
    'https://dashscope.aliyuncs.com/compatible-mode/v1'
  )
})

test('normalizeOpenAIBase 误贴完整端点时回退到正确的 base', () => {
  assert.equal(normalizeOpenAIBase('https://relay.example.com/v1/chat/completions'), 'https://relay.example.com/v1')
  assert.equal(normalizeOpenAIBase('https://relay.xxx/chat/completions'), 'https://relay.xxx/v1')
})

// ---------- extractJsonArray ----------
test('extractJsonArray 解析普通数组', () => {
  const out = extractJsonArray('[{"index":1,"title":"第一章"}]')
  assert.deepEqual(out, [{ index: 1, title: '第一章' }])
})

test('extractJsonArray 容忍代码围栏与前后解释文字', () => {
  const text = '以下是大纲：\n```json\n[{"index":1,"title":"A"}]\n```\n请查收'
  assert.deepEqual(extractJsonArray(text), [{ index: 1, title: 'A' }])
})

test('extractJsonArray 容忍对象包裹', () => {
  const out = extractJsonArray('{"outline":[{"index":2,"title":"B"}]}')
  assert.deepEqual(out, [{ index: 2, title: 'B' }])
})

test('extractJsonArray 容忍尾逗号', () => {
  const out = extractJsonArray('[{"index":1,"title":"A"},]')
  assert.deepEqual(out, [{ index: 1, title: 'A' }])
})

test('extractJsonArray 修复字符串内未转义换行', () => {
  const raw = '[{"index":1,"title":"A","summary":"第一行\n第二行"}]'
  const out = extractJsonArray(raw)
  assert.deepEqual(out, [{ index: 1, title: 'A', summary: '第一行\n第二行' }])
})

test('extractJsonArray 输出被截断时保留完整对象', () => {
  const cut = '[{"index":1,"title":"A","summary":"完整"},{"index":2,"title":"B","summ'
  const out = extractJsonArray(cut)
  assert.ok(Array.isArray(out))
  assert.equal(out.length, 1)
  assert.equal(out[0].index, 1)
})

test('extractJsonArray 空输入返回 null', () => {
  assert.equal(extractJsonArray(''), null)
  assert.equal(extractJsonArray('   '), null)
  assert.equal(extractJsonArray('完全不是 JSON'), null)
})

// ---------- extractJsonObject ----------
test('extractJsonObject 解析普通对象', () => {
  const out = extractJsonObject('{"title":"书","genre":"玄幻"}')
  assert.deepEqual(out, { title: '书', genre: '玄幻' })
})

test('extractJsonObject 容忍围栏与尾逗号', () => {
  const out = extractJsonObject('```json\n{"a":1,"b":2,}\n```')
  assert.deepEqual(out, { a: 1, b: 2 })
})

test('extractJsonObject 修复未转义换行', () => {
  const out = extractJsonObject('{"worldview":"第一行\n第二行","a":1}')
  assert.deepEqual(out, { worldview: '第一行\n第二行', a: 1 })
})

test('extractJsonObject 无对象返回 null', () => {
  assert.equal(extractJsonObject('什么都没有'), null)
})

// ---------- cleanChapter ----------
test('cleanChapter 去掉章首标题', () => {
  assert.equal(cleanChapter('第一章 相遇\n\n正文开始'), '正文开始')
  assert.equal(cleanChapter('# 第1章 相遇\n\n正文'), '正文')
  assert.equal(cleanChapter('第一章\n\n正文'), '正文')
})

test('cleanChapter 无标题时原样保留', () => {
  assert.equal(cleanChapter('正文直接开始'), '正文直接开始')
})

// ---------- 写作技能注入 ----------
test('内置技能可通过 getSkill 解析', () => {
  const s = getSkill('hook')
  assert.ok(s)
  assert.equal(s.id, 'hook')
  assert.ok(s.content.length > 0)
})

test('不存在的技能返回 null', () => {
  assert.equal(getSkill('no_such_skill'), null)
})

test('chapterMessages 注入已选技能内容', () => {
  const base = {
    title: '测试',
    genre: '玄幻',
    pov: 'third',
    targetWords: 2000,
    chapterCount: 12,
    synopsis: 's',
    protagonist: {},
    characters: [],
    worldview: '',
    elements: '',
    extraRequirements: '',
    authorStyleId: '',
    style: '',
    templateId: 'balanced',
    customPrompt: '',
    modelId: '',
    masterOutline: '',
    outline: [],
    chapters: []
  }
  const noSkill = chapterMessages(base, 1)
  assert.ok(!noSkill[1].content.includes('【技能：'))

  const withSkill = chapterMessages({ ...base, skillIds: ['hook', 'cliffhanger'] }, 1)
  assert.ok(withSkill[1].content.includes('【技能：钩子开场】'))
  assert.ok(withSkill[1].content.includes('【技能：章末钩子】'))
})

// ---------- 剧情线注入 ----------
test('chapterMessages 注入剧情线状态与本章节点', () => {
  const base = {
    title: '测试',
    genre: '玄幻',
    pov: 'third',
    targetWords: 2000,
    chapterCount: 12,
    synopsis: 's',
    protagonist: {},
    characters: [],
    worldview: '',
    elements: '',
    extraRequirements: '',
    authorStyleId: '',
    style: '',
    templateId: 'balanced',
    customPrompt: '',
    modelId: '',
    masterOutline: '',
    outline: [],
    chapters: [],
    plotlines: [
      {
        id: 'p1',
        name: '登顶之路',
        type: '主线',
        goal: '查明真相',
        description: 'd',
        status: 'active',
        characters: ['张三'],
        beats: [
          { id: 'b1', title: '拜入宗门', summary: '初入宗门被刁难', chapter: 1 },
          { id: 'b2', title: '夺魁', summary: '大比夺魁扬名', chapter: 3 }
        ]
      },
      {
        id: 'p2',
        name: '旧案疑云',
        type: '悬念线',
        goal: 'g',
        description: 'd',
        status: 'done',
        characters: [],
        beats: []
      }
    ]
  }
  const out = chapterMessages(base, 1)
  // 进行中的线要出现，已收束的线不出现
  assert.ok(out[1].content.includes('《登顶之路》'))
  assert.ok(!out[1].content.includes('旧案疑云'))
  // 本章对应的节点要突出提示
  assert.ok(out[1].content.includes('拜入宗门'))
  // 第 2 章时应显示下一节点
  const out2 = chapterMessages(base, 2)
  assert.ok(out2[1].content.includes('夺魁'))
})

test('章节提示词保留人物事实与连续性账本', () => {
  const novel = {
    title: '连续性测试',
    genre: '悬疑',
    pov: 'third',
    targetWords: 2000,
    chapterCount: 10,
    synopsis: 's',
    protagonist: {
      name: '林舟',
      role: '法医',
      personality: '谨慎',
      appearance: '左眉有疤',
      background: '曾在北城工作',
      notes: '不喝酒'
    },
    characters: [{ name: '周岚', role: '记者', personality: '直接', notes: '称呼林舟为老师' }],
    worldview: '',
    elements: '',
    extraRequirements: '',
    authorStyleId: '',
    style: '',
    templateId: 'balanced',
    customPrompt: '',
    masterOutline: '主线是查明旧案。',
    outline: [
      { index: 1, title: '旧案', summary: '林舟发现线索。' },
      { index: 2, title: '追查', summary: '继续追查。' }
    ],
    chapters: [
      {
        index: 1,
        title: '旧案',
        content: '林舟翻开卷宗。',
        status: 'done',
        context: {
          summary: '发现北城旧案的关键照片。',
          openThreads: '照片背后的拍摄者身份',
          endingHook: '门外传来三下敲门声。'
        }
      }
    ]
  }
  const content = chapterMessages(novel, 2)[1].content
  assert.ok(content.includes('左眉有疤'))
  assert.ok(content.includes('不喝酒'))
  assert.ok(content.includes('照片背后的拍摄者身份'))
  assert.ok(content.includes('门外传来三下敲门声'))
})

test('无剧情线时不注入剧情线段落', () => {
  const base = {
    title: '测试',
    genre: '玄幻',
    pov: 'third',
    targetWords: 2000,
    chapterCount: 12,
    synopsis: 's',
    protagonist: {},
    characters: [],
    worldview: '',
    elements: '',
    extraRequirements: '',
    authorStyleId: '',
    style: '',
    templateId: 'balanced',
    customPrompt: '',
    modelId: '',
    masterOutline: '',
    outline: [],
    chapters: []
  }
  const out = chapterMessages(base, 1)
  assert.ok(!out[1].content.includes('【剧情线】'))
})

// ---------- 关联前文开关 ----------
const linkBase = {
  title: '测试',
  genre: '玄幻',
  pov: 'third',
  targetWords: 2000,
  chapterCount: 12,
  synopsis: 's',
  protagonist: {},
  characters: [],
  worldview: '',
  elements: '',
  extraRequirements: '',
  authorStyleId: '',
  style: '',
  templateId: 'balanced',
  customPrompt: '',
  modelId: '',
  masterOutline: '',
  outline: [],
  chapters: [],
  plotlines: []
}

test('chapterMessages 默认关联前文（注入近期原文）', () => {
  const novel = {
    ...linkBase,
    chapters: [
      { index: 1, title: '一', content: '第一章正文。他握紧了手中的剑，转身走入风雪。', words: 20, status: 'done' }
    ]
  }
  const out = chapterMessages(novel, 2)
  assert.ok(out[1].content.includes('前文衔接'))
  assert.ok(out[1].content.includes('走入风雪'))
  assert.ok(!out[1].content.includes('不要参照任何前文原文'))
})

test('chapterMessages linkContext=false 时不注入前文原文', () => {
  const novel = {
    ...linkBase,
    chapters: [
      { index: 1, title: '一', content: '第一章正文。他握紧了手中的剑，转身走入风雪。', words: 20, status: 'done' }
    ]
  }
  const out = chapterMessages(novel, 2, { linkContext: false })
  assert.ok(out[1].content.includes('作者已关闭「关联前文」'))
  assert.ok(!out[1].content.includes('走入风雪'))
})

// ---------- 统一字数统计与上下文预算 ----------
test('countTextUnits 去掉空白但保留中文、标点与 emoji', () => {
  assert.equal(countTextUnits(' 你好，世界! '), 6)
  assert.equal(countTextUnits('第一段\n\n第二段'), 6)
  assert.equal(countTextUnits(''), 0)
})

test('fitContextText 超预算时保留首尾并标记省略', () => {
  const text = '头'.repeat(100) + '尾'.repeat(100)
  const fitted = fitContextText(text, 60)
  assert.ok(fitted.includes('[中间内容因上下文预算省略]'))
  assert.ok(fitted.startsWith('头'))
  assert.ok(fitted.endsWith('尾'))
  assert.equal(fitContextText('短文本', 60), '短文本')
})

// ---------- 问题2/3：章节进度、人物状态与真实字数进入上下文 ----------
test('chapterMessages 注入任务合同、当前章号、逐章实际字数与人物状态', () => {
  const novel = {
    ...linkBase,
    targetWords: 4000,
    chapterCount: 3,
    protagonist: { name: '林晚', role: '法医', personality: '冷静', appearance: '', background: '旧案缠身', notes: '' },
    characters: [{ name: '沈修言', role: '刑警', personality: '外冷内热', appearance: '', background: '', notes: '' }],
    outline: [
      { index: 1, title: '起风', summary: '【开场】雨夜', customPrompt: '', oid: 'o1' },
      { index: 2, title: '落雨', summary: '【开场】码头', customPrompt: '', oid: 'o2' },
      { index: 3, title: '收网', summary: '【开场】审讯室', customPrompt: '', oid: 'o3' }
    ],
    chapters: [
      { index: 1, title: '起风', content: '风'.repeat(4000), words: 999, status: 'done' },
      { index: 3, title: '收网', content: '后文草稿', words: 4, status: 'draft' }
    ]
  }
  const text = chapterMessages(novel, 2)[1].content
  assert.ok(text.includes('【本次任务合同】'), '应注入统一创作合同')
  assert.ok(text.includes('当前章：第 2 章'))
  assert.ok(text.includes('前置已定稿 1 章'), '第 3 章草稿不应计入前置进度')
  assert.ok(text.includes('第1章《起风》：4000 字'), '应传入逐章实际字数（不信任过期 words 元数据）')
  assert.ok(text.includes('【人物当前状态】'))
  assert.ok(text.includes('林晚'))
  assert.ok(text.includes('【已完成章节实际字数】'))
})

test('progressContext 只统计当前章之前且非草稿的章节', () => {
  const novel = {
    ...linkBase,
    chapterCount: 10,
    outline: Array.from({ length: 10 }, (_, i) => ({
      index: i + 1,
      title: `第${i + 1}章`,
      summary: 's',
      customPrompt: '',
      oid: `o${i}`
    })),
    chapters: [
      { index: 1, content: '正文一', status: 'done' },
      { index: 2, content: '草稿二', status: 'draft' },
      { index: 8, content: '后文八', status: 'done' }
    ]
  }
  const text = chapterMessages(novel, 3)[1].content
  assert.ok(text.includes('当前第 3 章 / 全书规划 10 章'))
  assert.ok(text.includes('前置已定稿 1 章'))
})

test('writingContract 明确作者指令优先级与输出边界', () => {
  const novel = {
    ...linkBase,
    title: '合同书',
    customPrompt: '全书要求：不写现代词',
    outline: [{ index: 4, title: '第四章', summary: 's', customPrompt: '本章必须写雨夜追逐', oid: 'o4' }]
  }
  const text = writingContract(novel, 4, 'write')
  assert.ok(text.includes('当前章：第 4 章'))
  assert.ok(text.includes('本章必须写雨夜追逐'))
  assert.ok(text.includes('不写现代词'))
  assert.ok(text.includes('只输出本任务要求的正文成品'))
})

test('continueMessages 注入合同并保留正文尾部', () => {
  const novel = {
    ...linkBase,
    chapters: [{ index: 1, title: '一', content: '开头'.repeat(8000) + '断点在此', words: 0, status: 'done' }],
    outline: [{ index: 1, title: '一', summary: 's', customPrompt: '', oid: 'o1' }]
  }
  const text = continueMessages(novel, 1, '收束到腰牌反转')[1].content
  assert.ok(text.includes('【本次任务合同】'))
  assert.ok(text.includes('断点在此'), '超长正文应保留尾部断点')
  assert.ok(text.includes('[中间内容因上下文预算省略]'))
  assert.ok(text.includes('本章当前已有 16004 字'))
})

// ---------- SSE 解析：错误透传、EOF 无换行、finish_reason 截断 ----------
async function collectStream(opts) {
  const parts = []
  let error = null
  try {
    for await (const p of streamChat(opts)) parts.push(p)
  } catch (e) {
    error = e
  }
  return { parts, error }
}

function sseBody(chunks) {
  return new ReadableStream({
    start(c) {
      for (const s of chunks) c.enqueue(new TextEncoder().encode(s))
      c.close()
    }
  })
}

test('streamChat 发送 OpenAI reasoning_effort 思考强度', async () => {
  const originalFetch = globalThis.fetch
  let payload = null
  globalThis.fetch = async (_url, init) => {
    payload = JSON.parse(init.body)
    return new Response('data: {"choices":[{"delta":{"content":"好"}}]}\n\ndata: [DONE]\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' }
    })
  }
  try {
    let output = ''
    for await (const part of streamChat({
      baseUrl: 'https://example.com/v1',
      apiKey: 'test',
      model: 'test-model',
      reasoningEffort: 'high',
      messages: [{ role: 'user', content: 'test' }]
    })) {
      if (part.type === 'content') output += part.text
    }
    assert.equal(output, '好')
    assert.equal(payload.reasoning_effort, 'high')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('streamChat Default 思考强度不发送 reasoning_effort', async () => {
  const originalFetch = globalThis.fetch
  let payload = null
  globalThis.fetch = async (_url, init) => {
    payload = JSON.parse(init.body)
    return new Response('data: {"choices":[{"delta":{"content":"好"}}]}\n\ndata: [DONE]\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' }
    })
  }
  try {
    for await (const _part of streamChat({
      baseUrl: 'https://example.com/v1',
      apiKey: 'test',
      model: 'test-model',
      reasoningEffort: 'default',
      messages: [{ role: 'user', content: 'test' }]
    })) {
      if (_part.type === 'content') continue
    }
    assert.equal(Object.hasOwn(payload, 'reasoning_effort'), false)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('streamChat 透传 SSE 内嵌的上游错误，而不是吞成“未返回有效内容”', async () => {
  const orig = global.fetch
  global.fetch = async () => ({
    ok: true,
    body: sseBody(['data: {"error":{"message":"model unavailable"}}\n\n', 'data: [DONE]\n\n'])
  })
  try {
    const { error } = await collectStream({ baseUrl: 'https://relay.test', apiKey: 'k', model: 'm', messages: [] })
    assert.ok(error, '应抛出错误')
    assert.match(error.message, /model unavailable/)
  } finally {
    global.fetch = orig
  }
})

// 背景：部分网关（把 Gemini 3.x 之类模型转成 OpenAI 兼容协议的中转站）会以 400
// 明确拒绝 temperature；原实现把 4xx 一律直接抛出，表现就是「一对话就报 AI 接口错误」。
// 这里锁定：应摘掉该参数重试，而不是把错误甩给用户。
test('streamChat 遇到「temperature 不被支持」的 400 会摘掉该参数重试', async () => {
  const orig = global.fetch
  const bodies = []
  global.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body))
    if (bodies.length === 1) {
      return {
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ error: { message: 'temperature is not supported for this model' } })
      }
    }
    return {
      ok: true,
      status: 200,
      body: sseBody(['data: {"choices":[{"delta":{"content":"好"}}]}\n\n', 'data: [DONE]\n\n'])
    }
  }
  try {
    const { parts, error } = await collectStream({
      baseUrl: 'https://relay.test',
      apiKey: 'k',
      model: 'gemini-3.8-flash',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.8,
      maxTokens: 16384
    })
    assert.equal(error, null, `不应直接失败：${error?.message}`)
    assert.ok(bodies.length >= 2, '应发生重试')
    assert.ok('temperature' in bodies[0], '首轮应带 temperature')
    assert.ok(!('temperature' in bodies[1]), '重试时应摘掉 temperature')
    assert.ok(
      parts.some(p => p.type === 'content' && p.text === '好'),
      '重试应拿到正文'
    )
  } finally {
    global.fetch = orig
  }
})

test('streamChat 遇到 max_tokens 过大被拒时会调小该上限重试', async () => {
  const orig = global.fetch
  const bodies = []
  global.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body))
    if (bodies.length === 1) {
      return {
        ok: false,
        status: 400,
        text: async () =>
          JSON.stringify({ error: { message: 'max_tokens is too large, must be less than or equal to 8192' } })
      }
    }
    return {
      ok: true,
      status: 200,
      body: sseBody(['data: {"choices":[{"delta":{"content":"好"}}]}\n\n', 'data: [DONE]\n\n'])
    }
  }
  try {
    const { error } = await collectStream({
      baseUrl: 'https://relay.test',
      apiKey: 'k',
      model: 'some-model',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 16384
    })
    assert.equal(error, null, `不应直接失败：${error?.message}`)
    assert.ok(bodies.length >= 2, '应发生重试')
    assert.equal(bodies[0].max_tokens, 16384)
    assert.ok(bodies[1].max_tokens < bodies[0].max_tokens, '重试应调小 max_tokens')
  } finally {
    global.fetch = orig
  }
})

test('streamChat 鉴权类 4xx（401）不做参数降级，直接上报', async () => {
  const orig = global.fetch
  let calls = 0
  global.fetch = async () => {
    calls++
    return {
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ error: { message: 'Invalid API key' } })
    }
  }
  try {
    const { error } = await collectStream({
      baseUrl: 'https://relay.test',
      apiKey: 'bad',
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 16384
    })
    assert.ok(error, '应抛出错误')
    assert.equal(error.status, 401)
    assert.equal(calls, 1, '鉴权失败不应重试')
  } finally {
    global.fetch = orig
  }
})

test('streamChat 401「Invalid token」不误命中参数降级，直接上报', async () => {
  const orig = global.fetch
  let calls = 0
  global.fetch = async () => {
    calls++
    return {
      ok: false,
      status: 401,
      // 中转站常见文案：同时含 token 与 invalid，旧逻辑会误判成「输出上限不合规」减半空转
      text: async () => JSON.stringify({ error: { message: 'Invalid token' } })
    }
  }
  try {
    const { error } = await collectStream({
      baseUrl: 'https://relay.test',
      apiKey: 'bad',
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 16384
    })
    assert.ok(error, '应抛出错误')
    assert.equal(error.status, 401)
    assert.equal(calls, 1, 'Invalid token 属鉴权失败，不应参数降级重试')
  } finally {
    global.fetch = orig
  }
})

test('streamChat 处理 EOF 前没有换行的最后一条 data', async () => {
  const orig = global.fetch
  global.fetch = async () => ({
    ok: true,
    body: sseBody(['data: {"choices":[{"delta":{"content":"你好"}}]}'])
  })
  try {
    const { parts, error } = await collectStream({
      baseUrl: 'https://relay.test',
      apiKey: 'k',
      model: 'm',
      messages: []
    })
    assert.equal(error, null)
    assert.equal(
      parts
        .filter(p => p.type === 'content')
        .map(p => p.text)
        .join(''),
      '你好'
    )
  } finally {
    global.fetch = orig
  }
})

test('streamChat 把 finish_reason=length 作为截断元数据传出', async () => {
  const orig = global.fetch
  global.fetch = async () => ({
    ok: true,
    body: sseBody(['data: {"choices":[{"delta":{"content":"前半章"},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n'])
  })
  try {
    const { parts } = await collectStream({ baseUrl: 'https://relay.test', apiKey: 'k', model: 'm', messages: [] })
    const meta = parts.find(p => p.type === 'meta')
    assert.ok(meta, '应产出 meta 元数据')
    assert.equal(meta.truncated, true)
    assert.equal(meta.finishReason, 'length')
  } finally {
    global.fetch = orig
  }
})

// ---------- 创作研讨（chatMessages） ----------
test('chatMessages 注入本书档案并携带对话历史', () => {
  const novel = {
    ...linkBase,
    synopsis: '少年逆流而上',
    masterOutline: '一、故事核心',
    outline: [{ index: 1, title: '风雪夜', summary: '【开场】风雪夜入城', customPrompt: '', oid: 'o1' }],
    chapters: [{ index: 1, title: '风雪夜', content: '他握紧了手中的剑。', words: 9, status: 'done' }]
  }
  const history = [
    { role: 'user', content: '接下来剧情怎么走？' },
    { role: 'assistant', content: '给你两个方案：一、……；二、……' },
    { role: 'user', content: '第二个方案爽点再密一些' }
  ]
  const msgs = chatMessages(novel, history)
  // system 含规则 + 档案
  assert.ok(msgs[0].role === 'system')
  assert.ok(msgs[0].content.includes('创作管家'))
  assert.ok(msgs[0].content.includes('少年逆流而上'))
  // 历史：system 之后直接是对话轮次，不含额外的档案注入
  assert.equal(msgs.length, 4)
  assert.equal(msgs[1].role, 'user')
  assert.equal(msgs[1].content, '接下来剧情怎么走？')
  assert.equal(msgs[3].content, '第二个方案爽点再密一些')
  // 空历史时只有 system 一条
  assert.equal(chatMessages(novel, []).length, 1)
})

test('chatMessages applyActions 时注入动作规范', () => {
  const novel = { ...linkBase, outline: [] }
  const off = chatMessages(novel, [{ role: 'user', content: 'hi' }])
  assert.ok(!off[0].content.includes('chapterPrompt'))
  const on = chatMessages(novel, [{ role: 'user', content: 'hi' }], { applyActions: true })
  assert.ok(on[0].content.includes('chapterPrompt'))
  assert.ok(on[0].content.includes('outlineSummary'))
})

// ---------- extractChatActions（管家代改动作解析） ----------
test('extractChatActions 从围栏中解析动作并剥离', () => {
  const reply =
    '好的，已按方案二改好第 3 章大纲。\n\n```json\n{"actions":[{"type":"outlineSummary","chapter":3,"text":"【开场】雨夜"}]}\n```\n'
  const r = extractChatActions(reply)
  assert.equal(r.actions.length, 1)
  assert.equal(r.actions[0].type, 'outlineSummary')
  assert.equal(r.actions[0].chapter, 3)
  assert.equal(r.actions[0].text, '【开场】雨夜')
  assert.equal(r.reply, '好的，已按方案二改好第 3 章大纲。')
})

test('extractChatActions 无动作时原样返回', () => {
  const r = extractChatActions('这只是讨论，不改东西。```json\n{"a":1}\n```')
  assert.equal(r.actions.length, 0)
  assert.ok(r.reply.includes('这只是讨论'))
})

test('extractChatActions 支持多动作与裸 JSON 兜底', () => {
  const multi =
    '前言\n```json\n{"actions":[{"type":"chapterPrompt","chapter":2,"text":"多写雨"},{"type":"element","text":"猜马局"}]}\n```'
  const r1 = extractChatActions(multi)
  assert.equal(r1.actions.length, 2)
  const bare = '结论如下\n{"actions":[{"type":"outlineTitle","chapter":1,"text":"新标题"}]}'
  const r2 = extractChatActions(bare)
  assert.equal(r2.actions.length, 1)
  assert.equal(r2.actions[0].type, 'outlineTitle')
})

// ---------- 批量动作被截断时的恢复（管家一次加几十个角色易触发） ----------
test('extractChatActions 应对被 max_tokens 截断的输出：保留完整动作，丢弃残缺尾巴', () => {
  const chars = [
    { type: 'addCharacter', chapter: 0, text: '{"name":"王五","role":"配角"}' },
    { type: 'addCharacter', chapter: 0, text: '{"name":"赵六","role":"配角"}' },
    { type: 'addCharacter', chapter: 0, text: '{"name":"孙七","role":"配角"}' },
    { type: 'addCharacter', chapter: 0, text: '{"name":"周八","role":"敌人","background":"暗中筹谋"}' }
  ]
  const full = JSON.stringify({ actions: chars })
  // 模拟输出在末尾被掐断：最后一个动作对象不完整、围栏也未闭合
  const clipped = full.slice(0, full.length - 8)

  // 围栏未闭合的截断
  const r1 = extractChatActions('我这就补进设定：\n```json\n' + clipped + '\n')
  assert.equal(r1.actions.length, 3, '截断时应救回 3 个完整动作')
  assert.deepEqual(
    r1.actions.map(a => JSON.parse(a.text).name),
    ['王五', '赵六', '孙七']
  )
  assert.equal(r1.reply, '我这就补进设定：', '残缺的围栏尾巴应从回复中剥掉')

  // 裸 JSON 截断
  const r2 = extractChatActions('好的\n' + clipped)
  assert.equal(r2.actions.length, 3)
  assert.equal(r2.actions[r2.actions.length - 1].type, 'addCharacter')

  // 完整输出回归：仍应全部取出，颜色不变
  const r3 = extractChatActions('已加上。\n```json\n' + full + '\n```')
  assert.equal(r3.actions.length, 4)
})

// ---------- 容错：text 形态不标准（对象 / 数字 / 顶层扁平字段） ----------
test('extractChatActions 兼容 text 为 JSON 对象 / 数字 / 顶层扁平字段', () => {
  // text 为对象：模型按动作规范「text 为 JSON 对象」字面输出，此前会被整条丢弃
  const obj =
    '好的。\n```json\n' +
    JSON.stringify({
      actions: [
        { type: 'addCharacter', text: { name: '王五', role: '配角', personality: '沉稳' } },
        { type: 'addCharacter', text: { name: '赵六', role: '暗线', background: '孤儿' } },
        { type: 'masterOutline', text: '第一幕：引子\n第二幕：冲突' }
      ]
    }) +
    '\n```'
  const r1 = extractChatActions(obj)
  assert.equal(r1.actions.length, 3)
  assert.equal(r1.actions[0].type, 'addCharacter')
  assert.equal(JSON.parse(r1.actions[0].text).name, '王五')

  // 人物字段平铺在动作顶层（无 text）
  const flat = '```json\n{"actions":[{"type":"addCharacter","name":"孙七","role":"配角","personality":"大胆"}]}\n```'
  const r2 = extractChatActions(flat)
  assert.equal(r2.actions.length, 1)
  const c2 = JSON.parse(r2.actions[0].text)
  assert.equal(c2.name, '孙七')
  assert.equal(c2.role, '配角')

  // text 为数字 / 顶层 value：数值动作
  const num = '{"actions":[{"type":"chapterCount","text":30},{"type":"targetWords","value":2500}]}'
  const r3 = extractChatActions(num)
  assert.equal(r3.actions.length, 2)
  assert.equal(r3.actions[0].text, '30')
  assert.equal(r3.actions[1].text, '2500')

  // 大纲动作：chapter 用 chapterIndex、新标题放顶层 title 也能取到
  const out =
    '{"actions":[{"type":"outlineTitle","chapterIndex":2,"title":"雨夜追凶"},{"type":"outlineSummary","chapter":2,"text":"连夜查案"}]}'
  const r4 = extractChatActions(out)
  assert.equal(r4.actions.length, 2)
  assert.equal(r4.actions[0].type, 'outlineTitle')
  assert.equal(r4.actions[0].chapter, 2)
  assert.equal(r4.actions[0].text, '雨夜追凶')

  // 顶层 name + text 对象合并（updateCharacter 常见：name 在顶层、详情在 text）
  const mixed = '{"actions":[{"type":"updateCharacter","name":"林晚","text":{"personality":"冷静理性，爱猫"}}]}'
  const r5 = extractChatActions(mixed)
  assert.equal(r5.actions.length, 1)
  assert.deepEqual(JSON.parse(r5.actions[0].text), { personality: '冷静理性，爱猫', name: '林晚' })
})

// ---------- 统一《叙述纪律》：解释动作 / 修饰叠用 ----------
// 作者反馈：生成时仍会连用修饰、并且会替读者解释动作。这两条现在写在唯一一份纪律里，
// 逐章、续写、润色、修改、降 AI、管家六条链路共用，缺一条就说明又各写各的了。
test('六条写作链路共用同一份叙述纪律，并覆盖解释动作与修饰叠用', () => {
  const novel = {
    ...linkBase,
    chapters: [{ index: 1, title: '一', content: '开头。', words: 3, status: 'done' }],
    outline: [{ index: 1, title: '夜行', summary: '【开场】夜路', customPrompt: '', oid: 'o1' }]
  }
  const prompts = {
    逐章: chapterMessages(novel, 1),
    续写: continueMessages(novel, 1),
    润色: polishMessages(novel, 1),
    修改: reviseMessages(novel, 1, '节奏太慢'),
    降AI: dehumanizeMessages(novel, 1),
    管家: chatMessages(novel, [])
  }
  for (const [name, msgs] of Object.entries(prompts)) {
    const all = msgs.map(m => m.content).join('\n')
    assert.ok(all.includes('【叙述纪律】'), `${name}：应引用统一叙述纪律`)
    assert.ok(all.includes('动作只呈现，不解释'), `${name}：应写明「动作不解释」`)
    assert.ok(all.includes('修饰不叠用'), `${name}：应写明「修饰不叠用」`)
    // 反例/正例是这条纪律最容易被执行的形式，必须带上
    assert.ok(all.includes('说明他此刻非常愤怒'), `${name}：应带反例`)
    assert.ok(all.includes('他握紧拳头，指节抵着桌沿'), `${name}：应带正例`)
  }
  // AI 痕迹检测也要能查出这两类毛病，否则生成端改了、检测端仍说「没味道」
  const detect = detectAIMessages(novel, 1)
    .map(m => m.content)
    .join('\n')
  assert.ok(detect.includes('解释动作'), '检测维度应包含解释动作')
  assert.ok(detect.includes('修饰叠用'), '检测维度应包含修饰叠用')
})

// ---------- 降 AI 提示词（dehumanizeMessages） ----------
test('dehumanizeMessages 注入降AI改写规则并携带原文', () => {
  const novel = {
    ...linkBase,
    chapters: [{ index: 1, title: '一', content: '他不禁心中一凛，仿佛看到了神秘的身影。', words: 20, status: 'done' }],
    outline: [{ index: 1, title: '夜行', summary: '【开场】夜路', customPrompt: '', oid: 'o1' }]
  }
  const msgs = dehumanizeMessages(novel, 1)
  assert.equal(msgs.length, 2)
  assert.ok(msgs[1].content.includes('降 AI 痕迹'))
  assert.ok(msgs[1].content.includes('他不禁心中一凛'))
  // 打破机器节奏的规则仍在（措辞随统一纪律调整过，断言语义而非原句）
  assert.ok(msgs[1].content.includes('段落长短自然变化'))
  // 与逐章/续写/润色/修改共用同一份叙述纪律：解释动作与修饰叠用必须点到
  assert.ok(msgs[1].content.includes('【叙述纪律】'))
  assert.ok(msgs[1].content.includes('修饰不叠用'))
  assert.ok(msgs[1].content.includes('动作只呈现'))
  // 附加要求透传
  const withExtra = dehumanizeMessages(novel, 1, '对话再口语化')
  assert.ok(withExtra[1].content.includes('对话再口语化'))
})

// ---------- 手机阅读优化（mobileReading） ----------
test('chapterMessages mobileReading 开启时注入手机适配规则', () => {
  const novel = { ...linkBase, mobileReading: true }
  const out = chapterMessages(novel, 1)
  assert.ok(out[1].content.includes('【手机阅读适配】'))
  assert.ok(out[1].content.includes('六感'))
  const off = chapterMessages({ ...linkBase, mobileReading: false }, 1)
  assert.ok(!off[1].content.includes('【手机阅读适配】'))
})

// ---------- 内置技能：番茄过稿 / 手机阅读 ----------
test('新技能可通过 getSkill 解析', () => {
  const t = getSkill('tomato-pass')
  assert.ok(t)
  assert.ok(t.content.includes('签约难度'))
  assert.ok(t.content.includes('老套路'))
  const m = getSkill('mobile-reading')
  assert.ok(m)
  assert.ok(m.content.includes('六感'))
  assert.ok(m.content.includes('多换行'))
})

// ---------- 参考小说分析 ----------
test('referenceNovelMessages 注入参考小说内容与角色提取要求', () => {
  const novel = { title: '我的同人文', genre: '同人', synopsis: '' }
  const messages = referenceNovelMessages(novel, '【原著.txt】（约 5000 字）\n主角叫张三……', ['原著.txt'])
  const user = messages.find(m => m.role === 'user').content
  assert.ok(user.includes('原著.txt'))
  // 原文必须真的进提示词：只给文件名会让模型凭空编造分析结果
  assert.ok(user.includes('主角叫张三'), '参考小说正文必须注入 user 消息')
  assert.ok(user.includes('【参考小说正文】'))
  assert.ok(user.includes('characters'))
  assert.ok(user.includes('worldBuilding'))
  assert.ok(user.includes('直接输出 JSON 对象'))
})

test('extractReferenceAnalysis 解析完整分析对象', () => {
  const raw = JSON.stringify({
    characters: [
      { name: '张三', role: '主角', personality: '冷静', appearance: '高个', background: '孤儿', notes: '会武功' }
    ],
    plotEvents: '事件一：拜入宗门',
    plotSummary: '主角从卑微到巅峰',
    worldBuilding: '修炼等级分为九境',
    writingStyle: '短句，节奏快',
    keyRelationships: '张三与李四亦敌亦友',
    themes: '成长与救赎'
  })
  const a = extractReferenceAnalysis(raw)
  assert.ok(a)
  assert.equal(a.characters[0].name, '张三')
  assert.equal(a.plotEvents, '事件一：拜入宗门')
  assert.equal(a.worldBuilding, '修炼等级分为九境')
  assert.equal(a.writingStyle, '短句，节奏快')
})

test('extractReferenceAnalysis 容忍围栏与容错', () => {
  const raw = '以下是分析：\n```json\n{"characters":[{"name":"李四","role":"反派"}],"plotEvents":"抓走主角"}]\n```'
  const a = extractReferenceAnalysis(raw)
  assert.ok(a)
  assert.equal(a.characters.length, 1)
  assert.equal(a.characters[0].name, '李四')
})

test('extractReferenceAnalysis 空输入返回 null', () => {
  assert.equal(extractReferenceAnalysis(''), null)
  assert.equal(extractReferenceAnalysis('不是JSON'), null)
})

test('extractReferenceAnalysis 过滤无姓名角色', () => {
  const raw = JSON.stringify({ characters: [{ role: '路人' }, { name: '王五' }] })
  const a = extractReferenceAnalysis(raw)
  assert.equal(a.characters.length, 1)
  assert.equal(a.characters[0].name, '王五')
})
