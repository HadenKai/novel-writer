import { codexError, isCodexRegionDenied } from './codex-oauth.mjs'

export const CODEX_PROVIDER = 'chatgpt-subscription'
export const CODEX_REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const BASE = 'https://chatgpt.com/backend-api/codex'
// This endpoint filters models by Codex client compatibility, independently of the app's own version.
const CATALOG_CLIENT_VERSION = '0.171.0'
const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'
const USAGE_CACHE_MS = 60_000
const USAGE_TIMEOUT_MS = 8_000
const USAGE_WINDOWS = [18_000, 604_800]
const CONNECT_TIMEOUT = 30_000
const FIRST_CHUNK_TIMEOUT = 300_000
const CHUNK_TIMEOUT = 120_000
let configuredClient = null

export function configureCodexClient(client) {
  configuredClient = client
}

export function getCodexClient() {
  return configuredClient
}

function textParts(content) {
  if (typeof content === 'string') return content
  return Array.isArray(content)
    ? content
        .filter(part => part?.type === 'text')
        .map(part => part.text)
        .join('\n')
    : ''
}

function requestBody({ model, messages }, reasoning) {
  const instructions = messages
    .filter(m => m.role === 'system')
    .map(m => textParts(m.content))
    .filter(Boolean)
    .join('\n\n')
  const input = messages
    .filter(m => ['user', 'assistant', 'developer'].includes(m.role))
    .map(m => {
      const items = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content || []
      const content = []
      for (const item of items) {
        if (item?.type === 'text' && typeof item.text === 'string' && item.text) {
          content.push({ type: m.role === 'assistant' ? 'output_text' : 'input_text', text: item.text })
        } else if (item?.type === 'image_url' && m.role === 'user' && typeof item.image_url?.url === 'string') {
          content.push({ type: 'input_image', image_url: item.image_url.url, detail: 'auto' })
        }
      }
      return { type: 'message', role: m.role, content }
    })
    .filter(m => m.content.length)
  return {
    model,
    instructions: instructions || '你是小说工坊的创作助手。',
    input,
    stream: true,
    store: false,
    ...(reasoning && { reasoning })
  }
}

function responseFailure(status, error) {
  if (isCodexRegionDenied(error)) return codexError('CODEX_REGION_UNAVAILABLE')
  const code = String(error?.code || error?.type || '').toLowerCase()
  const message = typeof error === 'string' ? error : String(error?.message || '')
  if (status === 429 || /usage_limit|rate_limit|quota/.test(code) || /(?:usage|rate) limit|quota/i.test(message)) {
    return codexError('CODEX_RATE_LIMIT')
  }
  if (
    status === 403 ||
    status === 404 ||
    /workspace|region|residency|model_not_found|model_not_allowed|insufficient_scope|permission_denied/.test(code) ||
    /workspace.{0,80}(?:not authorized|not allowed|permission)|not authorized in this region|insufficient scope/i.test(
      message
    )
  ) {
    return codexError('CODEX_MODEL_FORBIDDEN')
  }
  if (status === 401) return codexError('CODEX_RECONNECT')
  return codexError(status >= 500 ? 'CODEX_NETWORK' : 'CODEX_INVALID_RESPONSE')
}

async function* readEvents(body, signal, armTimeout) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let pending = ''
  let data = []
  armTimeout(FIRST_CHUNK_TIMEOUT)
  try {
    while (true) {
      signal.throwIfAborted()
      const { done, value } = await reader.read()
      signal.throwIfAborted()
      if (done) break
      armTimeout(CHUNK_TIMEOUT)
      pending += decoder.decode(value, { stream: true })
      if (pending.length > 8_000_000) throw codexError('CODEX_INVALID_RESPONSE')
      const lines = pending.split('\n')
      pending = lines.pop()
      for (const raw of lines) {
        signal.throwIfAborted()
        const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
        if (line.startsWith('data:')) {
          data.push(line.slice(5).replace(/^ /, ''))
        } else if (!line && data.length) {
          const event = data.join('\n')
          data = []
          if (event !== '[DONE]') {
            let parsed
            try {
              parsed = JSON.parse(event)
            } catch {
              throw codexError('CODEX_INVALID_RESPONSE')
            }
            if (parsed) yield parsed
          }
        }
      }
    }
  } finally {
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

function finalText(response) {
  return (response?.output || [])
    .filter(item => item?.type === 'message')
    .flatMap(item => (item.content || []).filter(part => part?.type === 'output_text').map(part => part.text || ''))
    .join('')
}

function usageWindows(payload) {
  const rateLimit = payload?.rate_limit
  const windows = [rateLimit?.primary_window, rateLimit?.secondary_window]
  return USAGE_WINDOWS.flatMap(durationSeconds => {
    const window = windows.find(
      item => item?.limit_window_seconds === durationSeconds && Number.isFinite(item.used_percent)
    )
    if (!window) return []
    return [
      {
        durationSeconds,
        remainingPercent: Math.min(100, Math.max(0, 100 - window.used_percent)),
        resetsAt:
          Number.isSafeInteger(window.reset_at) && window.reset_at > 0 && window.reset_at <= 8_640_000_000_000
            ? window.reset_at * 1000
            : null
      }
    ]
  })
}

export function createCodexClient({ auth, fetchImpl = fetch, appVersion = '0.1.0' }) {
  let catalog = null
  let usage = null

  async function request(url, connectionRef, options, signal, armTimeout, allowRefresh = true) {
    let credential = await auth.getCredential(connectionRef, { signal })
    for (let attempt = 0; attempt < 2; attempt++) {
      let response
      try {
        armTimeout?.(CONNECT_TIMEOUT)
        response = await fetchImpl(url, {
          ...options,
          redirect: 'error',
          headers: {
            Authorization: 'Bearer ' + credential.accessToken,
            'ChatGPT-Account-ID': credential.accountId,
            ...(credential.residency && { 'x-openai-internal-codex-residency': credential.residency }),
            'User-Agent': 'NovelWriter/' + appVersion,
            originator: 'novel-writer',
            ...options.headers
          },
          signal
        })
      } catch {
        signal.throwIfAborted()
        throw codexError('CODEX_NETWORK')
      }
      signal.throwIfAborted()
      if (response.ok) return response
      const data = await response.json().catch(() => null)
      signal.throwIfAborted()
      const error = data?.error || data?.detail || data
      const failure = responseFailure(response.status, error)
      if (!allowRefresh || response.status !== 401 || failure.code !== 'CODEX_RECONNECT' || attempt !== 0) throw failure
      credential = await auth.getCredential(connectionRef, { rejectedAccessToken: credential.accessToken, signal })
    }
  }

  async function listModels(connectionRef, { signal, optional = false } = {}) {
    const timeout = AbortSignal.timeout(optional ? 4_000 : 15_000)
    const active = signal ? AbortSignal.any([signal, timeout]) : timeout
    let payload
    try {
      const response = await request(
        BASE + '/models?client_version=' + CATALOG_CLIENT_VERSION,
        connectionRef,
        {
          method: 'GET',
          headers: { Accept: 'application/json' }
        },
        active,
        undefined,
        !optional
      )
      payload = await response.json()
    } catch (error) {
      signal?.throwIfAborted()
      if (timeout.aborted) throw codexError('CODEX_NETWORK')
      if (String(error?.code || '').startsWith('CODEX_')) throw error
      throw codexError('CODEX_INVALID_RESPONSE')
    }
    if (!Array.isArray(payload?.models)) throw codexError('CODEX_INVALID_RESPONSE')
    const visible = payload.models.filter(
      m => typeof m?.slug === 'string' && m.slug.trim() && !/^(hide|hidden)$/i.test(m.visibility || '')
    )
    visible.sort((a, b) => (a.priority ?? 10_000) - (b.priority ?? 10_000))
    const models = new Map()
    const capabilities = new Map()
    for (const m of visible) {
      const id = m.slug.trim()
      if (models.has(id)) continue
      const levels = Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels : []
      const reasoningEfforts = CODEX_REASONING_EFFORTS.filter(effort => levels.some(level => level?.effort === effort))
      models.set(id, {
        id,
        label: typeof m.display_name === 'string' && m.display_name.trim() ? m.display_name.trim() : id,
        reasoningEfforts
      })
      capabilities.set(id, {
        efforts: reasoningEfforts,
        summary: m.supports_reasoning_summary_parameter === true
      })
    }
    catalog = { connectionRef, expiresAt: Date.now() + 5 * 60_000, capabilities }
    return [...models.values()]
  }

  function requireUsageAccount(connectionRef) {
    const status = auth.status()
    if (status.state !== 'connected') throw codexError(status.code || 'CODEX_RECONNECT')
    if (status.connectionRef !== connectionRef) throw codexError('CODEX_ACCOUNT_MISMATCH')
  }

  async function getUsage(connectionRef, { force = false } = {}) {
    requireUsageAccount(connectionRef)
    if (usage?.connectionRef !== connectionRef) usage = { connectionRef, snapshot: null, pending: null }
    const account = usage
    if (account.pending) return account.pending
    if (!force && account.snapshot && Date.now() - account.snapshot.fetchedAt < USAGE_CACHE_MS) {
      return account.snapshot
    }

    const signal = AbortSignal.timeout(USAGE_TIMEOUT_MS)
    account.pending = (async () => {
      try {
        const response = await request(
          USAGE_URL,
          connectionRef,
          { method: 'GET', headers: { Accept: 'application/json' } },
          signal
        )
        const payload = await response.json()
        signal.throwIfAborted()
        if (usage !== account) throw codexError('CODEX_ACCOUNT_MISMATCH')
        requireUsageAccount(connectionRef)
        const snapshot = { windows: usageWindows(payload), fetchedAt: Date.now() }
        account.snapshot = snapshot
        return snapshot
      } catch (error) {
        if (signal.aborted) throw codexError('CODEX_NETWORK')
        if (String(error?.code || '').startsWith('CODEX_')) throw error
        throw codexError('CODEX_INVALID_RESPONSE')
      } finally {
        account.pending = null
      }
    })()
    return account.pending
  }

  async function reasoningFor({ model, connectionRef, reasoningEffort }, signal) {
    if (!CODEX_REASONING_EFFORTS.includes(reasoningEffort)) return null
    if (catalog?.connectionRef !== connectionRef || catalog.expiresAt <= Date.now()) {
      const previous = catalog
      try {
        await listModels(connectionRef, { signal, optional: true })
      } catch {
        signal.throwIfAborted()
        if (catalog === previous) catalog = { connectionRef, expiresAt: Date.now() + 30_000, capabilities: new Map() }
      }
    }
    const capability = catalog?.connectionRef === connectionRef ? catalog.capabilities.get(model) : null
    if (!capability?.efforts.includes(reasoningEffort)) return null
    return { effort: reasoningEffort, ...(capability.summary && { summary: 'auto' }) }
  }

  async function* stream(options) {
    const timeout = new AbortController()
    const { connectionRef, signal } = options
    const active = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal
    let timer
    let emittedText = false
    const armTimeout = ms => {
      clearTimeout(timer)
      timer = setTimeout(() => timeout.abort(codexError('CODEX_NETWORK')), ms)
      timer.unref?.()
    }
    try {
      const reasoning = await reasoningFor(options, active)
      const response = await request(
        BASE + '/responses',
        connectionRef,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
          body: JSON.stringify(requestBody(options, reasoning))
        },
        active,
        armTimeout
      )
      if (!response.body) throw codexError('CODEX_STREAM_INTERRUPTED')
      for await (const event of readEvents(response.body, active, armTimeout)) {
        if (event.type === 'response.output_text.delta' && typeof event.delta === 'string' && event.delta) {
          emittedText = true
          yield { type: 'content', text: event.delta }
        } else if (
          event.type === 'response.reasoning_summary_text.delta' &&
          typeof event.delta === 'string' &&
          event.delta
        ) {
          yield { type: 'reasoning', text: event.delta }
        } else if (event.type === 'response.completed' || event.type === 'response.incomplete') {
          const truncated =
            event.type === 'response.incomplete' && event.response?.incomplete_details?.reason === 'max_output_tokens'
          if (event.type === 'response.incomplete' && !truncated) throw codexError('CODEX_INVALID_RESPONSE')
          const text = emittedText ? '' : finalText(event.response)
          if (text) yield { type: 'content', text }
          active.throwIfAborted()
          yield { type: 'meta', finishReason: truncated ? 'length' : 'stop', truncated }
          return
        } else if (['response.failed', 'error', 'response.cancelled'].includes(event.type)) {
          throw responseFailure(0, event.response?.error || event.error || event)
        }
      }
      throw codexError('CODEX_STREAM_INTERRUPTED')
    } catch (error) {
      signal?.throwIfAborted()
      if (timeout.signal.aborted) throw timeout.signal.reason
      if (String(error?.code || '').startsWith('CODEX_')) throw error
      throw codexError(emittedText ? 'CODEX_STREAM_INTERRUPTED' : 'CODEX_NETWORK')
    } finally {
      clearTimeout(timer)
      timeout.abort()
    }
  }

  return {
    status: () => auth.status(),
    listModels,
    getUsage,
    clearUsage: () => {
      usage = null
    },
    stream
  }
}
