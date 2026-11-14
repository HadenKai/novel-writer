// AI 流式调用层：OpenAI 兼容接口（智谱 / DeepSeek / Kimi / 通义 / OpenAI 及各类中转站）
// 与 Gemini 原生接口（generateContent 最新格式，供 Gemini 3.x 使用）。
//
// 从 ai.mjs 拆出的原因：原先 ai.mjs 一个文件 1783 行，既放「HTTP 流式解析 + 超时重试」，
// 又放「提示词拼装」，两类改动的读者和变更节奏完全不同。拆开后本文件只负责
// 「怎么把请求发出去、怎么把 SSE 解析成增量」，与具体的提示词内容无关。
//
// 超时策略（两段式，两个 provider 共用同一套语义）：
//  - 连接建立（含收到响应头）30s：防止中转站接受连接后不响应
//  - 首字节宽限 300s：思考型模型（o1/R1 系）可能在吐第一个 token 前推理数分钟，
//    此阶段不能用「块间隔」阈值，否则会把「模型在想」误判成「链路卡死」而掐断
//  - 首字节到达后块间隔 120s：此后卡住基本都是链路问题，可安全自愈
//  - 仅当「尚未产出任何内容」时才重试，已开始输出后失败直接上报，避免正文重复

const CONNECT_TIMEOUT_MS = 30000 // 连接建立超时（含收到响应头）
const CHUNK_TIMEOUT_MS = 120000 // 相邻数据块最大间隔（模型思考慢时不中断）
const RETRIES = 2 // 整体失败重试次数
// 等「首个字节」的额外宽限：连接已在 30s 内建立（说明网关认了这个请求），
// 但思考型模型可能在吐第一个 token 前先想很久。此阶段单独给更长的静默容忍，
// 避免把「模型在想」误判成「链路卡死」。
const FIRST_CHUNK_GRACE_MS = 300000

// Gemini 原生接口（最新 generateContent 格式，供 Gemini 3.x 使用）
// 说明：Gemini 3.x 已弃用 temperature/top_p/top_k，改用 generationConfig.thinkingConfig.thinkingLevel。
// 鉴权用 x-goog-api-key 头，endpoint 为 models/{model}:streamGenerateContent?alt=sse。
const GEMINI_CONNECT_TIMEOUT_MS = 30000
const GEMINI_CHUNK_TIMEOUT_MS = 120000
const GEMINI_FIRST_CHUNK_GRACE_MS = 300000 // 见 FIRST_CHUNK_GRACE_MS 的说明
const GEMINI_RETRIES = 2

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

// ---------- 本地推理串行闸门 ----------
// 本机推理服务（Ollama / llama.cpp / LM Studio）通常只有一个 GPU 后端，并发请求不会更快，
// 反而会让每个请求的「首字节」都往后拖、彼此触发看门狗超时。这里按 baseUrl 排队，
// 同一个本地端点同一时刻只跑一个请求；云端不受影响。
const localGates = new Map()
function localGate(key) {
  let entry = localGates.get(key)
  if (!entry) {
    entry = { tail: Promise.resolve() }
    localGates.set(key, entry)
  }
  return async () => {
    let release
    const mine = new Promise(res => {
      release = res
    })
    const wait = entry.tail
    entry.tail = entry.tail.then(() => mine)
    await wait
    return release
  }
}

/**
 * 归一化 OpenAI 兼容网关的 baseUrl：
 * - 去掉末尾斜杠
 * - 若用户直接粘了 /chat/completions 或 /models，剥掉这段路径
 * - 只剩域名时补 /v1（大多数中转站的约定）
 * - 无协议的 host:port（Ollama 风格 localhost:11434/v1）补 http://——
 *   否则 new URL 会把 "localhost:" 当协议解析，origin 变成字符串 "null"
 */
export function normalizeOpenAIBase(raw) {
  const s = String(raw || '').trim()
  if (!s) return ''
  let u
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `http://${s}`)
  } catch {
    return s.replace(/\/+$/, '')
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return s.replace(/\/+$/, '')
  let p = u.pathname.replace(/\/+$/, '')
  p = p.replace(/(\/chat\/completions|\/models)$/i, '')
  if (!p) return `${u.origin}/v1`
  return `${u.origin}${p}`
}

function geminiContents(messages) {
  const system = []
  const contents = []
  for (const m of messages || []) {
    const role = m.role === 'assistant' ? 'model' : m.role === 'system' ? 'system' : 'user'
    // 多模态消息（带图）的 content 是数组：转成 Gemini 的 parts，
    // 只取字符串会把整条消息静默丢掉——模型没看到图却照常作答
    const parts = []
    if (typeof m?.content === 'string') {
      if (m.content) parts.push({ text: m.content })
    } else if (Array.isArray(m?.content)) {
      for (const p of m.content) {
        if (p?.type === 'text' && p.text) parts.push({ text: String(p.text) })
        else if (p?.type === 'image_url') {
          const mm = /^data:([^;]+);base64,(.+)$/.exec(String(p.image_url?.url || ''))
          if (mm) parts.push({ inline_data: { mime_type: mm[1], data: mm[2] } })
        }
      }
    }
    if (!parts.length) continue
    if (role === 'system') {
      for (const p of parts) if (p.text) system.push(p.text)
      continue
    }
    contents.push({ role: role.toUpperCase(), parts })
  }
  return { systemInstruction: system.length ? { parts: system.map(t => ({ text: t })) } : null, contents }
}

// ---------- OpenAI 兼容接口 ----------

/**
 * 本地推理串行化包装：同一个本地端点同一时刻只跑一个请求。
 * 拆成外层包装而不是改内层，是为了让重试/看门狗逻辑保持原样。
 */
async function* streamOpenAI(opts) {
  const release = opts?.local ? await localGate(normalizeOpenAIBase(opts.baseUrl))() : null
  try {
    yield* streamOpenAIRaw(opts)
  } finally {
    if (release) release()
  }
}

async function* streamOpenAIRaw({ baseUrl, apiKey, model, temperature, messages, signal, maxTokens, reasoningEffort }) {
  const url = normalizeOpenAIBase(baseUrl) + '/chat/completions'
  let lastErr = null

  // 思考型模型经常把输出配额全部消耗在 reasoning 上、正文一个字符都没出（流正常结束）。
  // 遇到这种情况自动逐级放大输出上限重试；首轮保持用户/默认配额，避免顶到 DeepSeek 官方 8192 硬上限被 400。
  let baseTokens = maxTokens && maxTokens > 0 ? Math.min(maxTokens, 262144) : 8192
  const MAX_OUTPUT_TOKENS = 32768

  // 被上游判定为「不支持」而摘掉的参数（跨重试保留）
  const dropParams = new Set()

  /**
   * 参数降级重试。
   *
   * 背景：4xx 原先一律直接抛出，但网关（尤其把 Gemini 3.x 这类模型转成 OpenAI 兼容协议的中转站）
   * 返回的 400 常常是「这个参数我不认」——例如 Gemini 3.x 已弃用 temperature，
   * 或 max_tokens 超过该模型允许的上限。这类问题摘掉参数/调小上限再试一次通常就能成功；
   * 直接甩给用户，表现就是「一对话就报 AI 接口错误」。
   *
   * 返回 true 表示参数已调整，可以再试。
   */
  const adaptOn4xx = hint => {
    const h = String(hint || '').toLowerCase()
    const unsupported = /not support|unsupported|unknown|invalid|unrecognized|deprecat|不支持|无法识别/.test(h)
    // 1) 采样参数不被支持（Gemini 3.x 等）→ 摘掉 temperature
    if (unsupported && /reasoning_effort|reasoning effort|思考强度/.test(h) && !dropParams.has('reasoning_effort')) {
      dropParams.add('reasoning_effort')
      return true
    }
    if (
      unsupported &&
      /temperature|top_p|top_k|presence_penalty|frequency_penalty/.test(h) &&
      !dropParams.has('temperature')
    ) {
      dropParams.add('temperature')
      return true
    }
    // 2) 输出上限不合规 → 先减半，减到下限后直接摘掉该参数
    if (/max_tokens|max output|output token|max_completion_tokens|token/.test(h)) {
      if (/too large|exceed|greater|maximum|limit|must be|invalid|range|less than|out of range|上限/.test(h)) {
        if (baseTokens > 2048) {
          baseTokens = Math.max(2048, Math.floor(baseTokens / 2))
          return true
        }
        if (!dropParams.has('max_tokens')) {
          dropParams.add('max_tokens')
          return true
        }
      }
    }
    return false
  }

  // attempt 只统计「真实重试」（用于放大输出上限）；参数降级走独立预算，不消耗它。
  let attempt = 0
  let adaptBudget = 3
  let guard = 0 // 总迭代保险丝，避免任何情况下死循环
  while (guard++ < RETRIES + 8) {
    const effMax = Math.min(baseTokens * Math.pow(2, attempt), MAX_OUTPUT_TOKENS)
    const ctrl = new AbortController()
    let aborted = false
    let emitted = false // 本轮是否已经 yield 过内容（思考也算）
    let gotContent = false // 本轮是否产出过正文
    let gotReasoning = false // 本轮是否产出过思考过程
    let finishReason = null // 流结束前的 finish_reason（length=配额耗尽）
    const onAbort = () => {
      aborted = true
      ctrl.abort()
    }
    if (signal) {
      // 信号可能在本轮调用前就已中止（如刚停笔又立即发起新一章）
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    // 连接阶段超时：首个响应头必须在 30s 内到达
    const connectTimer = setTimeout(() => {
      if (!aborted) ctrl.abort()
    }, CONNECT_TIMEOUT_MS)
    connectTimer.unref?.()

    let watchdog = null
    // 看门狗触发标记：watchdog 是先 abort 再由挂起的 reader.read() 抛 AbortError，
    // 异常会直接落到外层 catch——「人话报错」必须在 catch 里依据本标记给出才有机会执行
    let stalled = false
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // 本地部署通常不鉴权：没有密钥就不要发 Authorization，
          // 某些服务（Ollama / LM Studio）见到空的 Bearer 会直接 401。
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
        },
        body: JSON.stringify({
          model,
          stream: true,
          messages,
          // 被上游拒绝过的参数不再发送；未拒绝时保持原有行为
          ...(temperature === undefined || dropParams.has('temperature') ? {} : { temperature }),
          ...(reasoningEffort && reasoningEffort !== 'default' && !dropParams.has('reasoning_effort')
            ? { reasoning_effort: reasoningEffort }
            : {}),
          ...(dropParams.has('max_tokens') ? {} : { max_tokens: effMax })
        }),
        signal: ctrl.signal
      })
      clearTimeout(connectTimer)

      if (!res.ok) {
        const text = await res.text().catch(() => '')
        let hint = text.slice(0, 300)
        try {
          const j = JSON.parse(text)
          hint = j.error?.message || j.message || hint
        } catch {}
        const code =
          res.status === 403
            ? 'MODEL_FORBIDDEN'
            : res.status === 401
              ? 'MODEL_UNAUTHORIZED'
              : res.status === 404
                ? 'MODEL_NOT_FOUND'
                : 'MODEL_BAD_REQUEST'
        // 4xx 不再一律直接抛出：交由外层 adaptOn4xx 判断能否通过参数降级自愈。
        // 已经产出内容时例外——重复拼接正文的风险高于自愈收益。
        if (res.status >= 400 && res.status < 500) {
          throw Object.assign(new Error(`AI 接口错误 ${res.status}：${hint}`), {
            status: res.status,
            code,
            hard4xx: true
          })
        }
        throw Object.assign(new Error(`AI 接口错误 ${res.status}：${hint}`), {
          retryable: true,
          status: res.status,
          code
        })
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      let lastChunkAt = Date.now()
      let gotAny = false
      let stallLimit = FIRST_CHUNK_GRACE_MS // 首字节之前用宽限值，之后回到块间隔阈值

      // 块间隔看门狗：连接已建立后持续监控，超过阈值无新数据即中止。
      // 阈值分两段：还没吐过任何字节时用 FIRST_CHUNK_GRACE_MS（思考型模型首 token 可能很慢），
      // 吐过字节后用 CHUNK_TIMEOUT_MS（此后卡住基本是链路问题）。
      watchdog = setInterval(() => {
        if (aborted) return
        if (Date.now() - lastChunkAt > stallLimit) {
          stalled = true
          ctrl.abort()
        }
      }, 5000)
      watchdog.unref?.()

      // 解析一行 SSE：只有 JSON 解析失败才忽略；上游塞进流里的 json.error 必须透传。
      const handleDataLine = function* (payload) {
        if (!payload || payload === '[DONE]') return
        let json = null
        try {
          json = JSON.parse(payload)
        } catch {
          return
        }
        if (json.error) {
          const emsg = String(json.error.message || json.error.type || '未知错误')
          const retryable = /overload|temporar|upstream|try again|later|busy|retr|quota|rate|insufficient/i.test(emsg)
          throw Object.assign(new Error(`AI 服务错误：${emsg}`), retryable ? { retryable: true } : {})
        }
        const choice = json.choices?.[0]
        const piece = choice?.delta ?? choice?.message ?? {}
        if (choice?.finish_reason) finishReason = choice.finish_reason
        const reasoning = piece.reasoning_content ?? piece.reasoning ?? ''
        const content = piece.content ?? ''
        if (reasoning) {
          emitted = true
          gotReasoning = true
          yield { type: 'reasoning', text: reasoning }
        }
        if (content) {
          emitted = true
          gotContent = true
          yield { type: 'content', text: content }
        }
      }

      try {
        let sseDone = false
        // SSE 规范允许一个事件拆成多行 data:（以空行结束，按 \n 拼接）。
        // 逐行 JSON.parse 会把这种网关输出整段丢掉，表现为「未返回有效内容」。
        let dataLines = []
        const flushEvent = function* () {
          if (!dataLines.length) return
          const payload = dataLines.join('\n')
          dataLines = []
          yield* handleDataLine(payload)
        }
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          lastChunkAt = Date.now()
          if (!gotAny) {
            gotAny = true
            stallLimit = CHUNK_TIMEOUT_MS
          } // 首个字节到达，切回常规阈值
          buf += decoder.decode(value, { stream: true })
          let idx
          while ((idx = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, idx).replace(/\r$/, '').trim()
            buf = buf.slice(idx + 1)
            if (!line) {
              yield* flushEvent() // 空行 = 事件边界
              continue
            }
            if (!line.startsWith('data:')) continue
            const payload = line.slice(5).trim()
            if (payload === '[DONE]') {
              yield* flushEvent()
              sseDone = true
              break
            }
            dataLines.push(payload)
          }
          // 收到 [DONE] 后不再继续读流（避免在已关闭的连接上阻塞）
          if (sseDone) break
        }
        // EOF 收尾：解码器可能还压着字节；最后一个事件可能没有空行结尾
        buf += decoder.decode()
        for (const line of buf.split('\n')) {
          const t = line.replace(/\r$/, '').trim()
          if (!t) {
            yield* flushEvent()
            continue
          }
          if (!t.startsWith('data:')) continue
          const payload = t.slice(5).trim()
          if (payload === '[DONE]') {
            yield* flushEvent()
            continue
          }
          dataLines.push(payload)
        }
        yield* flushEvent()
        if (stalled)
          throw new Error(`AI 响应中断：超过 ${Math.round(CHUNK_TIMEOUT_MS / 1000)} 秒没有新内容，已自动停止`)
        if (!gotAny) throw Object.assign(new Error('AI 接口未返回任何内容'), { retryable: true })
        // 流正常结束但没有任何有效输出（正文/思考都没有）：中转站常见空响应，重试给一次机会
        if (!emitted)
          throw Object.assign(new Error('AI 接口未返回有效内容（流已结束但既没有正文也没有思考输出）'), {
            retryable: true
          })
        // 只吐思考、全程一个正文字符都没有 → 大概率是 max_tokens 被思考耗尽（finish_reason=length）
        if (gotReasoning && !gotContent) {
          const hint =
            finishReason === 'length'
              ? '（流以 finish_reason=length 结束，说明最大输出配额被思考过程耗尽；已尝试自动放大输出上限重试，请稍候）'
              : '（模型只输出了思考过程，没有输出正文）'
          throw Object.assign(new Error(`模型只输出了思考过程、未返回正文${hint}`), { reasoningOnly: true })
        }
        // 把截断元数据交给调用方：正文被 length 截断时不能当作完整章节保存
        yield { type: 'meta', finishReason: finishReason || '', truncated: finishReason === 'length' }
      } finally {
        clearInterval(watchdog)
        try {
          await reader.cancel()
        } catch {
          /* 已关闭 */
        }
      }
      return
    } catch (e) {
      clearTimeout(connectTimer)
      if (watchdog) clearInterval(watchdog)
      try {
        ctrl.abort()
      } catch {
        /* 已中止 */
      }
      if (signal?.aborted) throw new Error('已停止')
      // 看门狗超时：挂起的 read() 抛的是裸 AbortError，用户只能看到
      // "This operation was aborted"。换成带 retryable 标记的人话错误——
      // 已有产出时不可重试（防正文重复），尚无产出时保持原有可重试行为。
      let err = e
      if (stalled && e.name === 'AbortError') {
        err = Object.assign(
          new Error(`AI 响应中断：超过 ${Math.round(CHUNK_TIMEOUT_MS / 1000)} 秒没有新内容，已自动停止`),
          { retryable: !emitted }
        )
      }
      lastErr = err
      // 4xx 且尚未产出内容：先尝试「参数降级」自愈（摘掉不被支持的参数 / 调小输出上限）。
      // 走独立预算，不消耗 attempt，因此不会挤占正常的失败重试次数。
      // 401/403 是鉴权问题：「Invalid token」这类文案会误命中 /token/+/invalid/ 降级规则，
      // 减半 max_tokens 空转三次毫无意义，直接上报
      if (
        err.hard4xx &&
        err.status !== 401 &&
        err.status !== 403 &&
        !emitted &&
        adaptBudget > 0 &&
        adaptOn4xx(String(err.message || ''))
      ) {
        adaptBudget--
        await sleep(300)
        continue
      }
      // 只思考没正文：属于「配额不够」，应放大 max_tokens 重试（此时 emitted 为 true，不满足普通重试条件，需单独放行）
      const growBudget = err.reasoningOnly && effMax < MAX_OUTPUT_TOKENS
      // 已经吐出内容后不再因网络问题重试，避免正文被重复拼接
      const retryable =
        !emitted &&
        (err.retryable ||
          err.name === 'AbortError' ||
          err.name === 'TimeoutError' ||
          err.cause?.code === 'ETIMEDOUT' ||
          /fetch failed|network|timeout|terminated|socket|ECONN/i.test(String(err.message || err.cause)))
      if (!(growBudget || retryable) || attempt === RETRIES) break
      // 即将重试：本轮已 yield 的思考片段调用方已经收到，通知其清空 job.reasoning，
      // 避免重试后的思考与上一轮整段重复（正文有 !emitted 守卫，不需要此处理）
      if (gotReasoning) yield { type: 'reasoning', restart: true, text: '' }
      attempt++
      await sleep(1500 * attempt)
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort)
    }
  }
  throw lastErr || new Error('AI 调用失败')
}

// ---------- Gemini 原生接口 ----------

async function* streamGemini({ baseUrl, apiKey, model, messages, signal, maxTokens, thinkingLevel }) {
  const base = String(baseUrl || '').replace(/\/+$/, '')
  const url = `${base}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`
  const { systemInstruction, contents } = geminiContents(messages)
  // 思考型模型可能把输出配额全耗在思考上、没出正文，失败时自动放大 maxOutputTokens 重试
  const baseTokens = maxTokens && maxTokens > 0 ? Math.min(maxTokens, 262144) : 8192
  const MAX_OUTPUT_TOKENS = 32768
  const generationConfig = {}
  // Gemini 3.x：温度等采样参数已弃用，只有思考等级生效（默认 MEDIUM）
  const level = ['LOW', 'MEDIUM', 'HIGH'].includes(thinkingLevel) ? thinkingLevel : 'MEDIUM'
  generationConfig.thinkingConfig = { thinkingLevel: level }

  let lastErr = null
  for (let attempt = 0; attempt <= GEMINI_RETRIES; attempt++) {
    const effMax = Math.min(baseTokens * Math.pow(2, attempt), MAX_OUTPUT_TOKENS)
    generationConfig.maxOutputTokens = effMax
    const ctrl = new AbortController()
    let aborted = false
    let emitted = false
    let gotContent = false
    let gotReasoning = false
    const onAbort = () => {
      aborted = true
      ctrl.abort()
    }
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    const connectTimer = setTimeout(() => {
      if (!aborted) ctrl.abort()
    }, GEMINI_CONNECT_TIMEOUT_MS)
    connectTimer.unref?.()

    let watchdog = null
    // 同 streamOpenAI：看门狗标记要提到 catch 可见的作用域
    let stalled = false
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({ contents, ...(systemInstruction ? { systemInstruction } : {}), generationConfig }),
        signal: ctrl.signal
      })
      clearTimeout(connectTimer)

      if (!res.ok) {
        const text = await res.text().catch(() => '')
        let hint = text.slice(0, 300)
        try {
          const j = JSON.parse(text)
          hint = j.error?.message || j.error?.details?.[0]?.reason || hint
        } catch {}
        if (res.status >= 400 && res.status < 500) {
          throw Object.assign(new Error(`AI 接口错误 ${res.status}：${hint}`), {
            status: res.status,
            code: res.status === 403 ? 'MODEL_FORBIDDEN' : 'MODEL_BAD_REQUEST'
          })
        }
        throw Object.assign(new Error(`AI 接口错误 ${res.status}：${hint}`), { retryable: true, status: res.status })
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      let lastChunkAt = Date.now()
      let gotAny = false
      let stallLimit = GEMINI_FIRST_CHUNK_GRACE_MS

      watchdog = setInterval(() => {
        if (aborted) return
        if (Date.now() - lastChunkAt > stallLimit) {
          stalled = true
          ctrl.abort()
        }
      }, 5000)
      watchdog.unref?.()

      let geminiFinish = ''
      const handleGeminiLine = function* (payload) {
        if (!payload) return
        let json = null
        try {
          json = JSON.parse(payload)
        } catch {
          return
        }
        if (json.error) {
          const emsg = String(json.error.message || json.error.status || json.error.code || '未知错误')
          const retryable = /overload|temporar|upstream|try again|later|busy|retr|quota|rate|insufficient/i.test(emsg)
          throw Object.assign(new Error(`AI 服务错误：${emsg}`), retryable ? { retryable: true } : {})
        }
        const cand = json.candidates?.[0]
        if (!cand) return
        if (cand.finishReason === 'SAFETY' || cand.finishReason === 'BLOCKLIST') {
          throw new Error(`内容被 Gemini 安全策略拦截（${cand.finishReason}），请调整提示词或降低思考等级后重试`)
        }
        if (cand.finishReason) geminiFinish = String(cand.finishReason)
        // 标准流：content.parts[]（思考片段带 thought:true）
        let reasonText = ''
        let contentText = ''
        const parts = cand.content?.parts || []
        for (const p of parts) {
          if (typeof p?.text !== 'string' || !p.text) continue
          if (p.thought) reasonText += p.text
          else contentText += p.text
        }
        if (reasonText) {
          emitted = true
          gotReasoning = true
          yield { type: 'reasoning', text: reasonText }
        }
        if (contentText) {
          emitted = true
          gotContent = true
          yield { type: 'content', text: contentText }
        }
        // 部分通道把思考单独放 candidates[].thoughts[]，兜底处理
        const thoughts =
          cand.thoughts || (typeof cand.content?.thinking === 'string' ? [{ text: cand.content.thinking }] : [])
        for (const t of thoughts) {
          if (typeof t?.text === 'string' && t.text) {
            emitted = true
            gotReasoning = true
            yield { type: 'reasoning', text: t.text }
          }
        }
      }

      try {
        let sseDone = false
        // SSE 规范允许一个事件拆成多行 data:（以空行结束，按 \n 拼接），逐行解析会整段丢掉
        let dataLines = []
        const flushEvent = function* () {
          if (!dataLines.length) return
          const payload = dataLines.join('\n')
          dataLines = []
          yield* handleGeminiLine(payload)
        }
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          lastChunkAt = Date.now()
          if (!gotAny) {
            gotAny = true
            stallLimit = GEMINI_CHUNK_TIMEOUT_MS
          }
          buf += decoder.decode(value, { stream: true })
          let idx
          while ((idx = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, idx).replace(/\r$/, '').trim()
            buf = buf.slice(idx + 1)
            if (!line) {
              yield* flushEvent()
              continue
            }
            if (!line.startsWith('data:')) continue
            const payload = line.slice(5).trim()
            if (payload === '[DONE]') {
              yield* flushEvent()
              sseDone = true
              break
            }
            dataLines.push(payload)
          }
          // 收到 [DONE] 后不再继续读流（避免在已关闭的连接上阻塞）
          if (sseDone) break
        }
        // EOF 收尾：解码器可能还压着字节；最后一个事件可能没有空行结尾
        buf += decoder.decode()
        for (const line of buf.split('\n')) {
          const t = line.replace(/\r$/, '').trim()
          if (!t) {
            yield* flushEvent()
            continue
          }
          if (!t.startsWith('data:')) continue
          const payload = t.slice(5).trim()
          if (payload === '[DONE]') {
            yield* flushEvent()
            continue
          }
          dataLines.push(payload)
        }
        yield* flushEvent()
        if (stalled)
          throw new Error(`AI 响应中断：超过 ${Math.round(GEMINI_CHUNK_TIMEOUT_MS / 1000)} 秒没有新内容，已自动停止`)
        if (!gotAny) throw Object.assign(new Error('AI 接口未返回任何内容'), { retryable: true })
        // 流正常结束但没有任何有效输出（正文/思考都没有）：空响应，重试给一次机会
        if (!emitted)
          throw Object.assign(new Error('AI 接口未返回有效内容（流已结束但既没有正文也没有思考输出）'), {
            retryable: true
          })
        // 只吐思考、没有正文 → 配额被思考耗尽或模型端未产出，放大输出上限重试
        if (gotReasoning && !gotContent) {
          throw Object.assign(new Error('模型只输出了思考过程、未返回正文（已尝试自动放大输出上限重试，请稍候）'), {
            reasoningOnly: true
          })
        }
        const truncated = geminiFinish === 'MAX_TOKENS' || geminiFinish === 'LENGTH'
        yield { type: 'meta', finishReason: geminiFinish, truncated }
      } finally {
        clearInterval(watchdog)
        try {
          await reader.cancel()
        } catch {
          /* 已关闭 */
        }
      }
      return
    } catch (e) {
      clearTimeout(connectTimer)
      if (watchdog) clearInterval(watchdog)
      try {
        ctrl.abort()
      } catch {
        /* 已中止 */
      }
      if (signal?.aborted) throw new Error('已停止')
      // 看门狗超时换人话（同 streamOpenAI 的说明）
      let err = e
      if (stalled && e.name === 'AbortError') {
        err = Object.assign(
          new Error(`AI 响应中断：超过 ${Math.round(GEMINI_CHUNK_TIMEOUT_MS / 1000)} 秒没有新内容，已自动停止`),
          { retryable: !emitted }
        )
      }
      lastErr = err
      // 只思考没正文：放大 maxOutputTokens 重试
      const growBudget = err.reasoningOnly && effMax < MAX_OUTPUT_TOKENS
      const retryable =
        !emitted &&
        (err.retryable ||
          err.name === 'AbortError' ||
          err.name === 'TimeoutError' ||
          err.cause?.code === 'ETIMEDOUT' ||
          /fetch failed|network|timeout|terminated|socket|ECONN/i.test(String(err.message || err.cause)))
      if (!(growBudget || retryable) || attempt === GEMINI_RETRIES) break
      // 即将重试：通知调用方清空上一轮的思考片段，避免整段重复
      if (gotReasoning) yield { type: 'reasoning', restart: true, text: '' }
      await sleep(1500 * (attempt + 1))
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort)
    }
  }
  throw lastErr || new Error('AI 调用失败')
}

/**
 * 流式调用 chat/completions，产出 { type: 'content' | 'reasoning' | 'meta', text } 片段：
 * - content：正文增量
 * - reasoning：思考型模型的推理过程（reasoning_content / reasoning 字段）
 * - meta：流结束元信息（finishReason / truncated）
 * provider = 'gemini' 时改走 Gemini 原生 streamGenerateContent 最新格式。
 */
export async function* streamChat(connOrOpts, maybeOpts) {
  // 兼容两种调用方式：
  //  - 历史写法 callAI(conn, { messages, ... })（conn 是连接对象，opts 是请求参数）
  //  - 单对象写法 streamChat({ ...conn, messages, ... })（测试 / 直接调用）
  // 漏合并会导致 messages 落到第二个被忽略的参数上、JSON 序列化时整键丢失，
  // 上游直接回 400「messages are required」。
  const opts = maybeOpts ? { ...connOrOpts, ...maybeOpts } : connOrOpts
  if (opts?.provider === 'gemini') {
    yield* streamGemini(opts)
    return
  }
  yield* streamOpenAI(opts)
}
