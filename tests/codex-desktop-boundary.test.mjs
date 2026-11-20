import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { desktopApiHeaders, registerCodexIpc } from '../electron/codex-ipc.mjs'
import { CODEX_VERIFICATION_URL } from '../server/codex-oauth.mjs'

const token = 'secret-session-token-for-test'

test('desktop token is scoped to the trusted window, API origin and frame', () => {
  for (const origin of ['http://localhost:5173', 'http://127.0.0.1:3789']) {
    const mainFrame = { url: origin + '/settings' }
    const contents = { id: 17, mainFrame }
    const details = {
      url: origin + '/api/models',
      webContentsId: 17,
      frame: mainFrame,
      requestHeaders: { Accept: 'application/json' }
    }
    assert.deepEqual(desktopApiHeaders(details, contents, origin, token), {
      Accept: 'application/json',
      'x-novel-token': token
    })
    assert.equal(
      desktopApiHeaders({ ...details, frame: undefined }, contents, origin, token)['x-novel-token'],
      undefined
    )
    for (const denied of [
      { webContentsId: 24 },
      { url: origin + '/settings' },
      { url: 'https://example.invalid/api/models' },
      { frame: { url: origin + '/settings' } },
      { frame: { url: 'https://example.invalid/' } }
    ]) {
      assert.equal(desktopApiHeaders({ ...details, ...denied }, contents, origin, token)['x-novel-token'], undefined)
    }
  }
})

test('subscription IPC requires the trusted frame and opens only the active fixed verification URL', async () => {
  const handlers = new Map()
  const opened = []
  const frame = { url: 'http://localhost:5173/settings' }
  const contents = { mainFrame: frame }
  const trusted = { sender: contents, senderFrame: frame }
  const attempt = { attemptId: 'current', state: 'pending', userCode: 'DISPLAY', expiresAt: Date.now() + 2000 }
  registerCodexIpc({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    getWindow: () => ({ webContents: contents }),
    getOrigin: () => 'http://localhost:5173',
    getAuth: () => ({
      status: () => ({ state: 'connected', connectionRef: 'current-ref' }),
      start: async () => attempt,
      attempt: id => (id === attempt.attemptId ? attempt : null)
    }),
    getClient: () => ({ listModels: async ref => [{ id: ref, label: 'visible' }] }),
    openExternal: async url => {
      opened.push(url)
    }
  })
  await assert.rejects(handlers.get('codex:start')({ sender: {}, senderFrame: frame }), /ChatGPT/)
  await assert.rejects(handlers.get('codex:start')({ sender: contents, senderFrame: { ...frame } }), /ChatGPT/)
  assert.equal(await handlers.get('codex:open-verification')(trusted, 'old'), false)
  assert.equal(opened.length, 0)
  assert.equal((await handlers.get('codex:start')(trusted)).userCode, 'DISPLAY')
  assert.equal(await handlers.get('codex:open-verification')(trusted, 'current', 'https://example.invalid'), true)
  assert.deepEqual(opened, [CODEX_VERIFICATION_URL, CODEX_VERIFICATION_URL])
  assert.deepEqual(await handlers.get('codex:list-models')(trusted), [{ id: 'current-ref', label: 'visible' }])
})

test('Express requires the launch token even with a local origin and Vite-style path', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-codex-desktop-'))
  process.env.NOVEL_DATA_DIR = dir
  process.env.NOVEL_ACCESS_TOKEN = token
  const { startServer, stopServer } = await import('../server/app.mjs')
  const port = await startServer(0)
  t.after(async () => {
    await stopServer()
    await fs.rm(dir, { recursive: true, force: true })
  })
  const url = 'http://127.0.0.1:' + port + '/api/models'
  assert.equal((await fetch(url, { headers: { Origin: 'http://localhost:5173' } })).status, 401)
  assert.equal((await fetch(url, { headers: { Origin: 'http://localhost:5173', 'x-novel-token': token } })).status, 200)
})
