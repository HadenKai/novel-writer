import { createHash, randomUUID } from 'node:crypto'
import { setTimeout as sleepTimer } from 'node:timers/promises'

const ISSUER = 'https://auth.openai.com'
const TOKEN_URL = ISSUER + '/oauth/token'
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const AUTH_CLAIM = 'https://api.openai.com/auth'
const PROFILE_CLAIM = 'https://api.openai.com/profile'
const REFRESH_SKEW = 120_000
const DEVICE_TTL = 15 * 60_000
export const CODEX_VERIFICATION_URL = ISSUER + '/codex/device'

const errorMessages = {
  CODEX_RECONNECT: 'ChatGPT 授权已失效，请在 AI 模型中重新连接。',
  CODEX_DISCONNECT_FAILED: '本机尚未完成断开，请在 AI 模型中重试断开连接。',
  CODEX_ACCOUNT_MISMATCH: '此模型绑定了其他 ChatGPT 账号或工作区，请在 AI 模型中重新绑定。',
  CODEX_MODEL_FORBIDDEN: '当前 ChatGPT 账号或工作区无法使用此模型。',
  CODEX_RATE_LIMIT: 'ChatGPT 订阅用量已达上限，请查看 ChatGPT 用量。',
  CODEX_NETWORK: '无法连接 ChatGPT 服务，请检查网络后重试。',
  CODEX_UNAVAILABLE: '当前环境无法使用 ChatGPT Subscription。',
  CODEX_DEVICE_DISABLED: '设备码授权未开放，请检查 ChatGPT 安全设置或工作区权限。',
  CODEX_REGION_UNAVAILABLE: 'OpenAI 暂不支持当前请求的网络所在地区。',
  CODEX_DEVICE_REQUEST_REJECTED: 'OpenAI 拒绝发放设备码，请检查网络后重试。',
  CODEX_INVALID_RESPONSE: 'ChatGPT 服务返回了无法处理的响应。',
  CODEX_STREAM_INTERRUPTED: 'ChatGPT 响应在完成前断开。'
}

export function codexError(code) {
  return Object.assign(new Error(errorMessages[code] || errorMessages.CODEX_INVALID_RESPONSE), { code })
}

export function isCodexRegionDenied(error) {
  const code = typeof error === 'string' ? error : error?.code || error?.type
  return code === 'unsupported_country_region_territory'
}

function authError(payload) {
  return payload?.error || payload?.detail || payload
}

function deviceRequestFailure(status, payload) {
  const error = authError(payload)
  if (isCodexRegionDenied(error)) return 'CODEX_REGION_UNAVAILABLE'
  if (status === 429) return 'CODEX_RATE_LIMIT'
  if (status >= 500) return 'CODEX_NETWORK'
  const detail = typeof error === 'string' ? error : error?.message
  if (
    /(device(?:[- ]code|[- ]auth(?:entication)?|[- ]authorization)).{0,35}(?:not enabled|disabled)/i.test(detail || '')
  ) {
    return 'CODEX_DEVICE_DISABLED'
  }
  return [401, 403, 404].includes(status) ? 'CODEX_DEVICE_REQUEST_REJECTED' : 'CODEX_INVALID_RESPONSE'
}

function jwtClaims(value) {
  try {
    return JSON.parse(Buffer.from(value.split('.')[1], 'base64url').toString('utf8'))
  } catch {
    return {}
  }
}

function accountEmail(value) {
  if (typeof value !== 'string') return undefined
  const email = value.trim()
  return email.length <= 254 && /^[^\s@]+@[^\s@]+$/.test(email) ? email : undefined
}

// These claims come from the token just returned over TLS by the configured issuer.
// They route model requests and link a saved local connection, not validate a login from the renderer.
function tokenRecord(data, now, previous) {
  const claims = jwtClaims(data?.access_token)
  const auth = claims?.[AUTH_CLAIM]
  const subject = claims?.sub || auth?.chatgpt_user_id
  const accountId = auth?.chatgpt_account_id
  const refreshToken = data?.refresh_token || previous?.refreshToken
  const expiresIn = Number(data?.expires_in) * 1000
  const claimExpiry = Number(claims?.exp) * 1000
  const expiresAt = Math.min(expiresIn > 0 ? now + expiresIn : Infinity, claimExpiry > 0 ? claimExpiry : Infinity)
  if (
    ![data?.access_token, refreshToken, subject, accountId].every(value => typeof value === 'string' && value) ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= now
  ) {
    throw codexError('CODEX_INVALID_RESPONSE')
  }
  const connectionRef = createHash('sha256')
    .update(JSON.stringify(['novel-writer-codex', subject, accountId]))
    .digest('hex')
  const label =
    accountEmail(claims[PROFILE_CLAIM]?.email) ||
    (previous?.connectionRef === connectionRef && accountEmail(previous.label)) ||
    'ChatGPT'
  const residency = auth.chatgpt_data_residency || auth.chatgpt_compute_residency
  return {
    state: 'connected',
    connectionRef,
    label,
    accessToken: data.access_token,
    refreshToken,
    accountId,
    expiresAt,
    ...(typeof residency === 'string' && residency ? { residency } : {})
  }
}

function waitForCaller(promise, signal) {
  if (!signal) return promise
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

export async function createCodexAuth({
  storage,
  fetchImpl = fetch,
  now = Date.now,
  sleep = (ms, signal) => sleepTimer(ms, undefined, { signal }),
  clientId = CLIENT_ID
}) {
  let current = null
  let active = null
  let refresh = null
  let epoch = 0
  let closed = false
  let writes = Promise.resolve()
  const available = () => !closed && storage.isAvailable()

  if (available()) {
    try {
      const saved = await storage.read()
      if (
        saved?.state === 'connected' &&
        saved.accessToken &&
        saved.refreshToken &&
        saved.accountId &&
        saved.connectionRef &&
        Number.isFinite(saved.expiresAt)
      ) {
        const email = accountEmail(jwtClaims(saved.accessToken)?.[PROFILE_CLAIM]?.email)
        current = email ? { ...saved, label: email } : saved
      } else if (saved?.state === 'disconnect-error') current = { state: 'disconnect-error' }
      else if (saved) current = { state: 'reconnect', connectionRef: saved.connectionRef, label: saved.label }
    } catch {
      current = { state: 'reconnect' }
    }
  }

  function status() {
    if (!available()) return { state: 'unavailable', code: 'CODEX_UNAVAILABLE' }
    if (!current) return { state: 'disconnected' }
    const { state, connectionRef, label } = current
    if (state === 'disconnect-error') return { state, code: 'CODEX_DISCONNECT_FAILED' }
    const email = state === 'connected' ? accountEmail(label) : undefined
    return {
      state,
      connectionRef,
      label,
      ...(email && { email }),
      ...(state === 'reconnect' ? { code: 'CODEX_RECONNECT' } : {})
    }
  }

  function update(action) {
    const result = writes.then(action)
    writes = result.catch(() => {})
    return result
  }

  function publicAttempt(record) {
    if (!record) return null
    const { attemptId, state, userCode, expiresAt, code } = record
    return { attemptId, state, ...(userCode && { userCode }), ...(expiresAt && { expiresAt }), ...(code && { code }) }
  }

  function isPending(record) {
    return active === record && !record.controller.signal.aborted && !closed
  }

  function finish(record, state, code) {
    record.state = state
    record.code = code
    delete record.userCode
  }

  async function post(url, data, signal, form = false) {
    try {
      return await fetchImpl(url, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json',
          Accept: 'application/json'
        },
        body: form ? new URLSearchParams(data) : JSON.stringify(data),
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)])
      })
    } catch {
      signal.throwIfAborted()
      throw codexError('CODEX_NETWORK')
    }
  }

  async function json(response) {
    try {
      return await response.json()
    } catch {
      throw codexError('CODEX_INVALID_RESPONSE')
    }
  }

  async function follow(record, deviceId, interval) {
    const { signal } = record.controller
    let consecutiveFailures = 0
    while (isPending(record)) {
      const remaining = record.expiresAt - now()
      if (remaining <= 0) break
      await sleep(Math.min(interval, remaining), signal)
      if (!isPending(record)) return
      if (now() >= record.expiresAt) break
      let reply
      try {
        reply = await post(
          ISSUER + '/api/accounts/deviceauth/token',
          {
            device_auth_id: deviceId,
            user_code: record.userCode
          },
          signal
        )
      } catch (error) {
        if (error.code !== 'CODEX_NETWORK' || ++consecutiveFailures >= 6) throw error
        record.state = 'retrying'
        continue
      }
      if (!isPending(record)) return
      if (now() >= record.expiresAt) break
      consecutiveFailures = 0
      record.state = 'pending'
      if (reply.status === 403 || reply.status === 404) {
        const detail = authError(await reply.json().catch(() => null))
        if (isCodexRegionDenied(detail)) throw codexError('CODEX_REGION_UNAVAILABLE')
        continue
      }
      if (!reply.ok) throw codexError(reply.status === 429 ? 'CODEX_RATE_LIMIT' : 'CODEX_INVALID_RESPONSE')
      const authorization = await json(reply)
      if (!authorization?.authorization_code || !authorization?.code_verifier)
        throw codexError('CODEX_INVALID_RESPONSE')
      if (!isPending(record)) return
      const exchange = await post(
        TOKEN_URL,
        {
          grant_type: 'authorization_code',
          code: authorization.authorization_code,
          redirect_uri: ISSUER + '/deviceauth/callback',
          client_id: clientId,
          code_verifier: authorization.code_verifier
        },
        signal,
        true
      )
      if (!exchange.ok) {
        const detail = authError(await exchange.json().catch(() => null))
        if (isCodexRegionDenied(detail)) throw codexError('CODEX_REGION_UNAVAILABLE')
        throw codexError(exchange.status === 429 ? 'CODEX_RATE_LIMIT' : 'CODEX_RECONNECT')
      }
      const next = tokenRecord(await json(exchange), now())
      await update(async () => {
        if (!isPending(record)) return
        await storage.write(next)
        if (!isPending(record)) {
          if (current && current.state !== 'disconnect-error') await storage.write(current)
          else await storage.clear()
          return
        }
        epoch++
        refresh?.controller.abort(codexError('CODEX_RECONNECT'))
        current = next
        finish(record, 'connected')
      })
      return
    }
    if (isPending(record)) finish(record, 'expired')
  }

  function cancel(attemptId) {
    if (active?.attemptId !== attemptId || !['starting', 'pending', 'retrying'].includes(active.state)) return
    active.controller.abort()
    finish(active, 'cancelled')
  }

  async function start() {
    if (!available()) throw codexError('CODEX_UNAVAILABLE')
    if (current?.state === 'disconnect-error') throw codexError('CODEX_DISCONNECT_FAILED')
    if (active) cancel(active.attemptId)
    const record = { attemptId: randomUUID(), state: 'starting', controller: new AbortController() }
    active = record
    try {
      const reply = await post(
        ISSUER + '/api/accounts/deviceauth/usercode',
        { client_id: clientId },
        record.controller.signal
      )
      if (!isPending(record)) return publicAttempt(record)
      if (!reply.ok) {
        const payload = await reply.json().catch(() => null)
        throw codexError(deviceRequestFailure(reply.status, payload))
      }
      const device = await json(reply)
      if (!isPending(record)) return publicAttempt(record)
      if (
        typeof device?.user_code !== 'string' ||
        !device.user_code ||
        typeof device.device_auth_id !== 'string' ||
        !device.device_auth_id
      ) {
        throw codexError('CODEX_INVALID_RESPONSE')
      }
      const lifetime = Number(device.expires_in) * 1000
      record.userCode = device.user_code
      record.expiresAt = now() + (lifetime > 0 && Number.isFinite(lifetime) ? lifetime : DEVICE_TTL)
      record.state = 'pending'
      const interval = Math.max(3, Number(device.interval) || 5) * 1000
      void follow(record, device.device_auth_id, interval).catch(error => {
        if (isPending(record)) finish(record, 'error', errorMessages[error.code] ? error.code : 'CODEX_UNAVAILABLE')
      })
    } catch (error) {
      if (isPending(record)) finish(record, 'error', errorMessages[error.code] ? error.code : 'CODEX_INVALID_RESPONSE')
    }
    return publicAttempt(record)
  }

  async function refreshRecord(record, version, signal) {
    const response = await post(
      TOKEN_URL,
      {
        grant_type: 'refresh_token',
        refresh_token: record.refreshToken,
        client_id: clientId
      },
      signal,
      true
    )
    const data = await json(response).catch(() => null)
    if (!response.ok) {
      const detail = authError(data)
      if (isCodexRegionDenied(detail)) throw codexError('CODEX_REGION_UNAVAILABLE')
      const code = typeof detail === 'string' ? detail : detail?.code
      if (response.status === 401 || ['invalid_grant', 'invalid_token', 'refresh_token_reused'].includes(code)) {
        await update(async () => {
          if (epoch !== version || current !== record) return
          current = { state: 'reconnect', connectionRef: record.connectionRef, label: record.label }
          await storage.write(current)
        })
        throw codexError('CODEX_RECONNECT')
      }
      throw codexError(response.status === 429 ? 'CODEX_RATE_LIMIT' : 'CODEX_NETWORK')
    }
    const next = tokenRecord(data, now(), record)
    if (next.connectionRef !== record.connectionRef) throw codexError('CODEX_ACCOUNT_MISMATCH')
    return update(async () => {
      if (epoch !== version || current !== record || closed) throw codexError('CODEX_RECONNECT')
      await storage.write(next)
      if (epoch !== version || current !== record || closed) throw codexError('CODEX_RECONNECT')
      current = next
      return next
    })
  }

  async function getCredential(connectionRef, { rejectedAccessToken, signal } = {}) {
    signal?.throwIfAborted()
    if (!available()) throw codexError('CODEX_UNAVAILABLE')
    let record = current
    if (record?.state === 'disconnect-error') throw codexError('CODEX_DISCONNECT_FAILED')
    if (record?.state !== 'connected') throw codexError('CODEX_RECONNECT')
    if (record.connectionRef !== connectionRef) throw codexError('CODEX_ACCOUNT_MISMATCH')
    if (
      record.expiresAt <= now() + REFRESH_SKEW ||
      (rejectedAccessToken && rejectedAccessToken === record.accessToken)
    ) {
      if (refresh?.record !== record) {
        const controller = new AbortController()
        const operation = { record, controller }
        const version = epoch
        operation.promise = refreshRecord(record, version, controller.signal)
          .catch(error => {
            if (epoch !== version || closed) throw codexError('CODEX_RECONNECT')
            throw errorMessages[error.code] ? error : codexError('CODEX_UNAVAILABLE')
          })
          .finally(() => {
            if (refresh === operation) refresh = null
          })
        refresh = operation
      }
      record = await waitForCaller(refresh.promise, signal)
    }
    if (current !== record || closed) throw codexError('CODEX_RECONNECT')
    const { accessToken, accountId, residency } = record
    return { accessToken, accountId, residency }
  }

  async function disconnect() {
    if (active) cancel(active.attemptId)
    epoch++
    const disconnecting = { state: 'disconnect-error' }
    current = disconnecting
    refresh?.controller.abort(codexError('CODEX_RECONNECT'))
    try {
      await update(async () => {
        await storage.clear()
        if (current === disconnecting) current = null
      })
    } catch {
      throw codexError('CODEX_DISCONNECT_FAILED')
    }
  }

  async function shutdown() {
    if (active) cancel(active.attemptId)
    closed = true
    refresh?.controller.abort(codexError('CODEX_RECONNECT'))
    await writes
  }

  return {
    status,
    start,
    cancel,
    disconnect,
    shutdown,
    getCredential,
    attempt: id => publicAttempt(active?.attemptId === id ? active : null)
  }
}
