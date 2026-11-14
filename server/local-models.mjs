// 本地模型接入：探测本机常见的推理服务，并把它们的模型列出来。
//
// 设计原则：
//  - 本地服务（Ollama / LM Studio / llama.cpp / vLLM …）大多不需要 API Key，
//    所以这里一律不带 Authorization 头；万一某个服务开了鉴权，返回 401 会如实标注，
//    由用户自己决定要不要填密钥。
//  - 只探回环地址与本机私有网段，避免把「扫描」变成内网探测器。
//  - 探测是并行的且超时很短（1.2s）：本机服务没开就是没开，不该让用户等。
import { normalizeOpenAIBase } from './ai.mjs'

/** 常见本地推理服务的默认端口。port 仅用于展示与生成 baseUrl。 */
export const LOCAL_RUNTIMES = [
  {
    id: 'ollama',
    name: 'Ollama',
    host: '127.0.0.1',
    port: 11434,
    path: '/v1',
    hint: 'ollama serve 默认端口；模型名形如 qwen2.5:14b'
  },
  { id: 'lmstudio', name: 'LM Studio', host: '127.0.0.1', port: 1234, path: '/v1', hint: '开发者面板启动本地服务器' },
  { id: 'llamacpp', name: 'llama.cpp', host: '127.0.0.1', port: 8080, path: '/v1', hint: 'llama-server 默认端口' },
  { id: 'vllm', name: 'vLLM', host: '127.0.0.1', port: 8000, path: '/v1', hint: 'vllm serve 默认端口' },
  {
    id: 'oobabooga',
    name: 'Text Generation WebUI',
    host: '127.0.0.1',
    port: 5000,
    path: '/v1',
    hint: 'oobabooga 的 OpenAI 兼容扩展'
  },
  { id: 'koboldcpp', name: 'KoboldCpp', host: '127.0.0.1', port: 5001, path: '/v1', hint: 'KoboldCpp 默认端口' }
]

export function runtimeBaseUrl(rt) {
  return `http://${rt.host}:${rt.port}${rt.path}`
}

/** 只允许本机 / 私有网段：本地模型探测不应成为内网扫描器 */
export function isLoopbackHost(hostname) {
  const h = String(hostname || '')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
  if (!h) return false
  if (h === 'localhost' || h === '::1' || h === '0.0.0.0') return true
  if (/^127\./.test(h)) return true
  if (/^10\./.test(h)) return true
  if (/^192\.168\./.test(h)) return true
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true
  return false
}

function timeoutSignal(ms, outer) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  timer.unref?.()
  const onAbort = () => ctrl.abort()
  if (outer) {
    if (outer.aborted) ctrl.abort()
    else outer.addEventListener('abort', onAbort, { once: true })
  }
  return {
    signal: ctrl.signal,
    done: () => {
      clearTimeout(timer)
      if (outer) outer.removeEventListener('abort', onAbort)
    }
  }
}

async function getJson(url, { timeoutMs = 1200, outer } = {}) {
  const t = timeoutSignal(timeoutMs, outer)
  try {
    const r = await fetch(url, { signal: t.signal, headers: { Accept: 'application/json' } })
    const text = await r.text().catch(() => '')
    let json = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = null
    }
    return { ok: r.ok, status: r.status, json, text: text.slice(0, 300) }
  } catch (e) {
    // 连接被拒 / 超时都当作「这个端口没有服务」，交给上层决定要不要换协议再试
    return { ok: false, status: 0, json: null, text: '', error: String(e?.message || e) }
  } finally {
    t.done()
  }
}

function pickModelNames(json) {
  const arr = Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : []
  return arr
    .map(x => String(x?.id || x?.name || x?.model || '').replace(/^models\//, ''))
    .map(s => s.trim())
    .filter(Boolean)
}

/**
 * 探测单个地址。
 * 先按 OpenAI 兼容协议问 /models；失败且端口像 Ollama 时，再退回原生 /api/tags。
 * 返回 { online, baseUrl, models, error, authRequired, runtime }
 */
export async function probeLocalEndpoint(rawBaseUrl, { timeoutMs = 1200, runtime = null, outer } = {}) {
  const raw = String(rawBaseUrl || '').trim()
  if (!raw) return { online: false, baseUrl: '', models: [], error: '地址为空' }
  let url
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`)
  } catch {
    return { online: false, baseUrl: raw, models: [], error: '地址格式不正确' }
  }
  if (!isLoopbackHost(url.hostname)) {
    return { online: false, baseUrl: raw, models: [], error: '只能探测本机或局域网私有地址' }
  }
  const baseUrl = normalizeOpenAIBase(raw)
  const startedAt = Date.now()

  const primary = await getJson(`${baseUrl}/models`, { timeoutMs, outer })
  if (primary.ok) {
    const models = pickModelNames(primary.json)
    return {
      online: true,
      baseUrl,
      models,
      latencyMs: Date.now() - startedAt,
      runtime: runtime || guessRuntime(baseUrl, models),
      ...(models.length ? {} : { error: '服务在线，但没有返回模型；可能需要在本地服务里先加载模型' })
    }
  }

  // Ollama 原生接口兜底：老版本或反向代理下 /v1/models 会 404，但 /api/tags 一定在。
  // 只在 404/无响应时尝试（401/403 说明是别的鉴权服务，不该继续探）。
  const origin = `${url.protocol}//${url.host}`
  if (primary.status === 404 || primary.status === 0) {
    const tags = await getJson(`${origin}/api/tags`, { timeoutMs, outer })
    if (tags.ok) {
      return {
        online: true,
        baseUrl: normalizeOpenAIBase(`${origin}/v1`),
        models: pickModelNames(tags.json),
        latencyMs: Date.now() - startedAt,
        runtime: 'Ollama',
        native: 'ollama'
      }
    }
  }

  return {
    online: false,
    baseUrl,
    models: [],
    latencyMs: Date.now() - startedAt,
    error:
      primary.status === 401 || primary.status === 403
        ? `服务在线但要求鉴权（HTTP ${primary.status}），可在手动添加时填写密钥`
        : `未响应（HTTP ${primary.status || '无'}）`
  }
}

function guessRuntime(baseUrl, models) {
  const hit = LOCAL_RUNTIMES.find(rt => runtimeBaseUrl(rt) === baseUrl)
  if (hit) return hit.name
  // LM Studio 的模型名常带发布者前缀 org/model
  if ((models || []).some(m => /^[a-z0-9._-]+\/[a-z0-9._-]+$/i.test(m))) return 'LM Studio'
  return '本地服务'
}

/**
 * 扫描本机常见端口 + 用户额外指定的地址。
 * 返回值只包含在线的服务，按「探测耗时」排序，让响应最快的排前面。
 */
export async function scanLocalEndpoints({ extra = [], timeoutMs = 1200 } = {}) {
  const targets = LOCAL_RUNTIMES.map(rt => ({ baseUrl: runtimeBaseUrl(rt), runtime: rt }))
  const known = new Set(targets.map(t => t.baseUrl))
  for (const raw of extra) {
    const s = String(raw || '').trim()
    if (!s) continue
    const normalized = normalizeOpenAIBase(s)
    if (known.has(normalized)) continue
    known.add(normalized)
    targets.push({ baseUrl: normalized, runtime: null })
  }

  const results = await Promise.all(
    targets.map(async t => {
      try {
        const r = await probeLocalEndpoint(t.baseUrl, { timeoutMs, runtime: t.runtime })
        return { ...r, presetId: t.runtime?.id || '', hint: t.runtime?.hint || '' }
      } catch (e) {
        return {
          online: false,
          baseUrl: t.baseUrl,
          models: [],
          presetId: t.runtime?.id || '',
          error: String(e?.message || e)
        }
      }
    })
  )

  return results.filter(r => r.online).sort((a, b) => (a.latencyMs || 0) - (b.latencyMs || 0))
}
