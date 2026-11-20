import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createCodexAuth } from '../server/codex-oauth.mjs'
import { createCodexCredentialStorage } from '../electron/codex-credentials.mjs'

const authClaim = 'https://api.openai.com/auth'
const json = (data, status = 200) => Response.json(data, { status })
const deferred = () => Promise.withResolvers()
const jwt = (now, accountId = 'workspace-A', duration = 1000) =>
  'header.' +
  Buffer.from(
    JSON.stringify({ sub: 'user-A', exp: now / 1000 + duration, [authClaim]: { chatgpt_account_id: accountId } })
  ).toString('base64url') +
  '.signature'

function fixture({ poll, exchange, refresh, deadline = 60, initialNow = 1_000_000 } = {}) {
  let now = initialNow
  let record = null
  let writes = 0
  const calls = []
  const auth = createCodexAuth({
    clientId: 'public-client-for-tests',
    storage: {
      isAvailable: () => true,
      read: async () => record,
      write: async next => {
        record = next
        writes++
      },
      clear: async () => {
        record = null
      }
    },
    now: () => now,
    sleep: async (ms, signal) => {
      signal.throwIfAborted()
      now += ms
      await new Promise(resolve => setImmediate(resolve))
    },
    fetchImpl: async (url, options) => {
      const kind = new URL(url).pathname
      calls.push(kind)
      assert.equal(options.redirect, 'error')
      if (kind.endsWith('/usercode'))
        return json({ user_code: 'ABCD-ABCD', device_auth_id: 'hidden', expires_in: deadline, interval: 3 })
      if (kind.endsWith('/deviceauth/token'))
        return poll?.(calls) ?? json({ authorization_code: 'auth-code', code_verifier: 'hidden' })
      if (new URLSearchParams(options.body).get('grant_type') === 'refresh_token')
        return refresh?.(now) ?? json({ access_token: jwt(now), refresh_token: 'new-rotate' })
      return exchange?.(now) ?? json({ access_token: jwt(now), refresh_token: 'test-rotate' })
    }
  })
  return {
    auth,
    calls,
    advance: ms => {
      now += ms
    },
    record: () => record,
    writes: () => writes
  }
}

async function waitFor(auth, id, state) {
  for (let count = 0; count < 30; count++) {
    if (auth.attempt(id)?.state === state) return
    await new Promise(resolve => setImmediate(resolve))
  }
  assert.equal(auth.attempt(id)?.state, state)
}

test('device authorization polls pending states and persists only the current attempt', async () => {
  const f = fixture({
    poll: calls => {
      const n = calls.filter(c => c.endsWith('/deviceauth/token')).length
      return n <= 2 ? json({}, n === 1 ? 403 : 404) : json({ authorization_code: 'auth-code', code_verifier: 'hidden' })
    }
  })
  const a = await f.auth
  const attempt = await a.start()
  assert.equal(attempt.userCode, 'ABCD-ABCD')
  assert.equal(attempt.device_auth_id, undefined)
  await waitFor(a, attempt.attemptId, 'connected')
  assert.equal(f.writes(), 1)
  const firstRef = a.status().connectionRef
  assert.equal(a.status().accessToken, undefined)
  await a.disconnect()
  const sameUser = await a.start()
  await waitFor(a, sameUser.attemptId, 'connected')
  assert.equal(a.status().connectionRef, firstRef)

  const entered = deferred()
  const exchange = deferred()
  const late = fixture({
    exchange: now => {
      entered.resolve(now)
      return exchange.promise
    }
  })
  const b = await late.auth
  const doomed = await b.start()
  const time = await entered.promise
  await b.cancel(doomed.attemptId)
  exchange.resolve(json({ access_token: jwt(time), refresh_token: 'late' }))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(b.attempt(doomed.attemptId).state, 'cancelled')
  assert.equal(late.writes(), 0)
})

test('device polling honours expiration and a bounded number of network failures', async () => {
  const f = fixture({ deadline: 7, poll: () => json({}, 404) })
  const a = await f.auth
  const { attemptId } = await a.start()
  await waitFor(a, attemptId, 'expired')
  assert.equal(f.calls.filter(c => c.endsWith('/deviceauth/token')).length, 2)
  const offline = fixture({
    poll: () => {
      throw new TypeError('offline')
    }
  })
  const b = await offline.auth
  const attempt = await b.start()
  await waitFor(b, attempt.attemptId, 'error')
  assert.equal(b.attempt(attempt.attemptId).code, 'CODEX_NETWORK')
  assert.equal(offline.calls.filter(c => c.endsWith('/deviceauth/token')).length, 6)
})

test('refresh is shared, stale 401s reuse rotation, and a disconnected session cannot resurrect', async () => {
  let refreshCount = 0
  const entered = deferred()
  const late = deferred()
  const f = fixture({
    refresh: now => {
      refreshCount++
      if (refreshCount === 2) {
        entered.resolve(now)
        return late.promise
      }
      return json({ access_token: jwt(now, 'workspace-A', 1500), refresh_token: 'fresh' })
    }
  })
  const a = await f.auth
  const { attemptId } = await a.start()
  await waitFor(a, attemptId, 'connected')
  const { connectionRef } = a.status()
  const old = (await a.getCredential(connectionRef)).accessToken
  const cancelled = new AbortController()
  const cancelledWait = a.getCredential(connectionRef, { rejectedAccessToken: old, signal: cancelled.signal })
  const stillWaiting = a.getCredential(connectionRef, { rejectedAccessToken: old })
  cancelled.abort()
  await assert.rejects(cancelledWait, { name: 'AbortError' })
  const next = await stillWaiting
  assert.equal((await a.getCredential(connectionRef, { rejectedAccessToken: old })).accessToken, next.accessToken)
  assert.equal(refreshCount, 1)
  assert.equal(f.record().refreshToken, 'fresh')
  const pending = a.getCredential(connectionRef, { rejectedAccessToken: next.accessToken })
  const rejected = assert.rejects(pending, { code: 'CODEX_RECONNECT' })
  const time = await entered.promise
  await a.disconnect()
  late.resolve(json({ access_token: jwt(time), refresh_token: 'late' }))
  await rejected
  assert.equal(a.status().state, 'disconnected')
  assert.equal(f.record(), null)
})

test('terminal refresh errors require reconnection and transient errors preserve the record', async () => {
  let offline = true
  const f = fixture({
    refresh: () => {
      if (offline) throw new TypeError('wire failure')
      return json({ error: 'invalid_grant' }, 400)
    }
  })
  const a = await f.auth
  const { attemptId } = await a.start()
  await waitFor(a, attemptId, 'connected')
  const { connectionRef } = a.status()
  f.advance(1_100_000)
  await assert.rejects(a.getCredential(connectionRef), { code: 'CODEX_NETWORK' })
  assert.equal(a.status().state, 'connected')
  offline = false
  await assert.rejects(a.getCredential(connectionRef), { code: 'CODEX_RECONNECT' })
  assert.equal(a.status().state, 'reconnect')
  assert.equal(f.record().refreshToken, undefined)
})

test('failed credential removal blocks inference across restart until retried', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-codex-disconnect-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const filePath = path.join(dir, 'codex.enc')
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: text => Buffer.from(text),
    decryptString: bytes => bytes.toString()
  }
  const storage = createCodexCredentialStorage({ filePath, safeStorage })
  await storage.write({
    state: 'connected',
    accessToken: 'old-token',
    refreshToken: 'old-refresh',
    accountId: 'workspace',
    connectionRef: 'account-ref',
    expiresAt: Date.now() + 600_000
  })
  const auth = await createCodexAuth({ storage })
  const displaced = filePath + '.locked-test-fixture'
  await fs.rename(filePath, displaced)
  await fs.mkdir(filePath)
  await assert.rejects(auth.disconnect(), { code: 'CODEX_DISCONNECT_FAILED' })
  assert.equal(auth.status().state, 'disconnect-error')
  await assert.rejects(auth.getCredential('account-ref'), { code: 'CODEX_DISCONNECT_FAILED' })
  await fs.rmdir(filePath)
  await fs.rename(displaced, filePath)

  const restarted = await createCodexAuth({ storage })
  assert.equal(restarted.status().state, 'disconnect-error')
  await assert.rejects(restarted.start(), { code: 'CODEX_DISCONNECT_FAILED' })
  await restarted.disconnect()
  assert.equal(restarted.status().state, 'disconnected')
  assert.equal(await storage.read(), null)
})

test('credential storage encrypts the record with no plaintext fallback or previous backup', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-codex-auth-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const filePath = path.join(dir, 'codex.json')
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: text => Buffer.from(text).map(byte => byte ^ 117),
    decryptString: bytes =>
      Buffer.from(bytes)
        .map(byte => byte ^ 117)
        .toString()
  }
  const storage = createCodexCredentialStorage({ filePath, safeStorage })
  await storage.write({ accessToken: 'secret-token' })
  assert.match(await fs.readFile(filePath, 'utf8'), /^[A-Za-z0-9+/=]+\s*$/)
  assert.deepEqual(await storage.read(), { accessToken: 'secret-token' })
  await storage.write({ accessToken: 'new-token' })
  assert.deepEqual(await fs.readdir(dir), ['codex.json'])
  const unsafe = createCodexCredentialStorage({
    filePath,
    safeStorage: { ...safeStorage, getSelectedStorageBackend: () => 'basic_text' }
  })
  await assert.rejects(unsafe.write({ accessToken: 'plaintext' }), { code: 'CODEX_UNAVAILABLE' })
  assert.deepEqual(await storage.read(), { accessToken: 'new-token' })
  await storage.clear()
  assert.equal(await storage.read(), null)
})
